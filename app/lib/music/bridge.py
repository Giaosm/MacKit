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

# ---------------------------------------------------------------------------
# 关键：在任何 import musicdl 之前隔离 stdout
# ---------------------------------------------------------------------------
_REAL_STDOUT = sys.stdout
sys.stdout = sys.stderr  # 之后所有 print / rich 输出都进 stderr


def emit(obj) -> None:
    """把一条事件以 NDJSON 写到真正的 stdout 并立即 flush。"""
    try:
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
    }


def emit_song_tree(info, source: str, index: int, cache: dict) -> int:
    """
    发出一个搜索条目的 song 事件（含两级：专辑 → 子剧集）。
    返回该条目占用的 uid 序号跨度（专辑自身 + 子项）。
    """
    uid = f"{source}#{index}"
    episodes = getattr(info, "episodes", None) or []
    kind = "album" if episodes else "track"
    emit(project_song(info, uid, None, kind))
    cache["songs"][uid] = cache_entry(info, source)

    child_index = 0
    for child in episodes:
        child_index += 1
        child_uid = f"{source}#{index}-{child_index}"
        emit(project_song(child, child_uid, uid, "track"))
        cache["songs"][child_uid] = cache_entry(child, source)
    return 1 + child_index


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


def cmd_search(payload: dict) -> None:
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

    for i, src in enumerate(valid, start=1):
        # 进度事件：让前端知道「正在搜索哪个源」。串行循环里某源挂住时，
        # 没有这条事件前端只能停在 0/N 猜哑谜。
        emit({"ev": "source_start", "source": src, "index": i, "total": len(valid)})
        # ★ 单源超时（90s）：musicdl 的 search 内部 requests 无超时兜底，免费源接口
        #   偶发挂死会**阻塞整个串行循环**（其余源永远轮不到，前端 0/N 卡 10 分钟）。
        #   放进 daemon 线程 join 超时后：该源计 fail 并继续下一个源；遗留线程随进程
        #   退出回收（daemon），其结果被丢弃，无副作用。
        box: list = []

        def _search_once(src=src):
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

        th = threading.Thread(target=lambda: box.append(_search_once()), daemon=True)
        th.start()
        th.join(PER_SOURCE_SEARCH_TIMEOUT_S)
        if th.is_alive():
            sources_fail += 1
            log_line(f"{src} 搜索超时（>{PER_SOURCE_SEARCH_TIMEOUT_S}s），跳过")
            emit({
                "ev": "source", "source": src, "index": i, "total": len(valid),
                "status": "fail", "count": 0,
                "error": f"TimeoutError: 搜索超过 {PER_SOURCE_SEARCH_TIMEOUT_S}s 无响应，已跳过",
            })
            continue

        result = box[0] if box else []
        if isinstance(result, Exception):
            sources_fail += 1
            log_line(f"{src} 搜索失败：{result}")
            emit({
                "ev": "source", "source": src, "index": i, "total": len(valid),
                "status": "fail", "count": 0, "error": f"{result.__class__.__name__}: {result}",
            })
            continue

        infos = list(result or [])
        sources_ok += 1
        emit({
            "ev": "source", "source": src, "index": i, "total": len(valid),
            "status": "ok", "count": len(infos), "error": None,
        })
        idx = 0
        for info in infos:
            idx += 1
            span = emit_song_tree(info, src, idx, cache)
            idx += (span - 1)
            total_songs += span

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


def download_one(uid: str, out_dir: str, template: str, threads: int, proxies, cache: dict, save_lyrics: bool = True):
    """
    下载单个 uid → 重命名为模板名 → 返回 (最终文件路径, 字节数, 实测声质 dict, 是否有歌词)。
    全过程隔离在 <out_dir>/.mackit-tmp/<uid>/ 里，无论成败都在 finally 里清理该目录，
    保证失败/取消后下载目录不留半成品（设计 §4.3）。★ R3b-1：清理前先把 `.lrc` 搬出。
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
    for uid in uids:
        try:
            final, size, measured, has_lyrics = download_one(uid, out_dir, template, threads, proxies, cache, save_lyrics=save_lyrics)
            ok += 1
            emit({
                "ev": "result", "uid": uid, "status": "ok", "file": final, "bytes": int(size),
                "codec": measured.get("codec"), "bitrate": measured.get("bitrate"),
                "samplerate": measured.get("samplerate"), "lyrics": bool(has_lyrics), "error": None,
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
    idx = 0
    for info in infos:
        idx += 1
        src = getattr(info, "source", None) or (sources[0] if sources else "unknown")
        emit_song_tree(info, src, idx, cache)
    write_cache(cache_path, cache)
    emit({
        "ev": "done", "command": "playlist", "search_id": str(payload.get("search_id") or ""),
        "count": len(infos), "ok": 0, "fail": 0, "skip": 0, "sources_ok": 1, "sources_fail": 0,
    })


def cmd_preview(payload: dict) -> None:
    """试听（P1）：把曲目下到缓存目录（不落下载目录）。seconds 暂未做真正的片段截取。"""
    load_musicdl()
    uid = str(payload.get("uid") or "")
    if not uid:
        raise ParseFailedError("缺少 uid")
    cache = read_cache(payload.get("cache_path") or "")
    # 试听目录同样由 Node 侧提供（默认落在 ~/.mackit/cache/music/preview），本脚本不自拼路径
    preview_dir = payload.get("dir")
    if not preview_dir:
        raise ParseFailedError("缺少试听目录 dir")
    os.makedirs(preview_dir, exist_ok=True)
    emit({"ev": "start", "command": "preview", "sources_total": 0, "started_at": now_ts()})
    try:
        final, size, measured, has_lyrics = download_one(uid, preview_dir, "{歌名}.{ext}", 5, normalize_proxies(payload.get("proxies")), cache)
        emit({"ev": "result", "uid": uid, "status": "ok", "file": final, "bytes": int(size),
              "codec": measured.get("codec"), "bitrate": measured.get("bitrate"),
              "samplerate": measured.get("samplerate"), "lyrics": bool(has_lyrics), "error": None})
        emit({"ev": "done", "command": "preview", "count": 1, "ok": 1, "fail": 0, "skip": 0, "sources_ok": 0, "sources_fail": 0})
    except BridgeError as err:
        emit({"ev": "result", "uid": uid, "status": "fail", "file": None, "bytes": 0,
              "codec": None, "bitrate": None, "samplerate": None, "lyrics": False, "error": err.message})
        emit({"ev": "done", "command": "preview", "count": 1, "ok": 0, "fail": 1, "skip": 0, "sources_ok": 0, "sources_fail": 0})


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------
_HANDLERS = {
    "version": cmd_version,
    "sources": cmd_sources,
    "search": cmd_search,
    "download": cmd_download,
    "playlist": cmd_playlist,
    "preview": cmd_preview,
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
