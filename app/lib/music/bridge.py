#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MacKit · 音乐模块 · Python 桥接脚本
====================================

全项目**唯一** import `musicdl` 的文件。Node 侧通过一次性子进程调用它：
    <venv>/bin/python bridge.py <command>

协议（见 docs/design-music-module.md §3.2）：
    · stdin  : 一条 JSON 指令 {"command": "...", ...}
    · stdout : **只出 NDJSON**（每行一个 JSON 事件），供 Node 逐行解析
    · stderr : 其余一切（musicdl / rich 进度条 / 本脚本日志）

stdout 隔离手法（设计 §3.1 / §10 项 2）：进程启动**最先把 sys.stdout 指向 sys.stderr**，
并保留原始 stdout 句柄 `_REAL_STDOUT`；musicdl 依赖的 rich 在运行期通过 sys.stdout 动态
解析输出目标，因此重定向后其进度条一律落到 stderr —— Node 侧的 stdout 只剩本脚本的 NDJSON。
再由 `disable_print=True` 屏蔽 musicdl 自带的 print，双保险。

安全约束：全程不提权（不调用任何提权工具）、不写系统目录、不触碰系统 python3；所有写操作只落在调用方传入的目录
（由 Node 侧限定为 ~/.mackit/py 与下载目录）。

★ M-08（播放口径）：在线播放（`stream` 命令）**只用 musicdl 搜索阶段解析出的直链**，
  不做专用解密 / HLS 分片合并 / 媒体转码 —— 快照里 `protocol == 'HLS'` 的源一律拒绝播放
  （返回 CMD_FAILED），交由用户改选其它源或直接下载。
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sys
import threading
import time
import traceback
import urllib.request
import urllib.parse
import concurrent.futures as _cf

# ---------------------------------------------------------------------------
# 关键：在任何 import musicdl 之前隔离 stdout
# ---------------------------------------------------------------------------
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # 之后所有 print / rich 输出都进 stderr


_EMIT_LOCK = threading.RLock()


def emit(obj) -> None:
    """把一条事件以 NDJSON 写到真正的 stdout 并立即 flush。

    并发搜索时多个 daemon 线程会同时调用，加锁避免各行交错/断裂。
    """
    try:
        with _EMIT_LOCK:
            _REAL_STDOUT.write(json.dumps(obj, ensure_ascii=False) + "\n")
            _REAL_STDOUT.flush()
    except Exception:
        # 管道已被 Node 关闭等：放弃，不再制造新异常
        pass


def emit_error(code: str, message: str, detail: str = "") -> None:
    emit({"ev": "error", "code": code, "message": message, "detail": detail or ""})


def log_line(text: str) -> None:
    """调试日志一律走 stderr，绝不污染 stdout。"""
    try:
        sys.stderr.write(f"[bridge] {text}\n")
        sys.stderr.flush()
    except Exception:
        pass


# ---------------------------------------------------------------------------
# 错误类型（映射到 exec.ERR，见 ndjson.js）
# ---------------------------------------------------------------------------
class BridgeError(Exception):
    code = "CMD_FAILED"

    def __init__(self, message: str, detail: str = ""):
        super().__init__(message)
        self.message = message
        self.detail = detail


class EnvMissing(BridgeError):
    code = "ENV_MISSING"


class ParseFailedError(BridgeError):
    code = "PARSE_FAILED"


class NetUnreachable(BridgeError):
    code = "NET_UNREACHABLE"


class DownloadFailed(BridgeError):
    code = "DL_FAILED"


class NotFoundError(BridgeError):
    code = "NOT_FOUND"


# ---------------------------------------------------------------------------
# musicdl 懒加载（缺依赖时抛 ENV_MISSING，绝不 crash）
# ---------------------------------------------------------------------------
_MUSICDL = None


def load_musicdl():
    """延迟导入 musicdl；失败抛 EnvMissing，由 main() 归一为 error 事件。"""
    global _MUSICDL
    if _MUSICDL is not None:
        return _MUSICDL
    try:
        import musicdl as pkg  # noqa: F401  —— 读 __version__
        from musicdl.modules import MusicClientBuilder, SongInfo
        # ★ D1：SongInfoUtils 为**可选**依赖 —— 老版本 / 测试桩可能不导出；
        #   缺失时内嵌功能静默降级（返回全 False），绝不因此让整个模块 ENV_MISSING。
        try:
            from musicdl.modules import SongInfoUtils as _SongInfoUtils
        except Exception:
            _SongInfoUtils = None
        try:
            from musicdl.musicdl import MusicClient
        except Exception:
            from musicdl import MusicClient  # 兼容不同版本的导出位置
    except Exception as err:  # pragma: no cover - 依赖缺失路径
        raise EnvMissing(
            "未安装 musicdl（音频环境未就绪）",
            f"{err.__class__.__name__}: {err}",
        )
    _MUSICDL = {
        "pkg": pkg,
        "MusicClient": MusicClient,
        "MusicClientBuilder": MusicClientBuilder,
        "SongInfo": SongInfo,
        # D1：显式内嵌（歌词 / 基础标签 / 封面）复用同一实现；可能为 None（老版本 / 桩件）。
        "SongInfoUtils": _SongInfoUtils,
        "version": str(getattr(pkg, "__version__", "unknown")),
        "registered": list(MusicClientBuilder.REGISTERED_MODULES.keys()),
    }
    return _MUSICDL


# ---------------------------------------------------------------------------
# 通用工具
# ---------------------------------------------------------------------------
_ILLEGAL_FILENAME = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
_SUFFIX_RE = re.compile(r'^s_\d+_[0-9a-f]{6}$')
# 半成品 / 临时文件后缀（设计 §10 项 6：musicdl 与 N_m3u8DL-RE 主要在临时目录里倒腾，
# 这里做**兜底**清扫，防止异常中断后在下载目录留下残渣）。
_PARTIAL_SUFFIXES = (".part", ".tmp", ".download", ".mackitpart", ".crdownload")


def sanitize_filename(name: str, fallback: str = "未命名") -> str:
    """把任意字符串清洗为合法文件名（非法字符与首尾空白/点替换）。"""
    s = _ILLEGAL_FILENAME.sub("_", str(name or "")).strip().strip(".")
    s = re.sub(r"\s+", " ", s)
    return s or fallback


def safe_dir_name(name: str) -> str:
    """把 uid 之类的标识清洗为安全的目录名。"""
    return re.sub(r"[^A-Za-z0-9_.-]", "_", str(name or "x"))[:120] or "x"


def read_stdin_json() -> dict:
    raw = sys.stdin.read()
    if not raw or not raw.strip():
        raise ParseFailedError("空输入：未收到 JSON 指令")
    try:
        obj = json.loads(raw)
    except Exception as err:
        raise ParseFailedError("指令不是合法 JSON", str(err))
    if not isinstance(obj, dict) or not isinstance(obj.get("command"), str):
        raise ParseFailedError("指令格式非法：缺少 command 字段")
    return obj


def jsonable(value):
    """把任意对象转成可 JSON 往返的值（不可序列化者降级为 None）。"""
    try:
        return json.loads(json.dumps(value, default=lambda _o: None, ensure_ascii=False))
    except Exception:
        return None


def safe_todict(info) -> dict | None:
    """SongInfo.todict() 的「可 JSON 化」清洗；失败返回 None。"""
    try:
        return jsonable(info.todict())
    except Exception:
        return None


def normalize_proxies(proxies) -> dict | None:
    if not isinstance(proxies, dict):
        return None
    out = {}
    for k in ("http", "https"):
        v = proxies.get(k)
        if isinstance(v, str) and v:
            out[k] = v
    return out or None


def build_requests_overrides(sources, proxies):
    """给**门面** MusicClient 构造 requests_overrides（唯一允许出现「音源名层」的地方）。"""
    if not proxies:
        return {}
    return {s: {"proxies": proxies} for s in sources}


def per_source_overrides(proxies) -> dict:
    """
    ★ A-5（P0 铁律）：直调 **per-source** 客户端（`client.music_clients[src]`）时，
    `request_overrides` 必须是**扁平 kwargs 字典**（如 `{'proxies': {...}}`）。

    musicdl 2.13.11 里 58 个 `_search` 中 51 个会 `self.get(url, **request_overrides)`
    把它**展开**给请求层；请求层在**顶层** `kwargs.pop('proxies', None)`（base.py get/post）。
    因此：
      · 扁平 `{'proxies': {...}}` → 正确（等价于门面的 `requests_overrides[src]`）；
      · 多包一层 `{src: {'proxies': ...}}` → 展开成非法 kwarg（`qqmusic=...`）→ 被吞的 TypeError → 源全 fail；
      · **绝不**塞任何非请求层 kwarg 的键（51 源会展开，多余键即非法 kwarg）。
    """
    return {"proxies": proxies} if proxies else {}


def _int_or_none(value):
    """R3a：把缺失/0/非数一律归一为 None（**禁用 0 占位**，避免前端误显 `0k`）。"""
    try:
        n = int(value)
    except (TypeError, ValueError):
        return None
    return n if n > 0 else None


def _str_or_none(value):
    """R3a：把缺失/空串归一为 None（codec 等可读名）。"""
    if value is None:
        return None
    s = str(value).strip()
    return s or None


def now_ts() -> int:
    return int(time.time())


# ---------------------------------------------------------------------------
# 事件投影
# ---------------------------------------------------------------------------
def project_song(info, uid: str, parent_uid=None, kind: str = "track") -> dict:
    """把 SongInfo 投影为 §3.2 的 `song` 事件（轻量投影，不含 raw）。

    ★ R3a-1：`bitrate`/`codec`/`samplerate` 在信息不可得时一律 **None（JSON null）**，
    不再用 0 占位（v1 把缺失写成 0，会被前端误读为「0k」）。`filesize` 仍保留整数（0 = 未知）。
    """
    episodes = getattr(info, "episodes", None) or []
    # ★ A3：投影补齐在线播放所需的口径（三处投影必须一致：project_song / cmd_search_proxy / session.js）。
    #   · protocol : clean.protocol（缺省 'HTTP'）；'HLS' 源不支持在线播放（M-08）。
    #   · has_cover: 是否有可用封面（封面能否真正取回由 cover 路由二次判定）。
    #   · playable : 有有效直链 **且** 非 HLS 源，前端据此决定「播放」按钮可用性。
    #   ★ 硬约束：download_url / 直链**绝不**投影进 song 事件（绝不下发前端）。
    protocol = str(getattr(info, "protocol", None) or "HTTP")
    playable = has_valid_url(info) and protocol != "HLS"
    return {
        "ev": "song",
        "uid": uid,
        "parent_uid": parent_uid,
        "source": getattr(info, "source", None),
        "kind": kind,
        "songname": getattr(info, "song_name", None) or "",
        "singers": getattr(info, "singers", None) or "",
        "album": getattr(info, "album", None) or "",
        "duration": int(getattr(info, "duration_s", 0) or 0),
        "ext": str(getattr(info, "ext", "") or "").lstrip("."),
        "bitrate": _int_or_none(getattr(info, "bitrate", None)),
        "codec": _str_or_none(getattr(info, "codec", None)),
        "samplerate": _int_or_none(getattr(info, "samplerate", None)),
        "filesize": int(getattr(info, "file_size_bytes", 0) or 0),
        "has_episodes": bool(episodes),
        "children_count": len(episodes),
        "has_cover": bool(getattr(info, "cover_url", None)),
        "protocol": protocol,
        "playable": playable,
    }


def build_song_tree(info, source: str, index: int) -> tuple:
    """
    构建一个搜索条目对应的一组 song 事件与快照缓存项（含两级：专辑 → 子剧集）。

    返回 (events, entries, span)：
      · events ：待下发的 song 事件列表（专辑自身在前，子剧集随后）
      · entries：[(uid, cache_entry)]，与 events 的 uid 一一对应，供调用方**批量**并入快照
      · span   ：该条目占用的 uid 序号跨度（专辑自身 + 子项）

    ★ 只构建、不 emit、不写盘 —— 交由调用方按「先写快照、后 emit」的时序统一处理，
      以保证「任何已下发给前端的 song，其 uid 必定已在磁盘快照中」，
      从而修复搜索进行中点播 / 取封面 / 取歌词 404（快照缺失）的问题。
    """
    uid = f"{source}#{index}"
    episodes = getattr(info, "episodes", None) or []
    kind = "album" if episodes else "track"
    events = [project_song(info, uid, None, kind)]
    entries = [(uid, cache_entry(info, source))]

    child_index = 0
    for child in episodes:
        child_index += 1
        child_uid = f"{source}#{index}-{child_index}"
        events.append(project_song(child, child_uid, uid, "track"))
        entries.append((child_uid, cache_entry(child, source)))
    return events, entries, 1 + child_index


def cache_entry(info, source: str) -> dict:
    """缓存项：清洗后的原始 todict（可 fromdict 回灌）+ 匹配用元数据。"""
    return {
        "uid": None,  # 由调用方覆盖
        "source": source,
        "song_name": getattr(info, "song_name", None) or "",
        "singers": getattr(info, "singers", None) or "",
        "album": getattr(info, "album", None) or "",
        "ext": str(getattr(info, "ext", "") or "").lstrip("."),
        "clean": safe_todict(info),
    }


# 快照增量写入互斥锁：多音源 worker 会并发把各自的歌曲并入同一份快照。
# · write_cache 内部固定使用 `<cache_path>.tmp`，两线程同时写会互相踩；
# · json.dump 迭代 cache["songs"] 时若有别的线程插入键，会抛
#   "dictionary changed size during iteration"。
# 故「并入条目 + 落盘」必须在同一把锁内串行化。
# （read_cache 侧无需加锁：write_cache 是 tmp + os.replace 原子替换，读者始终看到完整文件。）
_cache_write_lock = threading.Lock()


def write_cache(cache_path: str, cache: dict) -> None:
    """把搜索快照落盘（原子写：先写 .tmp 再 rename）。"""
    if not cache_path:
        return
    try:
        os.makedirs(os.path.dirname(cache_path), exist_ok=True)
        tmp = f"{cache_path}.tmp"
        with open(tmp, "w", encoding="utf-8") as fp:
            json.dump(cache, fp, ensure_ascii=False)
        os.replace(tmp, cache_path)
    except Exception as err:  # 缓存写失败不致命（下载会退化为重搜匹配）
        log_line(f"写入搜索快照失败：{err}")


def write_cache_locked(cache_path: str, cache: dict, new_entries) -> None:
    """
    把一批新条目并入快照并**加锁原子落盘**（串行化多 worker 的并发增量写）。

    ★ 语义保证：本函数返回后，new_entries 中每个 uid 都可被 read_cache 查到。
      调用方必须在返回**之后**再 emit 相应的 song 事件 —— 从而把
      「前端可见某行」与「磁盘可解析该 uid」之间的窗口收敛到 0（修复搜索中点播 404）。
    """
    with _cache_write_lock:
        for uid, entry in new_entries:
            cache["songs"][uid] = entry
        write_cache(cache_path, cache)


def read_cache(cache_path: str) -> dict:
    if not cache_path or not os.path.exists(cache_path):
        return {"songs": {}}
    try:
        with open(cache_path, "r", encoding="utf-8") as fp:
            obj = json.load(fp)
        if isinstance(obj, dict) and isinstance(obj.get("songs"), dict):
            return obj
    except Exception as err:
        log_line(f"读取搜索快照失败：{err}")
    return {"songs": {}}


# ---------------------------------------------------------------------------
# 命令实现
# ---------------------------------------------------------------------------
# 单音源搜索墙钟超时（秒）。正常源几秒内返回；挂死的源在此超时后被跳过（计 fail），
# 循环继续后面的源 —— 避免「一个源挂住 → 前端 0/N 卡死到总超时」。
PER_SOURCE_SEARCH_TIMEOUT_S = 90


def make_client(music_sources, per_source=5, threads=8, proxies=None, init_overrides=None):
    m = load_musicdl()
    init_cfg = {}
    clients_threadings = {}
    overrides = build_requests_overrides(music_sources, proxies)
    for s in music_sources:
        cfg = {"search_size_per_source": int(per_source), "disable_print": True}
        if init_overrides and s in init_overrides:
            cfg.update(init_overrides[s])
        init_cfg[s] = cfg
        clients_threadings[s] = int(threads)
    return m["MusicClient"](
        music_sources=music_sources,
        init_music_clients_cfg=init_cfg,
        clients_threadings=clients_threadings,
        requests_overrides=overrides,
    )


def cmd_version(_payload: dict) -> None:
    m = load_musicdl()
    emit({
        "ev": "done", "command": "version", "version": m["version"],
        "count": 0, "ok": 0, "fail": 0, "skip": 0, "sources_ok": 0, "sources_fail": 0,
    })


def cmd_sources(_payload: dict) -> None:
    m = load_musicdl()
    keys = list(m["registered"])
    emit({
        "ev": "done", "command": "sources", "registered": keys,
        "count": len(keys), "ok": 0, "fail": 0, "skip": 0, "sources_ok": 0, "sources_fail": 0,
    })


# ---------------------------------------------------------------------------
# 增强搜索（实验）：musicsquare 式第三方代理 API
# ---------------------------------------------------------------------------
# 仅覆盖 4 个社区代理（与 musicsquare 同源）。默认关闭；开启后搜索走这些代理，
# 速度更快、对「歌手 - 歌名」组合更宽容。**强依赖外部服务**，随时可能限流 / 挂掉 / 改 ToS，
# 因此只在用户显式打开「增强搜索（实验）」开关时启用，默认仍走离线自包含的 musicdl。
PROXY_NETEASE = "https://api.qijieya.cn/meting/"
PROXY_QQ = "https://tang.api.s01s.cn/music_open_api.php"
PROXY_KUWO = "https://oiapi.net/api/Kuwo"
PROXY_JOOX = "https://apicx.asia/api/joox_music"
JOOX_TOKEN = "f84ao9lMF_q7husBWRfgUw"
JOOX_BR = 4
PROXY_SEARCH_TIMEOUT_S = 20
PROXY_DETAIL_TIMEOUT_S = 30
PROXY_DOWNLOAD_TIMEOUT_S = 120

# musicdl 音源名（含别名）→ 代理 key。注意顺序：先精确长串再短串，避免 'joox' 命中 'qq' 之类。
def _proxy_key_for(source: str):
    s = (source or "").lower()
    for key in ("netease", "joox", "kuwo", "qq"):
        if key in s:
            return key
    return None


def _qparam(url: str, key: str) -> str:
    """从 URL query 里抠某个参数值（Netease 的 songid 藏在 type=url 的 id 里）。"""
    if not url or "?" not in url:
        return ""
    try:
        return urllib.parse.parse_qs(url.split("?", 1)[1]).get(key, [""])[0]
    except Exception:
        return ""


def _to_sec(val) -> int:
    """'260' / '03:23' / None → 秒（int）。"""
    if val is None:
        return 0
    s = str(val).strip()
    if ":" in s:
        try:
            parts = [int(x) for x in s.split(":")]
        except ValueError:
            return 0
        if len(parts) >= 2:
            return parts[0] * 60 + parts[1]
        return 0
    try:
        return int(float(s))
    except (TypeError, ValueError):
        return 0


def _ext_from_url(url: str):
    """从音频直链路径里抠扩展名，白名单过滤；拿不到返回 None。"""
    if not url:
        return None
    try:
        path = urllib.parse.urlparse(url).path
    except Exception:
        return None
    m = re.search(r"\.([A-Za-z0-9]{2,4})(?:\?|$|$)", path)
    if not m:
        return None
    e = m.group(1).lower()
    return e if e in ("mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "ape", "alac", "mp4") else None


def _http_get(url: str, timeout: int, as_json: bool = True):
    """GET 一个代理接口，返回 dict（as_json）或 bytes（否则）；失败返回 None（不抛）。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MacKit)"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            data = r.read()
    except Exception as err:
        log_line(f"代理请求失败 {url[:80]}: {err}")
        return None
    if not as_json:
        return data
    try:
        return json.loads(data.decode("utf-8", "replace"))
    except Exception as err:
        log_line(f"代理响应非 JSON {url[:80]}: {err}")
        return None


def _http_stream(url: str, dest: str, timeout: int) -> None:
    """把代理音频直链流式落盘（不整段进内存，兼容大文件）。"""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (MacKit)"})
    with urllib.request.urlopen(req, timeout=timeout) as r, open(dest, "wb") as fp:
        while True:
            chunk = r.read(1 << 16)
            if not chunk:
                break
            fp.write(chunk)


def _fetch_text(url: str) -> str | None:
    data = _http_get(url, PROXY_DETAIL_TIMEOUT_S, as_json=False)
    if not data:
        return None
    try:
        return data.decode("utf-8", "replace")
    except Exception:
        return None


# ----- 搜索响应解析：每个函数返回统一结构 [{song_name, singers, album, ext, duration, songid, lyric_url?}] -----
def _parse_netease(items):
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        out.append({
            "song_name": it.get("name") or "",
            "singers": it.get("artist") or "",
            "album": "",
            "ext": "mp3",
            "duration": 0,
            "songid": _qparam(it.get("url") or "", "id"),
            "lyric_url": it.get("lrc") or None,
        })
    return out


def _parse_qq(items):
    out = []
    for it in items or []:
        if not isinstance(it, dict):
            continue
        mid = it.get("song_mid")
        if not mid:
            continue
        out.append({
            "song_name": it.get("song_title") or "",
            "singers": it.get("singer_name") or "",
            "album": "",
            "ext": "mp3",
            "duration": 0,
            "songid": mid,
        })
    return out


def _parse_kuwo(j):
    out = []
    data = (j or {}).get("data") if isinstance(j, dict) else None
    if not isinstance(data, list):
        return out
    for it in data:
        if not isinstance(it, dict):
            continue
        rid = it.get("rid")
        if not rid:
            continue
        types = it.get("types") or []
        fmt = "mp3"
        if types:
            best = max(types, key=lambda t: int(str(t.get("bitrate") or 0)))
            fmt = (best.get("format") or "mp3").lower() or "mp3"
        out.append({
            "song_name": it.get("song") or "",
            "singers": it.get("singer") or "",
            "album": it.get("album") or "",
            "ext": fmt,
            "duration": _to_sec(it.get("time")),
            "songid": str(rid),
        })
    return out


def _parse_joox(j):
    out = []
    if not isinstance(j, dict) or j.get("code") != 200:
        return out
    songs = (j.get("data") or {}).get("songs") or []
    for it in songs:
        if not isinstance(it, dict):
            continue
        out.append({
            "song_name": it.get("歌曲名称") or "",
            "singers": it.get("歌手") or "",
            "album": it.get("专辑") or "",
            "ext": "mp3",
            "duration": _to_sec(it.get("时长")),
            "songid": str(it.get("歌曲ID") or it.get("songmid") or ""),
        })
    return out


def _proxy_search_url(key: str, keyword: str, per_source: int) -> str | None:
    kw = urllib.parse.quote(keyword)
    if key == "netease":
        return f"{PROXY_NETEASE}?type=search&id={kw}&limit={per_source}&server=netease"
    if key == "qq":
        return f"{PROXY_QQ}?msg={kw}&type=json"
    if key == "kuwo":
        return f"{PROXY_KUWO}?msg={kw}&page=1&limit={per_source}"
    if key == "joox":
        return f"{PROXY_JOOX}?msg={kw}&token={JOOX_TOKEN}&br={JOOX_BR}"
    return None


def _resolve_proxy_audio(key: str, entry: dict):
    """返回 (audio_url, lyric_text|None)。audio_url 为可直连流地址（Netease 即 type=url 接口本身）。"""
    kw = urllib.parse.quote(entry.get("keyword") or "")
    songid = entry.get("songid") or ""
    if key == "netease":
        url = f"{PROXY_NETEASE}?server=netease&type=url&id={urllib.parse.quote(songid)}"
        return url, None
    if key == "qq":
        url = f"{PROXY_QQ}?msg={kw}&type=json&mid={urllib.parse.quote(songid)}"
        j = _http_get(url, PROXY_DETAIL_TIMEOUT_S, as_json=True)
        if not isinstance(j, dict):
            return None, None
        for f in ("song_play_url_sq", "song_play_url_pq", "song_play_url_accom",
                  "song_play_url_hq", "song_play_url_standard", "song_play_url_fq", "song_play_url"):
            if isinstance(j.get(f), str) and j[f].startswith("http"):
                return j[f], (j.get("song_lyric") or j.get("lyric"))
        # 兜底：任意含 play_url 的 http 字段
        for k, v in j.items():
            if "play_url" in k and isinstance(v, str) and v.startswith("http"):
                return v, (j.get("song_lyric") or j.get("lyric"))
        return None, None
    if key == "kuwo":
        url = f"{PROXY_KUWO}?msg={kw}&n={entry.get('index', 1)}&br=1"
        j = _http_get(url, PROXY_DETAIL_TIMEOUT_S, as_json=True)
        d = (j or {}).get("data") if isinstance(j, dict) else None
        if not isinstance(d, dict):
            return None, None
        u = d.get("url")
        if not (isinstance(u, str) and u.startswith("http")):
            m = re.search(r"https?://[^\s\"'）)]+", str(d.get("message") or ""))
            u = m.group(0) if m else None
        return u, (d.get("lyric") or d.get("lrc") or d.get("lyrics"))
    if key == "joox":
        url = f"{PROXY_JOOX}?msg={kw}&n={entry.get('index', 1)}&token={JOOX_TOKEN}&br={JOOX_BR}"
        j = _http_get(url, PROXY_DETAIL_TIMEOUT_S, as_json=True)
        if not isinstance(j, dict) or j.get("code") != 200:
            return None, None
        d = j.get("data") or {}
        links = d.get("播放链接") or {}
        for name in ("无损FLAC", "Hi-Res无损", "母带无损", "OGG 320", "MP3 320",
                     "AAC 192", "OGG 192", "MP3 128", "AAC 96", "AAC 48"):
            if isinstance(links.get(name), str) and links[name].startswith("http"):
                return links[name], d.get("歌词内容")
        for v in links.values():
            if isinstance(v, str) and v.startswith("http"):
                return v, d.get("歌词内容")
        return None, None
    return None, None


class _ProxyInfo:
    """给 render_template 用的轻量 info（只取命名模板所需属性）。"""

    def __init__(self, rec, ext):
        self.song_name = rec.get("song_name") or "未知曲目"
        self.singers = rec.get("singers") or "未知歌手"
        self.album = rec.get("album") or ""
        self.source = rec.get("source") or ""
        self.ext = ext


def cmd_search_proxy(payload: dict) -> None:
    """musicsquare 式代理搜索：逐源并发打第三方代理，归一为与 musicdl 同构的 song 事件与缓存。"""
    keyword = str(payload.get("keyword") or "").strip()
    if not keyword:
        raise ParseFailedError("搜索关键词为空")
    requested = [s for s in (payload.get("sources") or []) if isinstance(s, str) and s]
    per_source = int(payload.get("per_source") or 5)
    cache_path = payload.get("cache_path") or ""
    search_id = str(payload.get("search_id") or "")

    # 仅保留代理覆盖的源；其余标记不支持（emit source fail），不阻断已覆盖源
    mapped, unsupported = [], []
    for s in requested:
        k = _proxy_key_for(s)
        (mapped.append((s, k)) if k else unsupported.append(s))
    if not mapped:
        raise ParseFailedError("增强搜索仅支持 网易云 / QQ / 酷我 / JOOX 四个音源")

    total = len(mapped) + len(unsupported)
    emit({"ev": "start", "command": "search", "keyword": keyword,
          "sources_total": total, "started_at": now_ts()})

    cache = {"search_id": search_id, "keyword": keyword,
             "sources": [m[0] for m in mapped], "songs": {}}
    results: dict = {}

    def _run(src: str, key: str, idx: int) -> None:
        emit({"ev": "source_start", "source": src, "index": idx, "total": total})
        url = _proxy_search_url(key, keyword, per_source)
        j = _http_get(url, PROXY_SEARCH_TIMEOUT_S, as_json=True) if url else None
        if j is None:
            emit({"ev": "source", "source": src, "index": idx, "total": total,
                  "status": "fail", "count": 0, "error": "代理无响应（可能限流或网络不可达）"})
            results[src] = 0
            return
        try:
            if key == "netease":
                items = _parse_netease(j if isinstance(j, list) else [])
            elif key == "qq":
                items = _parse_qq(j if isinstance(j, list) else (j.get("data") if isinstance(j, dict) else []))
            elif key == "kuwo":
                items = _parse_kuwo(j)
            else:
                items = _parse_joox(j)
        except Exception as err:
            emit({"ev": "source", "source": src, "index": idx, "total": total,
                  "status": "fail", "count": 0, "error": f"代理响应解析失败：{err}"})
            results[src] = 0
            return
        items = items[:per_source] if per_source else items
        emit({"ev": "source", "source": src, "index": idx, "total": total,
              "status": "ok", "count": len(items), "error": None})

        # 搜索阶段即并发解析真实播放地址与格式：保证界面显示与实际下载一致（不再瞎猜 mp3/flac），
        # 同时把地址缓存下来，下载阶段直接复用、省掉一次详情调用。
        def _resolve_idx(it_idx):
            it, i = it_idx
            audio_url, lyric_inline = None, None
            try:
                audio_url, lyric_inline = _resolve_proxy_audio(key, {
                    "proxy_key": key, "keyword": keyword, "songid": it["songid"], "index": i,
                })
            except Exception as err:
                log_line(f"解析播放地址失败 {src}#{i}: {err}")
            return it, i, audio_url, lyric_inline

        resolved = []
        if items:
            with _cf.ThreadPoolExecutor(max_workers=min(8, len(items))) as ex:
                resolved = list(ex.map(_resolve_idx, [(it, i) for i, it in enumerate(items, start=1)]))

        # ★ 与 cmd_search 同款时序：先把本音源的条目并入 cache 并加锁落盘，再逐条 emit。
        #   保证「已下发 → 必可解析」，消除代理搜索进行中点播 / 封面 / 歌词 404。
        batch_entries, batch_events = [], []
        for it, i, audio_url, lyric_inline in resolved:
            uid = f"{src}#{i}"
            real_ext = _ext_from_url(audio_url) or it["ext"]
            batch_entries.append((uid, {
                "uid": uid, "source": src, "kind": "proxy", "proxy_key": key,
                "song_name": it["song_name"], "singers": it["singers"], "album": it["album"],
                "ext": real_ext, "songid": it["songid"], "keyword": keyword,
                "index": i, "lyric_url": it.get("lyric_url"),
                "audio_url": audio_url, "lyric_inline": lyric_inline,
            }))
            batch_events.append({
                "ev": "song", "uid": uid, "parent_uid": None, "source": src, "kind": "track",
                "songname": it["song_name"], "singers": it["singers"], "album": it["album"],
                "duration": int(it.get("duration") or 0), "ext": real_ext,
                "bitrate": None, "codec": None, "samplerate": None, "filesize": 0,
                "has_episodes": False, "children_count": 0,
                # ★ A3：代理结果无封面（webp / 无图），恒定 HTTP，playable 取决于是否解析到直链。
                "has_cover": False, "protocol": "HTTP", "playable": bool(audio_url),
            })
        write_cache_locked(cache_path, cache, batch_entries)
        for song_event in batch_events:
            emit(song_event)
        results[src] = len(items)

    worker_threads = [
        threading.Thread(target=_run, args=(src, key, i), daemon=True)
        for i, (src, key) in enumerate(mapped, start=1)
    ]
    for t in worker_threads:
        t.start()
    for t in worker_threads:
        t.join()

    for s in unsupported:
        emit({"ev": "source", "source": s, "index": 0, "total": total,
              "status": "fail", "count": 0, "error": "增强搜索暂不支持该音源"})

    sources_ok = sum(1 for v in results.values() if v > 0)
    sources_fail = sum(1 for v in results.values() if v == 0) + len(unsupported)
    total_songs = sum(results.values())
    write_cache(cache_path, cache)
    emit({
        "ev": "done", "command": "search", "search_id": search_id,
        "count": total_songs, "ok": 0, "fail": 0, "skip": 0,
        "sources_ok": sources_ok, "sources_fail": sources_fail,
    })


def download_proxy_one(uid: str, out_dir: str, template: str, cache: dict, save_lyrics: bool = True,
                       embedded_out: dict | None = None):
    """增强搜索结果的下载：解析真实地址 → 直连抓取音频 → 落到下载目录；可选旁写 .lrc。

    ★ D1：下载落盘后补齐「基础标签 + 歌词 + 封面」内嵌（复用 SongInfoUtils），best-effort；
       内嵌三态经 embedded_out（若提供）回传。
    """
    rec = (cache.get("songs") or {}).get(uid)
    if not isinstance(rec, dict) or rec.get("kind") != "proxy":
        raise NotFoundError("代理结果不在快照中", f"uid={uid}")
    key = rec.get("proxy_key")
    # 优先用搜索阶段缓存的地址；没有再临时解析
    audio_url = rec.get("audio_url") or None
    lyric_inline = rec.get("lyric_inline")
    if not audio_url:
        audio_url, lyric_inline = _resolve_proxy_audio(key, rec)
    if not audio_url:
        raise DownloadFailed(f"[{rec.get('source')}] 无法解析播放地址（代理可能限流或歌曲已下架）")

    ext = _ext_from_url(audio_url) or str(rec.get("ext") or "mp3").lstrip(".") or "mp3"
    stem = sanitize_filename(rec.get("song_name") or "未命名")
    tmp_dir = os.path.join(out_dir, ".mackit-tmp", safe_dir_name(uid))
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir, exist_ok=True)
    tmp_file = os.path.join(tmp_dir, f"{stem}.{ext}")
    try:
        try:
            _http_stream(audio_url, tmp_file, PROXY_DOWNLOAD_TIMEOUT_S)
        except Exception:
            # 地址可能过期 / 瞬时失败 → 重新解析一次再试（缓解偶发下载失败）
            audio_url2, lyric2 = _resolve_proxy_audio(key, rec)
            if audio_url2 and audio_url2 != audio_url:
                audio_url = audio_url2
                lyric_inline = lyric2 or lyric_inline
                ext = _ext_from_url(audio_url) or ext
                _http_stream(audio_url, tmp_file, PROXY_DOWNLOAD_TIMEOUT_S)
            else:
                raise
        if not os.path.getsize(tmp_file):
            raise DownloadFailed("代理返回空音频")
        final = unique_path(out_dir, render_template(template, _ProxyInfo(rec, ext), ext))
        shutil.move(tmp_file, final)
        # 歌词：内联优先，其次 Netease 的 lrc 接口
        lrc = lyric_inline
        if not lrc and rec.get("lyric_url"):
            lrc = _fetch_text(rec["lyric_url"])
        # ★ D1：代理结果补齐内嵌（基础标签 + 歌词 + 封面）——best-effort，封面 webp/m4a 失败属正常。
        embed_result = embed_tags_for_proxy(rec, final, ext, lrc)
        if embedded_out is not None:
            embedded_out.clear()
            embedded_out.update(embed_result)
        # ★ Bug2：内嵌（savelyricsthenwritetagstoaudio → savelrctofile）会在有歌词时**旁写 .lrc**，
        #   此处按 save_lyrics 决定去留，语义与 download_one 对齐（内嵌进音频标签的歌词不受开关影响）：
        #     save_lyrics=True  → 保留（必要时用内联歌词补写，overwrite=False 冲突时兜底）
        #     save_lyrics=False → 删除旁车 .lrc（musicdl 无法阻止旁写，只能事后清理）
        target = os.path.splitext(final)[0] + ".lrc"
        if save_lyrics:
            if lrc and not os.path.exists(target):
                try:
                    with open(target, "w", encoding="utf-8") as fp:
                        fp.write(lrc)
                except OSError as err:
                    log_line(f"写歌词失败：{err}")
        else:
            try:
                if os.path.exists(target):
                    os.remove(target)
            except OSError as err:
                log_line(f"删除歌词文件失败（保留）：{target}: {err}")
        lyrics_path = target if (save_lyrics and os.path.exists(target)) else None
        size = os.path.getsize(final)
        measured = measure_audio(final)
        return final, size, measured, bool(lyrics_path)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)
        cleanup_partials(out_dir)


def cmd_search(payload: dict) -> None:
    # 增强搜索（实验）：走 musicsquare 式第三方代理，速度更快、对组合词更宽容；默认关闭。
    if payload.get("enhanced"):
        cmd_search_proxy(payload)
        return
    m = load_musicdl()
    keyword = str(payload.get("keyword") or "").strip()
    if not keyword:
        raise ParseFailedError("搜索关键词为空")

    requested = [s for s in (payload.get("sources") or []) if isinstance(s, str) and s]
    registered = set(m["registered"])
    valid = [s for s in requested if s in registered]
    for bad in [s for s in requested if s not in registered]:
        log_line(f"忽略未登记音源：{bad}")  # 非法源名不崩溃，仅忽略并记 stderr
    if not valid:
        raise ParseFailedError(
            "所选音源均未登记",
            f"requested={requested}",
        )

    per_source = int(payload.get("per_source") or 5)
    threads = int(payload.get("threads") or 8)
    proxies = normalize_proxies(payload.get("proxies"))
    cache_path = payload.get("cache_path") or ""

    emit({
        "ev": "start", "command": "search", "keyword": keyword,
        "sources_total": len(valid), "started_at": now_ts(),
    })

    client = make_client(valid, per_source=per_source, threads=threads, proxies=proxies)
    search_id = str(payload.get("search_id") or "")
    cache = {"search_id": search_id, "keyword": keyword, "sources": valid, "songs": {}}

    sources_ok = 0
    sources_fail = 0
    total_songs = 0

    # ★ 并行多源搜索：每个源独立 daemon 线程同时开搜（墙钟 ≈ 最慢单源，而非各源耗时之和），
    #   与 musicdl 顶层 MusicClient.search 自带的 ThreadPoolExecutor 等价，但额外保留了
    #   「逐源 source_start / source / song 事件」与「单源 90s 超时跳过」能力。emit 已加锁，
    #   多线程并发写 stdout 不会交错；counts 由主线程在 join 后汇总，无竞态。
    results: dict = {}

    def _run_source(src: str, idx: int, total: int) -> None:
        emit({"ev": "source_start", "source": src, "index": idx, "total": total})
        box: list = []

        def _search_once():
            try:
                return client.music_clients[src].search(
                    keyword=keyword,
                    num_threadings=threads,
                    # ★ A-5：per-source 客户端必须收**扁平** request_overrides（{'proxies': …}），
                    #   不能是 {src: {...}}（后者会被 51 个源的 **request_overrides 展开成非法 kwarg）。
                    request_overrides=per_source_overrides(proxies),
                )
            except Exception as err:  # noqa: BLE001 —— 线程内异常带回来在主线程归类
                return err

        st = threading.Thread(target=lambda: box.append(_search_once()), daemon=True)
        st.start()
        st.join(PER_SOURCE_SEARCH_TIMEOUT_S)
        if st.is_alive():
            log_line(f"{src} 搜索超时（>{PER_SOURCE_SEARCH_TIMEOUT_S}s），跳过")
            emit({
                "ev": "source", "source": src, "index": idx, "total": total,
                "status": "timeout", "count": 0,
                "error": f"TimeoutError: 搜索超过 {PER_SOURCE_SEARCH_TIMEOUT_S}s 无响应，已跳过",
            })
            results[src] = 0
            return
        result = box[0] if box else []
        if isinstance(result, Exception):
            log_line(f"{src} 搜索失败：{result}")
            emit({
                "ev": "source", "source": src, "index": idx, "total": total,
                "status": "fail", "count": 0, "error": f"{result.__class__.__name__}: {result}",
            })
            results[src] = 0
            return
        infos = list(result or [])
        emit({
            "ev": "source", "source": src, "index": idx, "total": total,
            "status": "ok", "count": len(infos), "error": None,
        })
        # ★ 采用「先写快照、后 emit」时序：本音源的歌曲先一次性并入 cache 并加锁落盘，
        #   落盘返回后才逐条下发 song 事件。这样「前端可见的任意一行」其 uid 必已在文件中，
        #   搜索进行中也能点播 / 取封面 / 取歌词（不再 404「快照缺失」）。窗口 = 0。
        batch_events, batch_entries = [], []
        seq = 0
        for info in infos:
            seq += 1
            events, entries, _span = build_song_tree(info, src, seq)
            batch_events.extend(events)
            batch_entries.extend(entries)
        write_cache_locked(cache_path, cache, batch_entries)
        for song_event in batch_events:
            emit(song_event)
        results[src] = len(infos)

    # 注意：变量名必须避开外层的 `threads`（搜索线程数 int），否则会把它覆盖成线程列表，
    # 导致 num_threadings 收到 list → ThreadPoolExecutor(list <= 0) 崩溃。
    worker_threads = [
        threading.Thread(target=_run_source, args=(src, i, len(valid)), daemon=True)
        for i, src in enumerate(valid, start=1)
    ]
    for t in worker_threads:
        t.start()
    for t in worker_threads:
        t.join()

    sources_ok = sum(1 for v in results.values() if v > 0)
    sources_fail = sum(1 for v in results.values() if v == 0)
    total_songs = sum(results.values())

    write_cache(cache_path, cache)
    emit({
        "ev": "done", "command": "search", "search_id": search_id,
        "count": total_songs, "ok": 0, "fail": 0, "skip": 0,
        "sources_ok": sources_ok, "sources_fail": sources_fail,
    })


def render_template(template: str, info, ext: str) -> str:
    """按模板渲染文件名（变量非法字符已清洗；缺变量回退默认）。"""
    values = {
        "歌手": getattr(info, "singers", None) or "未知歌手",
        "歌名": getattr(info, "song_name", None) or "未知曲目",
        "专辑": getattr(info, "album", None) or "",
        "来源": str(getattr(info, "source", "") or "").replace("MusicClient", ""),
        "ext": ext,
    }
    name = str(template or "{歌手} - {歌名}.{ext}")
    for key, val in values.items():
        name = name.replace("{" + key + "}", str(val))
    name = sanitize_filename(name, fallback=sanitize_filename(values["歌名"]))
    if not name.lower().endswith("." + ext.lower()):
        name = f"{name}.{ext}"
    return name


def unique_path(directory: str, filename: str) -> str:
    """目录内重名时自动追加 (1)(2)…（设计 §9）。"""
    base, ext = os.path.splitext(filename)
    candidate = os.path.join(directory, filename)
    n = 1
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{base} ({n}){ext}")
        n += 1
    return candidate


def pick_produced_file(tmp_dir: str, ext: str) -> str | None:
    """在临时目录里挑出下载产物（优先匹配扩展名，否则取最大的普通文件）。"""
    best = None
    best_size = -1
    ext_norm = ("." + ext.lstrip(".")).lower() if ext else ""
    for root, _dirs, files in os.walk(tmp_dir):
        for fn in files:
            full = os.path.join(root, fn)
            if any(fn.lower().endswith(suf) for suf in _PARTIAL_SUFFIXES):
                continue
            try:
                size = os.path.getsize(full)
            except OSError:
                continue
            if ext_norm and fn.lower().endswith(ext_norm):
                return full
            if size > best_size:
                best, best_size = full, size
    return best


def cleanup_partials(directory: str) -> None:
    """兜底清扫下载目录顶层的半成品文件（设计 §10 项 6）。"""
    try:
        for name in os.listdir(directory):
            low = name.lower()
            if any(low.endswith(suf) for suf in _PARTIAL_SUFFIXES):
                try:
                    os.remove(os.path.join(directory, name))
                except OSError:
                    pass
    except OSError:
        pass
    leftover = os.path.join(directory, ".mackit-tmp")
    try:
        if os.path.isdir(leftover) and not os.listdir(leftover):
            os.rmdir(leftover)
    except OSError:
        pass


def rebuild_songinfo(clean: dict):
    """① 快路径：把清洗后的 todict 用 SongInfo.fromdict 回灌。"""
    if not isinstance(clean, dict):
        return None
    SongInfo = load_musicdl()["SongInfo"]
    try:
        return SongInfo.fromdict(clean)
    except Exception:
        return None


def has_valid_url(info) -> bool:
    try:
        return bool(info and info.with_valid_download_url)
    except Exception:
        return False


def reselect_songinfo(source: str, name: str, singers: str, threads: int, proxies):
    """② 兜底路径：按 (source, 歌名, 歌手) 复用该源重搜并匹配。"""
    keyword = " ".join([p for p in [str(name or "").strip(), str(singers or "").strip()] if p])
    if not keyword:
        return None
    client = make_client([source], threads=threads, proxies=proxies)
    try:
        results = list(client.music_clients[source].search(
            keyword=keyword, num_threadings=threads,
            # ★ A-5：同上——per-source 客户端必须收扁平 request_overrides
            request_overrides=per_source_overrides(proxies),
        ) or [])
    except Exception as err:
        log_line(f"重搜 {source} 失败：{err}")
        return None
    fallback = None
    for info in results:
        if not has_valid_url(info):
            continue
        if (getattr(info, "song_name", None) or "") == name:
            return info
        fallback = fallback or info
    return fallback


# ---------------------------------------------------------------------------
# D1 · 显式内嵌（歌词 / 基础标签 / 封面）—— 统一在「下载产物落盘后」补齐，best-effort
# ---------------------------------------------------------------------------
# 三态键与 musicdl SongInfoUtils.savelyricsthenwritetagstoaudio 的返回一致。
_EMBED_KEYS = ("lyrics_embedded", "basic_tags_embedded", "cover_embedded", "lrc_saved")


def _empty_embed_result() -> dict:
    return {k: False for k in _EMBED_KEYS}


def embed_tags_to_audio(info, audio_path: str, overwrite: bool = False) -> dict:
    """
    ★ D1（P0）：对**已落盘的音频文件**显式内嵌「歌词 + 基础标签 + 封面」。

    复用 musicdl 的 `SongInfoUtils.savelyricsthenwritetagstoaudio`（与正常下载同一实现）。
    **best-effort**：任何失败（musicdl 版本缺该工具 / 音频不可读 / 封面是 webp 等）都不抛错，
    只返回三态 dict（全 False = 未内嵌），**绝不影响下载成功判定**。
    """
    result = _empty_embed_result()
    try:
        utils = load_musicdl().get("SongInfoUtils")
    except Exception as err:
        log_line(f"内嵌跳过（musicdl 不可用）：{err}")
        return result
    if utils is None or info is None:
        return result
    # 让内嵌作用于**刚下载的临时文件**（save_path 决定 savelyricsthenwritetagstoaudio 的写入目标）。
    try:
        info._save_path = audio_path
    except Exception:
        pass
    try:
        res = utils.savelyricsthenwritetagstoaudio(info, overwrite=overwrite)
        if isinstance(res, dict):
            for k in _EMBED_KEYS:
                result[k] = bool(res.get(k))
    except Exception as err:
        log_line(f"显式内嵌失败（忽略）：{err}")
    return result


def embed_tags_for_proxy(rec: dict, audio_path: str, ext: str, lyric_text) -> dict:
    """
    ★ D1：代理结果（dict，非 SongInfo）补齐「基础标签 + 歌词 + 封面」内嵌。

    通过 `SongInfo.fromdict`（失败回落显式构造）得到等价 SongInfo，再复用
    {@link embed_tags_to_audio} 完成实际内嵌；best-effort。
    注意：封面为 webp 时 m4a 内嵌会失败，属正常，不计为错误。
    """
    try:
        SongInfoCls = load_musicdl().get("SongInfo")
    except Exception as err:
        log_line(f"代理内嵌跳过（musicdl 不可用）：{err}")
        return _empty_embed_result()
    if SongInfoCls is None:
        return _empty_embed_result()
    payload = {
        "song_name": rec.get("song_name"),
        "singers": rec.get("singers"),
        "album": rec.get("album"),
        "ext": ext,
        "lyric": lyric_text,
        "cover_url": rec.get("cover_url"),
        "source": rec.get("source"),
    }
    info = None
    try:
        info = SongInfoCls.fromdict(payload)
    except Exception:
        info = None
    if info is None:
        try:
            info = SongInfoCls(
                song_name=payload["song_name"], singers=payload["singers"],
                album=payload["album"], ext=ext, lyric=lyric_text,
                cover_url=payload["cover_url"], source=payload["source"],
            )
        except Exception as err:
            log_line(f"代理内嵌失败（忽略）：{err}")
            return _empty_embed_result()
    return embed_tags_to_audio(info, audio_path)


def _remove_backup_files(*candidates) -> None:
    """D1：清理显式内嵌在临时阶段可能留下的同名 `.bak` 残留（best-effort，静默）。"""
    for p in candidates:
        if not p:
            continue
        try:
            bak = f"{p}.bak"
            if os.path.exists(bak):
                os.remove(bak)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 在线播放（stream）/ 歌词（lyric）：只读快照，**不重搜、不解密、不转码**（M-08）
# ---------------------------------------------------------------------------
DEFAULT_STREAM_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

_LYRIC_EMPTY = {"", "NULL", "null", "None", "none"}


def _clean_lyric_text(value):
    """把缺失 / `NULL` / `null` / 空白一律归一为 None。"""
    if value is None:
        return None
    s = str(value)
    return None if s.strip() in _LYRIC_EMPTY else s


def _compose_stream_headers(clean: dict) -> dict:
    """由 musicdl 记录的 default_download_headers / cookies 合成可直连的请求头。"""
    headers: dict = {}
    raw = clean.get("default_download_headers")
    if isinstance(raw, dict):
        for k, v in raw.items():
            if isinstance(k, str) and v is not None:
                headers[k] = str(v)
    cookies = clean.get("default_download_cookies")
    if isinstance(cookies, dict) and cookies:
        pairs = [f"{k}={v}" for k, v in cookies.items() if v is not None]
        if pairs:
            headers["Cookie"] = "; ".join(pairs)
    # 默认 User-Agent（记录里已带 UA 则不覆盖）
    if not any(str(k).lower() == "user-agent" for k in headers):
        headers["User-Agent"] = DEFAULT_STREAM_USER_AGENT
    return headers


def resolve_stream_meta(rec: dict) -> dict:
    """
    由快照记录解析在线播放元信息（url / protocol / ext / headers / has_cover / cover_url / size）。

    失败抛 BridgeError（code=CMD_FAILED）；仅接受 http(s) 直链，HLS 源拒绝（M-08）。
    ★ 绝不接受任何外部入参 url —— 直链**只**来自快照 uid 的解析结果（SSRF 口径）。
    """
    if rec.get("kind") == "proxy":
        url = rec.get("audio_url") or None
        if not url:
            try:
                resolved, _lyric = _resolve_proxy_audio(rec.get("proxy_key"), rec)
                url = resolved
            except Exception as err:
                log_line(f"代理直链重解析失败：{err}")
        if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
            raise BridgeError("无可用在线播放直链（代理可能限流或歌曲已下架）", f"uid={rec.get('uid')}")
        return {
            "url": url,
            "protocol": "HTTP",
            "ext": str(rec.get("ext") or "").lstrip("."),
            "headers": {},
            "has_cover": False,
            "cover_url": None,
            "size": 0,
        }

    clean = rec.get("clean") if isinstance(rec.get("clean"), dict) else {}
    url = clean.get("download_url")
    protocol = str(clean.get("protocol") or "HTTP").upper()
    if not isinstance(url, str) or not url.lower().startswith(("http://", "https://")):
        raise BridgeError("无可用在线播放直链（快照链接已失效）", f"uid={rec.get('uid')}")
    if protocol == "HLS":
        raise BridgeError("HLS 源不支持在线播放")
    cover_url = clean.get("cover_url")
    cover_url = cover_url if isinstance(cover_url, str) and cover_url else None
    try:
        size = int(clean.get("file_size_bytes") or 0)
    except (TypeError, ValueError):
        size = 0
    return {
        "url": url,
        "protocol": protocol or "HTTP",
        "ext": str(rec.get("ext") or clean.get("ext") or "").lstrip("."),
        "headers": _compose_stream_headers(clean),
        "has_cover": bool(cover_url),
        "cover_url": cover_url,
        "size": size,
    }


def cmd_stream(payload: dict) -> None:
    """在线播放元信息：只读快照解析直链（http/Range），不重搜、不解密、不转码（M-08）。"""
    uid = str(payload.get("uid") or "")
    if not uid:
        raise ParseFailedError("缺少 uid")
    cache = read_cache(payload.get("cache_path") or "")
    rec = (cache.get("songs") or {}).get(uid)
    if not isinstance(rec, dict):
        raise NotFoundError("该曲目不在搜索结果里（快照缺失）", f"uid={uid}")
    meta = resolve_stream_meta(rec)
    emit({
        "ev": "done", "command": "stream", "uid": uid, "ok": True,
        "url": meta["url"], "ext": meta["ext"], "protocol": meta["protocol"],
        "headers": meta["headers"], "has_cover": meta["has_cover"],
        "cover_url": meta["cover_url"], "size": meta["size"],
    })


def cmd_lyric(payload: dict) -> None:
    """歌词：从快照取（musicdl → clean.lyric；代理 → rec.lyric_inline），不联网抓取。"""
    uid = str(payload.get("uid") or "")
    if not uid:
        raise ParseFailedError("缺少 uid")
    cache = read_cache(payload.get("cache_path") or "")
    rec = (cache.get("songs") or {}).get(uid)
    if not isinstance(rec, dict):
        raise NotFoundError("该曲目不在搜索结果里（快照缺失）", f"uid={uid}")
    if rec.get("kind") == "proxy":
        lrc = _clean_lyric_text(rec.get("lyric_inline"))
    else:
        clean = rec.get("clean") if isinstance(rec.get("clean"), dict) else {}
        lrc = _clean_lyric_text(clean.get("lyric"))
    emit({
        "ev": "done", "command": "lyric", "uid": uid,
        "has": bool(lrc), "source": "snapshot", "lrc": lrc,
    })


def move_sidecar_lrc(tmp_dir: str, final: str, produced: str) -> str | None:
    """
    R3b-1（P0）：把临时目录内 musicdl 写下的 `.lrc` 旁文件搬到与**最终音频同基名**。

    背景：`download_one()` 把产物隔离在 `<out_dir>/.mackit-tmp/<uid>/`，`pick_produced_file()`
    只挑音频、`shutil.move()` 挪走后，`finally: shutil.rmtree(tmp_dir)` 会把 musicdl 刚写下的
    `.lrc` 一并删掉。修法：音频搬走之后、`rmtree` 之前调用本函数。

    匹配口径：优先取与 `produced` 同 stem 的 `.lrc`，否则取第一个；目标为
    `os.path.splitext(final)[0] + '.lrc'`（**保证与最终音频同基名，含重名 `(1)` 时跟随**）。
    无 `.lrc` → 返回 None（静默跳过，**不算失败**，D4）。
    """
    lrcs = []
    for root, _dirs, files in os.walk(tmp_dir):
        for fn in files:
            if fn.lower().endswith(".lrc"):
                lrcs.append(os.path.join(root, fn))
    if not lrcs:
        return None
    produced_stem = os.path.splitext(os.path.basename(produced))[0].lower()
    pick = next((p for p in lrcs if os.path.splitext(os.path.basename(p))[0].lower() == produced_stem), None)
    if pick is None:
        pick = lrcs[0]
    target = os.path.splitext(final)[0] + ".lrc"
    try:
        os.replace(pick, target)  # 原子覆盖，保证基名与音频完全一致（D2）
        return target
    except OSError as err:
        log_line(f"搬运歌词失败：{err}")
        return None


def measure_audio(path: str) -> dict:
    """
    R3a-2：对**最终落盘文件**实测 codec / bitrate(kbps) / samplerate(Hz)，缺失一律 None。

    策略（A-2）：**tinytag 优先**（单位干净：kbps / Hz，且与上游
    `supplsonginfothensavelyricsthenwritetags` 同源），**mutagen 回退**（bitrate 是 bps，需 /1000）。
    两者都在 venv（随 musicdl 带入），**零新增依赖**；皆不可用则 codec 回落扩展名、其余 None。
    实测失败**绝不影响**下载成功判定（内部 try/except）。
    """
    result = {"codec": None, "bitrate": None, "samplerate": None}
    try:
        from tinytag import TinyTag
        tag = TinyTag.get(path)
        if tag is not None:
            if getattr(tag, "bitrate", None):
                result["bitrate"] = int(round(float(tag.bitrate)))          # tinytag 已是 kbps
            if getattr(tag, "samplerate", None):
                result["samplerate"] = int(tag.samplerate)
            codec = getattr(tag, "audio_type", None) or getattr(tag, "codec", None)
            if codec:
                result["codec"] = str(codec).upper()
        if any(v is not None for v in result.values()):
            if result["codec"] is None:
                result["codec"] = _codec_from_ext(path)
            return result
    except Exception as err:
        log_line(f"tinytag 实测失败，回退 mutagen：{err}")
    try:
        import mutagen
        f = mutagen.File(path)
        if f is not None:
            info = getattr(f, "info", None)
            if info is not None:
                br = getattr(info, "bitrate", None)     # bps
                sr = getattr(info, "sample_rate", None)  # Hz
                if br:
                    result["bitrate"] = int(round(float(br) / 1000.0))
                if sr:
                    result["samplerate"] = int(sr)
            result["codec"] = str(type(f).__name__).upper()
    except Exception as err:
        log_line(f"mutagen 实测失败：{err}")
    if result["codec"] is None:
        result["codec"] = _codec_from_ext(path)
    return result


def _codec_from_ext(path: str) -> str | None:
    """扩展名兜底作为可读编码名（mp3 → MP3）。"""
    ext = os.path.splitext(path)[1].lstrip(".").strip()
    return ext.upper() if ext else None


def download_one(uid: str, out_dir: str, template: str, threads: int, proxies, cache: dict, save_lyrics: bool = True,
                 embedded_out: dict | None = None):
    """
    下载单个 uid → 重命名为模板名 → 返回 (最终文件路径, 字节数, 实测声质 dict, 是否有歌词)。
    全过程隔离在 <out_dir>/.mackit-tmp/<uid>/ 里，无论成败都在 finally 里清理该目录，
    保证失败/取消后下载目录不留半成品（设计 §4.3）。★ R3b-1：清理前先把 `.lrc` 搬出。
    ★ D1：产物落盘（move 之前）显式补一次内嵌（歌词 / 基础标签 / 封面），best-effort；
       内嵌三态经 embedded_out（若提供）回传，绝不因内嵌失败影响下载成功判定。
    """
    rec = (cache.get("songs") or {}).get(uid)
    if not isinstance(rec, dict):
        raise NotFoundError("该曲目不在搜索结果里（快照缺失）", f"uid={uid}")

    source = rec.get("source") or (uid.split("#", 1)[0] if "#" in uid else "")
    if not source:
        raise NotFoundError("无法确定曲目来源", f"uid={uid}")

    tmp_dir = os.path.join(out_dir, ".mackit-tmp", safe_dir_name(uid))
    shutil.rmtree(tmp_dir, ignore_errors=True)
    os.makedirs(tmp_dir, exist_ok=True)

    produced = None
    final = None
    try:
        # ① 快路径：fromdict 回灌；失效则 ② 重搜匹配
        info = rebuild_songinfo(rec.get("clean"))
        if not has_valid_url(info):
            log_line(f"{uid} 快照链接不可用，重搜匹配：{rec.get('song_name')}")
            info = reselect_songinfo(source, rec.get("song_name"), rec.get("singers"), threads, proxies)
        if info is None or not has_valid_url(info):
            raise DownloadFailed("链接已失效且重搜未匹配到可用曲目")

        ext = str(getattr(info, "ext", "") or rec.get("ext") or "mp3").lstrip(".") or "mp3"
        stem = sanitize_filename(getattr(info, "song_name", None) or rec.get("song_name"), "未命名")
        # 把 product 落到临时目录，避免污染下载目录（save_path 由 musicdl 读取）
        try:
            info._save_path = os.path.join(tmp_dir, f"{stem}.{ext}")
        except Exception:
            pass
        info.work_dir = tmp_dir

        m = load_musicdl()
        overrides = {source: {"proxies": proxies}} if proxies else {}   # 门面形状（含音源名层）
        client = m["MusicClient"](
            music_sources=[source],
            clients_threadings={source: int(threads)},
            requests_overrides=overrides,
        )
        # ★ A-3 / Q3：优先直调 per-source 客户端并**显式** auto_supplement_song=True（不依赖上游默认值）。
        #   传给它的 request_overrides 必须是**扁平** overrides.get(source)（= {'proxies': …}）。
        #   回退 client.download([info]) 仅为兼容测试桩（其 music_clients[*] 无 download），保 109 基线不红。
        src_clients = getattr(client, "music_clients", None)
        src_client = src_clients.get(source) if isinstance(src_clients, dict) else None
        if src_client is not None and hasattr(src_client, "download"):
            src_client.download(
                [info],
                num_threadings=int(threads),
                request_overrides=overrides.get(source),   # ✅ 扁平
                auto_supplement_song=True,
            )
        else:
            client.download([info])

        produced = pick_produced_file(tmp_dir, ext)
        if not produced:
            raise DownloadFailed("musicdl 未产出文件（源可能限流或需要账号）")

        # ★ D1：在 shutil.move 之前，对**临时产物**显式补一次内嵌（歌词 / 基础标签 / 封面）。
        #   正常下载路径已由 auto_supplement_song 内嵌过，这里显式再调一次是**幂等兜底**
        #   （overwrite=False → 已有标签不覆盖），任何失败都不影响下载成功判定。
        embed_result = embed_tags_to_audio(info, produced, overwrite=False)
        if embedded_out is not None:
            embedded_out.clear()
            embedded_out.update(embed_result)

        final = unique_path(out_dir, render_template(template, info, ext))
        shutil.move(produced, final)
        # ★ R3b-1：音频搬走之后、finally: rmtree 之前，把 .lrc 搬到与最终音频同基名
        lyrics_path = move_sidecar_lrc(tmp_dir, final, produced)
        # 用户选择「不保存歌词」→ 删除旁车 .lrc（musicdl 无法阻止旁写，只能事后清理）
        if not save_lyrics and lyrics_path:
            try:
                os.remove(lyrics_path)
                lyrics_path = None
            except OSError as err:
                log_line(f"删除歌词文件失败（保留）：{lyrics_path}: {err}")
        size = os.path.getsize(final)
        # ★ R3a-2：对最终文件实测（失败不影响下载成功判定）
        measured = measure_audio(final)
        return final, size, measured, bool(lyrics_path)
    finally:
        # ★ D1：清理显式内嵌可能留下的同名 `.bak` 残留（临时目录随即整体删除，这里是兜底）。
        _remove_backup_files(produced, final)
        shutil.rmtree(tmp_dir, ignore_errors=True)
        cleanup_partials(out_dir)


def cmd_download(payload: dict) -> None:
    load_musicdl()  # 早失败：依赖缺失直接 ENV_MISSING
    uids = [u for u in (payload.get("uids") or []) if isinstance(u, str) and u]
    # 下载目录由 Node 侧统一提供（paths.MUSIC_DEFAULT_DIR 为唯一默认值来源），本脚本不自拼路径
    out_dir = payload.get("dir")
    if not out_dir:
        raise ParseFailedError("缺少下载目录 dir")
    template = payload.get("template") or "{歌手} - {歌名}.{ext}"
    threads = int(payload.get("threads") or 5)
    proxies = normalize_proxies(payload.get("proxies"))
    # 缺省 True：兼容老调用方（不传即保存歌词）
    save_lyrics = payload.get("save_lyrics") is not False
    cache = read_cache(payload.get("cache_path") or "")
    os.makedirs(out_dir, exist_ok=True)

    emit({
        "ev": "start", "command": "download",
        "sources_total": 0, "started_at": now_ts(), "count": len(uids),
    })

    ok = fail = skip = 0
    songs_cache = cache.get("songs") or {}
    for uid in uids:
        try:
            rec = songs_cache.get(uid)
            emb: dict = {}
            # ★ 增强搜索（实验）的代理结果走直连抓取；musicdl 结果走原路径
            if rec and rec.get("kind") == "proxy":
                final, size, measured, has_lyrics = download_proxy_one(
                    uid, out_dir, template, cache, save_lyrics=save_lyrics, embedded_out=emb)
            else:
                final, size, measured, has_lyrics = download_one(
                    uid, out_dir, template, threads, proxies, cache, save_lyrics=save_lyrics, embedded_out=emb)
            ok += 1
            emit({
                "ev": "result", "uid": uid, "status": "ok", "file": final, "bytes": int(size),
                "codec": measured.get("codec"), "bitrate": measured.get("bitrate"),
                "samplerate": measured.get("samplerate"), "lyrics": bool(has_lyrics), "error": None,
                # ★ D1：内嵌三态（lyrics/basic_tags/cover/lrc）——best-effort，未提供时为 None。
                "embedded": (emb or None),
            })
        except BridgeError as err:
            fail += 1
            emit({"ev": "result", "uid": uid, "status": "fail", "file": None, "bytes": 0,
                  "codec": None, "bitrate": None, "samplerate": None, "lyrics": False, "error": err.message})
        except Exception as err:  # 未知异常也归为单曲失败，不中断整批
            fail += 1
            log_line(f"{uid} 下载异常：{err}\n{traceback.format_exc()}")
            emit({"ev": "result", "uid": uid, "status": "fail", "file": None, "bytes": 0,
                  "codec": None, "bitrate": None, "samplerate": None, "lyrics": False,
                  "error": f"{err.__class__.__name__}: {err}"})

    emit({
        "ev": "done", "command": "download",
        "count": len(uids), "ok": ok, "fail": fail, "skip": skip,
        "sources_ok": 0, "sources_fail": 0,
    })


def cmd_playlist(payload: dict) -> None:
    m = load_musicdl()
    url = str(payload.get("url") or "").strip()
    if not url:
        raise ParseFailedError("歌单/专辑 URL 为空")
    sources = [s for s in (payload.get("sources") or []) if isinstance(s, str) and s in set(m["registered"])]
    if not sources:
        sources = list(m["registered"])  # 未指定则遍历全部源尝试解析
    proxies = normalize_proxies(payload.get("proxies"))
    cache_path = payload.get("cache_path") or ""

    emit({"ev": "start", "command": "playlist", "sources_total": len(sources), "started_at": now_ts()})
    client = make_client(sources, proxies=proxies)
    try:
        infos = list(client.parseplaylist(url) or [])
    except NetUnreachable:
        raise
    except Exception as err:
        raise ParseFailedError("歌单解析失败", f"{err.__class__.__name__}: {err}")

    cache = {"search_id": str(payload.get("search_id") or ""), "keyword": url, "sources": sources, "songs": {}}
    # ★ 先落盘、后 emit（与 cmd_search 同款语义）：歌单解析结果一次性返回，先整体并入快照再逐条下发，
    #   避免「歌单结果已显示但点播 / 封面 / 歌词 404（快照缺失）」的窗口。
    events_all, entries_all = [], []
    idx = 0
    for info in infos:
        idx += 1
        src = getattr(info, "source", None) or (sources[0] if sources else "unknown")
        events, entries, _span = build_song_tree(info, src, idx)
        events_all.extend(events)
        entries_all.extend(entries)
    write_cache_locked(cache_path, cache, entries_all)
    for song_event in events_all:
        emit(song_event)
    emit({
        "ev": "done", "command": "playlist", "search_id": str(payload.get("search_id") or ""),
        "count": len(infos), "ok": 0, "fail": 0, "skip": 0, "sources_ok": 1, "sources_fail": 0,
    })


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
_HANDLERS = {
    "version": cmd_version,
    "sources": cmd_sources,
    "search": cmd_search,
    "download": cmd_download,
    "playlist": cmd_playlist,
    # 在线播放（只读快照解析直链）与歌词（只读快照取词）
    "stream": cmd_stream,
    "lyric": cmd_lyric,
}


def main() -> int:
    try:
        req = read_stdin_json()
    except BridgeError as err:
        emit_error(err.code, err.message, err.detail)
        return 2
    except Exception as err:  # pragma: no cover
        emit_error("PARSE_FAILED", "指令解析失败", f"{err.__class__.__name__}: {err}")
        return 2

    command = req["command"]
    handler = _HANDLERS.get(command)
    if handler is None:
        emit_error("PARSE_FAILED", f"未知 command：{command}", "")
        return 2

    try:
        handler(req)
        return 0
    except BridgeError as err:
        emit_error(err.code, err.message, err.detail)
        return 1
    except KeyboardInterrupt:  # 被 Ctrl-C / 取消：Node 侧按取消处理
        emit_error("CANCELLED", "已取消", "")
        return 130
    except Exception as err:  # pragma: no cover
        emit_error("CMD_FAILED", "桥接脚本内部异常", f"{err}\n{traceback.format_exc()}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
