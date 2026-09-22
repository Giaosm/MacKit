/**
 * MacKit · 音乐模块（第 8 模块）
 *
 * ModuleDefinition { id:'music', lane:'music', queries, actions }。它把纯 Python 桥接脚本
 * `lib/music/bridge.py` 收编进 MacKit 的查询 / 任务两层：
 *   · 部署状态（deployStatus）：四态（not_deployed / broken / deployed / outdated），只读；
 *   · 搜索：独立会话（lib/music/session.js）+ 轮询，**不进任务队列**（只读，避免阻塞 brew）；
 *   · 歌单解析（playlist）：同为独立会话，产出与搜索**同构**的 rows，用户勾选后走已有 download；
 *   · 选择目录（chooseFolder）：osascript 弹系统目录框（只读，不写配置），失败由前端回落手输；
 *   · 下载 / 安装：走 runner 的独立 lane（lane:'music'），与 default lane 的 7 个模块并行。
 *
 * ★ 启动纪律（P0-7）：本文件顶层**只** import Node 内建与本项目 lib，绝不在顶层探测或
 *   启动 Python。bridge.py 缺失、venv 缺失一律让查询返回 not_ready，绝不抛错影响服务启动。
 *
 * 契约与其它模块一致：一切子进程都经 ctx.exec（白名单 + 代理通道 + 取消信号 + lane 打标）。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';
import { resolvePolicyFrom } from './netpolicy.js';
import { countSteps } from './runner.js';
import * as env from './music/env.js';
import * as session from './music/session.js';
import * as catalog from './music/sources.js';
import { parseLine, toAppError } from './music/ndjson.js';

const { ERR, AppError } = exec;

// ------------------------------ 常量 ------------------------------
/** 搜索快照文件名前缀（`search-<searchId>.json`，见 §9） */
const CACHE_PREFIX = 'search-';
/** 「查询音源」结果缓存时长（避免每次开页面都起一次 python） */
const SOURCES_CACHE_TTL_MS = 10 * 60 * 1000;
/** 在线播放元信息缓存：key `${id}:${uid}`，TTL 10 分钟、LRU 上限 200（避免浏览器 seek 时每个 Range 都起一次 python）。 */
const STREAM_META_TTL_MS = 10 * 60 * 1000;
const STREAM_META_MAX = 200;
/** 音频缓存中 `.part` 崩溃孤儿的回收阈值：正常关闭会自删自己的 `.part`，残留超 24h 视为孤儿。 */
const PART_ORPHAN_TTL_MS = 24 * 60 * 60 * 1000;
/** 歌词时间轴正则（判定「同步歌词」）。 */
const SYNCED_LRC_RE = /\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]/;
/** stream / lyric 一次性子进程超时（只读快照解析，正常毫秒级返回）。 */
const MUSIC_META_TIMEOUT_MS = 20_000;
/** 下载安装类子进程超时 */
const DOWNLOAD_TIMEOUT_MS = 900_000;
const VENV_TIMEOUT_MS = 300_000;
const PIP_TIMEOUT_MS = 1_800_000;
/** 「选择目录」对话框：AppleScript 端 110s 超时 + Node 侧 120s 兜底 */
const CHOOSE_FOLDER_TIMEOUT_MS = 120_000;
/**
 * 长步骤「心跳」日志间隔（Enhancement D）。
 * pip 安装 300–500MB 依赖时输出按行到达（子进程 stdout 非 TTY，pip 关掉动态进度条），
 * 下载行之间可能有较长空档；15s 一条既能证明「没卡死」，又不会刷屏。
 */
const HEARTBEAT_MS = 15_000;

/**
 * 期望的 musicdl 版本（设计 §8 锁定 2.13.11）。
 * 已装版本 < 此值 → deployStatus.state = 'outdated'（提示「更新」）。
 * ★ 不联网比对 PyPI：这是本地可判定的下限，避免把「是否最新」这种需要联网的判断塞进只读查询。
 */
const MUSICDL_TARGET_VERSION = '2.13.11';

let sourcesCache = { at: 0, keys: null };

/**
 * 让「音乐环境」相关的全部缓存失效。
 *
 * ★ 2026-09-21 修：安装 / 升级 / 卸载 musicdl 之后各调用点只调了 `env.invalidate()`，
 *   而本文件的 `sourcesCache`（已登记音源键，TTL 缓存）不会跟着失效 —— 于是刚装好 musicdl
 *   的用户在界面上仍然看到「未登记任何音源」的旧列表，直到 TTL 到期。
 *   统一入口，避免以后新增缓存又漏掉一处。
 */
function invalidateMusicEnvCache() {
  sourcesCache = { at: 0, keys: null };
  streamMetaCache.clear();
  env.invalidate();
}
/** 在线播放元信息内存缓存（LRU + TTL），见 STREAM_META_* 常量。 */
const streamMetaCache = new Map();

/**
 * 命名模板两套预设（R2，design v2 §A.7）——**单一事实源**由后端下发，前端不硬编码。
 * 存储仍沿用 `musicNameTemplate`：预设即两个固定原文串。
 */
const TEMPLATE_PRESETS = Object.freeze([
  { id: 'singer-song', label: '歌手 - 歌名', value: '{歌手} - {歌名}.{ext}' },
  { id: 'song-singer', label: '歌名 - 歌手', value: '{歌名} - {歌手}.{ext}' },
]);

// ------------------------------ 小工具 ------------------------------
const tail = (text, n = 3) => paths.tailLines(text, n);

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  if (v < 1024 * 1024 * 1024) return `${(v / 1024 / 1024).toFixed(1)} MB`;
  return `${(v / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/** R3a-2：实测编码 → 大写可读名；缺失 `—`。 */
function fmtCodec(v) {
  const s = String(v == null ? '' : v).trim();
  return s ? s.toUpperCase() : '—';
}

/** R3a-2：实测码率（kbps）→ `1058 kbps`；缺失 `—`（**绝不用 0 占位**）。 */
function fmtMeasuredBitrate(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? `${n} kbps` : '—';
}

/** R3a-2：实测采样率（Hz）→ `44.1 kHz`；缺失 `—`。 */
function fmtSamplerate(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${(n / 1000).toFixed(1)} kHz`;
}

/** 秒 → `1m20s` / `45s`（心跳日志的「已用时」展示用）。 */
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m > 0 ? `${m}m${r}s` : `${r}s`;
}

/**
 * 长步骤「心跳」：周期性打一条带「已用时」的 info 日志（Enhancement D）。
 *
 * 经 ctx.log 发出 → 同时进入 SSE 实时流与落盘日志，用户在长静默期也有可感知的进展。
 *
 * ★ 返回的 stop() 必须在 finally 中调用：否则定时器泄漏（任务结束后仍在写日志）。
 *   setInterval 句柄 unref，避免拖住进程退出。
 * @param {{log:(level:string,text:string)=>void}} ctx
 * @param {string} label 步骤名（如「安装 musicdl 依赖」）
 * @param {number} [everyMs]
 * @returns {() => void} 停止心跳
 */
function startHeartbeat(ctx, label, everyMs = HEARTBEAT_MS) {
  const t0 = Date.now();
  const h = setInterval(() => {
    try { ctx.log('info', `⏳ ${label}… 已用时 ${fmtDuration((Date.now() - t0) / 1000)}`); }
    catch { /* 日志异常不影响步骤执行 */ }
  }, everyMs);
  if (h && typeof h.unref === 'function') h.unref();
  return () => clearInterval(h);
}

/** 目录是否可写（目录不存在时看其父目录）。 */
function dirWritable(dir) {
  if (!dir) return false;
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { /* 换父目录 */ }
  try { fs.accessSync(path.dirname(dir), fs.constants.W_OK); return true; } catch { return false; }
}

/** 搜索 id → 缓存文件绝对路径（id 已通过格式校验，杜绝目录穿越）。 */
function cachePathFor(searchId) {
  if (!session.SEARCH_ID_RE.test(String(searchId || ''))) {
    throw new AppError(ERR.PARSE_FAILED, '搜索 id 非法');
  }
  return path.join(paths.MUSIC_SEARCH_CACHE_DIR, `${CACHE_PREFIX}${searchId}.json`);
}

/**
 * 读取搜索快照里某 uid 的顶层记录（不深拷 clean）。
 * 仅用于派生音频缓存键；解析失败 / 不存在返回 null（绝不抛错）。
 * @param {string} searchId
 * @param {string} uid
 * @returns {object|null}
 */
function readSnapshotRec(searchId, uid) {
  try {
    const obj = JSON.parse(fs.readFileSync(cachePathFor(searchId), 'utf8'));
    const songs = obj && obj.songs;
    if (!songs || typeof songs !== 'object') return null;
    const rec = songs[uid];
    return rec && typeof rec === 'object' ? rec : null;
  } catch { return null; }
}

/**
 * 音频缓存键（纯函数）：由「来源 + 歌名 + 歌手 + 专辑 + 扩展名 + 文件大小」派生稳定键。
 *
 * `snd-<sha256(seed).slice(0,32)>.<ext>`，其中 seed 为上述字段以 `\u0000` 连接。
 * 键与内容一一对应（同一首歌不同码率/大小 → 不同键），供边听边存与二次播放命中。
 * @param {object|null} rec 快照记录（musicdl：顶层字段 + clean；proxy：顶层字段）
 * @returns {string}
 */
export function audioCacheKey(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const source = String(r.source || '');
  const song = String(r.song_name || '');
  const singers = String(r.singers || '');
  const album = String(r.album || '');
  // ★ ext 白名单（2026-09-21 修）：这个值会直接拼进缓存文件名 `snd-<digest>.<ext>`，
  //   再由 server.js `path.join` 成路径并参与 rmSync / renameSync。bridge.py 侧已收口，
  //   但纵深防御不能只靠上游 —— 一旦 ext 变成 `../../foo`，那就是「任意路径写 + 删」。
  //   只允许 [a-z0-9]{1,8}（含 dtshd / mpc2k 这类长扩展名），否则回落 'bin'。
  const ext = String(r.ext || '').replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8);
  // 文件大小：优先顶层（proxy 记录无 clean），回落到 clean.file_size_bytes（musicdl 记录），
  // 以尽量区分「不同码率/大小」的同名同扩展名曲目，降低缓存键碰撞概率。
  const size = r.filesize != null ? r.filesize
    : (r.file_size_bytes != null ? r.file_size_bytes
      : (r.clean && r.clean.file_size_bytes != null ? r.clean.file_size_bytes : 0));
  const seed = [source, song, singers, album, ext, size].join('\u0000');
  const digest = crypto.createHash('sha256').update(seed).digest('hex').slice(0, 32);
  return `snd-${digest}.${ext || 'bin'}`;
}

/**
 * 清理在线播放音频缓存（`~/.mackit/cache/music/audio`）。
 *
 * 走通用 {@link session.pruneDirByLru}：按 mtime 旧 → 新删至 `musicCacheMaxMb*1024*1024` 以内；
 * 跳过点文件；`.part` 不计入容量预算，但 mtime 超过 24h 的（正常关闭会自删自己的 `.part`，
 * 残留者多为崩溃孤儿）会被回收；全程静默（目录不存在 / 读取失败 / 删除失败都不打断调用方）。
 * @returns {{removed:number, bytes:number}}
 */
export function pruneAudioCache() {
  let maxBytes = 1024 * 1024 * 1024;
  try { maxBytes = (Number(store.readMackit().musicCacheMaxMb) || 1024) * 1024 * 1024; } catch { /* 回落 1GB */ }
  return session.pruneDirByLru(paths.MUSIC_AUDIO_CACHE_DIR, {
    accept: (name) => !name.endsWith('.part'),
    stalePartMs: PART_ORPHAN_TTL_MS,
    maxBytes,
  });
}

/**
 * 解析当前音乐网络通道 → **统一代理出口**（design v2 §A.1）。
 *
 * 通道档位（音乐页顶部下拉，存储键 musicChannel）：auto|proxy_first|direct_first。
 * **auto 视作直连**：musicdl 搜索是单个子进程，无法像 runPolicy 那样在进程内按主机分通道降级，
 * 而音乐的目标基本都是国内音源（自动档 = 直连正是它们的正确通道）；代理环境下手动选「优先代理」即可。
 *
 * ★ 返回三件套，覆盖「搜索 / 歌单 / 下载」三条 bridge 路径：
 *   · `channel`     —— 传给 exec.run 的**通道描述**（A-6：仍为 'proxy'，用环境变量代理服务
 *                      HLS 子下载器与 trust_env 裸 requests）；
 *   · `proxies`     —— 传给 bridge payload 的 requests 代理字典（**只含 http/https，永不含 socks**）；
 *   · `subprocEnv`  —— 传给 exec.run 的 `opts.env`，在 applyProxyEnv 之后覆盖：
 *                      · direct                     → `{ all_proxy: undefined }`（清掉宿主/遗留 socks）
 *                      · proxy & homebrew           → `{ all_proxy: undefined }`（保留 brewgo 的 http/https）
 *                      · proxy & custom & 有 http   → 覆盖 http_proxy/https_proxy 为自定义 http://host:port，摘 all_proxy
 *                      · proxy & custom & 无 http   → 显式删除 http_proxy/https_proxy/all_proxy（仅 socks5 → musicdl 走直连）
 *
 * ★ 代理地址取自 store.normalizeProxyAddr（唯一校验出口），本函数**绝不自拼/自校验**代理串。
 * @returns {{channel:'direct'|'proxy', proxies:{http:string,https:string}|null, subprocEnv:object}}
 */
export function resolveProxy() {
  let c;
  try { c = store.readMackit(); } catch { c = { musicChannel: 'auto', musicProxySource: 'homebrew', musicProxyHttp: '', musicProxySocks5: '' }; }
  // auto（多目标子进程）→ 直连优先；用户选「优先代理」才走代理
  const channel = resolvePolicyFrom(c, 'music', 'direct_first') === 'proxy_first' ? 'proxy' : 'direct';
  if (channel !== 'proxy') {
    return { channel: 'direct', proxies: null, subprocEnv: { all_proxy: undefined } };
  }
  const source = c.musicProxySource === 'custom' ? 'custom' : 'homebrew';
  if (source === 'homebrew') {
    let httpPort = 7897;
    try { httpPort = store.readBrewgo().httpPort; } catch { /* 回落默认端口 */ }
    const url = `http://${paths.PROXY_HOST}:${httpPort}`;
    return { channel: 'proxy', proxies: { http: url, https: url }, subprocEnv: { all_proxy: undefined } };
  }
  // 自定义：只收 host:port（不带 scheme），经 store 归一后拼 `http://…`
  const http = store.normalizeProxyAddr(c.musicProxyHttp);
  if (http) {
    const url = `http://${http}`;
    return {
      channel: 'proxy',
      proxies: { http: url, https: url },
      subprocEnv: { http_proxy: url, https_proxy: url, all_proxy: undefined },
    };
  }
  // 自定义但未填 HTTP（可能只填了 SOCKS5 或全空）：musicdl 走直连（Q2——requests 无 PySocks，不吃 socks）
  return {
    channel: 'proxy',
    proxies: null,
    subprocEnv: { http_proxy: undefined, https_proxy: undefined, all_proxy: undefined },
  };
}

/**
 * 解析「装依赖」子进程的代理环境（design v2 §A.1 / Q2）。
 *
 * ★ 与 resolveProxy() 分开：pip 子进程是**独立出口**，且是**全项目唯一允许出现 `socks5://` 的地方**
 *   （musicdl 的 requests 无 PySocks，绝不吃 socks5）。
 *
 * 三键均显式给出（无则 `undefined` → exec 侧删除），确保在 `channel:'proxy'` 的 applyProxyEnv
 * 之后**确定性覆盖**：homebrew 三键齐全；custom 只填 HTTP 时 all_proxy 被清；只填 SOCKS5 时
 * http/https 被清（**不会**漏出 brewgo 的 http 代理）。
 * @returns {{channel:'direct'|'proxy', env:{http_proxy?:string,https_proxy?:string,all_proxy?:string}}}
 */
export function resolveInstallProxyEnv() {
  let c;
  try { c = store.readMackit(); } catch { c = { musicChannel: 'auto', musicProxySource: 'homebrew', musicProxyHttp: '', musicProxySocks5: '' }; }
  if (resolvePolicyFrom(c, 'music', 'direct_first') !== 'proxy_first') return { channel: 'direct', env: {} };

  const source = c.musicProxySource === 'custom' ? 'custom' : 'homebrew';
  let http = null;
  let socks5 = null;
  if (source === 'homebrew') {
    let b = { httpPort: 7897, socksPort: 7897 };
    try { b = store.readBrewgo(); } catch { /* 回落默认端口 */ }
    http = `${paths.PROXY_HOST}:${b.httpPort}`;
    socks5 = `${paths.PROXY_HOST}:${b.socksPort}`;
  } else {
    http = store.normalizeProxyAddr(c.musicProxyHttp) || null;
    socks5 = store.normalizeProxyAddr(c.musicProxySocks5) || null;
  }
  return {
    channel: 'proxy',
    env: {
      http_proxy: http ? `http://${http}` : undefined,
      https_proxy: http ? `http://${http}` : undefined,
      all_proxy: socks5 ? `socks5://${socks5}` : undefined,
    },
  };
}

/** 取下载目标目录与命名模板（参数优先，回落配置，再回落默认）。 */
function resolveTargets(params) {
  const c = store.readMackit();
  const dir = String(params.dir || c.musicDownloadDir || paths.MUSIC_DEFAULT_DIR);
  const template = String(params.template || c.musicNameTemplate || '{歌手} - {歌名}.{ext}');
  const saveLyrics = params.saveLyrics === undefined ? c.musicSaveLyrics !== false : params.saveLyrics === true;
  return { dir, template, saveLyrics };
}

/** 步骤内统一的环境就绪校验（steps() 是同步的，只能在 run 里 async 校验）。 */
async function requireReady() {
  const st = await env.detect();
  if (st.status !== 'ready') {
    throw new AppError(ERR.ENV_MISSING, '音频环境未就绪，请先点击「安装音频环境」', `status=${st.status}`);
  }
  return st;
}

/** 构造一个「参数错误」步骤（steps() 同步阶段发现的非法入参，延迟到运行时抛错）。 */
function badStep(message) {
  return {
    id: 'invalid',
    title: '参数错误',
    run: () => { throw new AppError(ERR.PARSE_FAILED, message); },
  };
}

// ------------------------------ 查询 ------------------------------
/** 解析 `MAJOR.MINOR.PATCH`；失败返回 null。 */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** 比较两个版本号：a<b → -1、a=b → 0、a>b → 1；任一不可解析按相等处理。 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/**
 * 部署状态（模块页据此决定「只渲染部署区」还是「渲染完整五分区」；force=1 绕过 60s 缓存）。
 *
 * ★ 四态映射（由 env.detect() 的三态派生，包装而非改写 env.js）：
 *   · not_deployed : venv 不存在（还没装）
 *   · broken       : venv 存在但 import musicdl 失败（损坏，需「修复」= 重建）
 *   · outdated     : 已装但版本低于 MUSICDL_TARGET_VERSION（提示「更新」）
 *   · deployed     : venv 存在 + musicdl 可导入 + 版本达标
 * 兼容字段 `status`（'ready'|'not_ready'|'broken'）供旧调用方读取，`usable` 为四态下的可用性口径。
 *
 * @param {{force?:boolean}} params
 * @returns {Promise<object>}
 */
async function queryDeployStatus(params = {}) {
  const st = await env.detect({ force: params.force === true });

  let state;
  if (!st.venv.exists) state = 'not_deployed';
  else if (!st.musicdl.installed) state = 'broken';
  else if (compareVersions(st.musicdl.version, MUSICDL_TARGET_VERSION) < 0) state = 'outdated';
  else state = 'deployed';

  const usable = state === 'deployed' || state === 'outdated';
  const status = usable ? 'ready' : (state === 'broken' ? 'broken' : 'not_ready');

  return {
    state,
    usable,
    status, // 兼容旧三态
    targetVersion: MUSICDL_TARGET_VERSION,
    python: st.python,
    venv: st.venv,
    musicdl: st.musicdl,
    bridge: st.bridge,
    disk: st.disk,
    // musicdl 上游版本摘要：**只读** 24h 磁盘缓存，绝不在此发网络请求（不能拖慢挂载轮询）；
    // 前端挂载后再调 /api/music/musicdlUpstream 非阻塞刷新。无缓存 → null。
    musicdlUpstream: cachedUpstreamSummary(st.musicdl.installed ? st.musicdl.version : null),
  };
}

// ------------------------------ musicdl 上游版本（PyPI，纯提示） ------------------------------

/** 上游版本缓存键（store.getCached/setCached 磁盘缓存；导出供单测）。 */
export const MUSICDL_UPSTREAM_CACHE_KEY = 'music-musicdl-upstream';
/** 上游版本缓存 TTL：24h（上游发布频率低，一天一查足够）。 */
const MUSICDL_UPSTREAM_TTL_MS = 24 * 60 * 60 * 1000;
/** PyPI JSON API（只取 `info.version`）。 */
const MUSICDL_PYPI_URL = 'https://pypi.org/pypi/musicdl/json';

/**
 * 比较上游版本与**已装版本**：'newer' | 'equal' | 'older'；任一缺失 → null（无从比较）。
 * 纯函数（导出供单测）。复用既有 compareVersions（不可解析的版本按相等处理）。
 * @param {string|null} upstream PyPI 上的版本
 * @param {string|null} installed venv 内已装版本
 * @returns {'newer'|'equal'|'older'|null}
 */
export function compareUpstreamVersion(upstream, installed) {
  if (!upstream || !installed) return null;
  const c = compareVersions(upstream, installed);
  if (c > 0) return 'newer';
  if (c < 0) return 'older';
  return 'equal';
}

/**
 * 解析 PyPI `/pypi/<pkg>/json` 响应文本，取 `info.version`。
 * 纯函数（导出供单测）：非法 JSON / 缺 `info` / 缺版本 / 版本号形状不对 → ok:false。
 * @param {string} text 响应全文
 * @returns {{ok:true, version:string}|{ok:false, error:string}}
 */
export function parsePypiVersion(text) {
  let obj;
  try { obj = JSON.parse(String(text || '')); } catch { return { ok: false, error: 'PyPI 响应不是合法 JSON' }; }
  const v = String((obj && obj.info && obj.info.version) || '').trim();
  if (!v) return { ok: false, error: 'PyPI 响应缺少 info.version' };
  if (!/^\d+(\.\d+)*$/.test(v)) return { ok: false, error: `PyPI 版本号格式异常：${v.slice(0, 40)}` };
  return { ok: true, version: v };
}

/** 读 24h 内的上游版本缓存摘要（不发网络请求；无缓存 / 已过期 → null）。 */
function cachedUpstreamSummary(installedVersion) {
  try {
    const cached = store.getCached(MUSICDL_UPSTREAM_CACHE_KEY);
    if (!cached || !cached.value || !cached.value.version) return null;
    if (Date.now() - cached.at >= MUSICDL_UPSTREAM_TTL_MS) return null;
    return {
      fetchOk: true,
      version: cached.value.version,
      checkedAt: cached.at,
      installed: !!installedVersion,
      installedVersion: installedVersion || null,
      target: MUSICDL_TARGET_VERSION,
      comparison: compareUpstreamVersion(cached.value.version, installedVersion),
    };
  } catch { return null; }
}

/**
 * 查询 PyPI 上游 musicdl 版本（**纯提示功能：绝不向调用方抛网络错误**）。
 *
 * 网络范式抄 brew.js:downloadIndex —— `curl -o 临时文件` 落盘再读（exec 层 stdout 捕获上限
 * 4MB，PyPI musicdl JSON 含全部历史版本，走 stdout 有截断风险），finally 删临时文件。
 * 24h 磁盘缓存；`force=true` 绕过。
 *
 * ★ 依赖注入（deps）：`runWithChannel` / `detect` 可被单测替换成桩件，避免单测真发网络。
 * @param {{force?:boolean}} [params]
 * @param {{runWithChannel?:Function, detect?:Function}} [deps]
 * @returns {Promise<{fetchOk:boolean, version:string|null, checkedAt:number|null,
 *                     installed:boolean, installedVersion:string|null, target:string,
 *                     comparison:'newer'|'equal'|'older'|null, error?:string}>}
 */
export async function queryMusicdlUpstream(params = {}, deps = {}) {
  const runWithChannel = deps.runWithChannel || exec.runWithChannel;
  const detect = deps.detect || env.detect;
  const st = await detect();
  const installedVersion = (st.musicdl && st.musicdl.installed && st.musicdl.version) || null;
  const base = { installed: installedVersion != null, installedVersion, target: MUSICDL_TARGET_VERSION };

  // ① 24h 缓存命中：不发请求
  if (params.force !== true) {
    try {
      const cached = store.getCached(MUSICDL_UPSTREAM_CACHE_KEY);
      if (cached && cached.value && cached.value.version && Date.now() - cached.at < MUSICDL_UPSTREAM_TTL_MS) {
        return { fetchOk: true, version: cached.value.version, checkedAt: cached.at, ...base, comparison: compareUpstreamVersion(cached.value.version, installedVersion) };
      }
    } catch { /* 缓存读取失败：当无缓存 */ }
  }

  // ② curl 落盘 → 解析（网络范式同 downloadIndex）
  // ★ 文件名必须带随机段：只用 pid 的话，同一进程内两次并发调用（例如界面点「检查更新」的同时
  //   配置页触发一次）会写同一个文件 —— 一个已经 rmSync 掉，另一个读不到 → 误报解析失败（2026-09-21 修）。
  const tmpFile = path.join(paths.CACHE_DIR, `musicdl-upstream-${process.pid}-${crypto.randomBytes(4).toString('hex')}.json`);
  try {
    await runWithChannel('direct_first', '查询 musicdl 上游版本', 'curl',
      ['-fsSL', '--compressed', '--max-time', '20', '-o', tmpFile, MUSICDL_PYPI_URL],
      { timeoutMs: 25_000, noMirror: true });
    const parsed = parsePypiVersion(fs.readFileSync(tmpFile, 'utf8'));
    if (!parsed.ok) return { fetchOk: false, version: null, checkedAt: null, ...base, comparison: null, error: parsed.error };
    try { store.setCached(MUSICDL_UPSTREAM_CACHE_KEY, { version: parsed.version }); } catch { /* 缓存写失败不影响本次 */ }
    return { fetchOk: true, version: parsed.version, checkedAt: Date.now(), ...base, comparison: compareUpstreamVersion(parsed.version, installedVersion) };
  } catch (err) {
    // 取消 / 超时照常上抛（任务取消必须能中断）；其余网络错误归一为 fetchOk:false（纯提示，不抛）
    if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    return { fetchOk: false, version: null, checkedAt: null, ...base, comparison: null, error: (err && err.message) || '查询 PyPI 失败' };
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}

/**
 * 运行时的已登记音源键列表（带缓存；musicdl 未装则返回 null）。
 * @returns {Promise<string[]|null>}
 */
async function registeredSources() {
  if (sourcesCache.keys && Date.now() - sourcesCache.at < SOURCES_CACHE_TTL_MS) return sourcesCache.keys;
  const st = await env.detect();
  if (!st.musicdl.installed) return null;
  try {
    const res = await exec.runSafe(paths.MUSIC_VENV_PY, [paths.MUSIC_BRIDGE, 'sources'], {
      noMirror: true, timeoutMs: 20_000,
    });
    if (res.code === 0) {
      for (const line of paths.lines(res.stdout)) {
        const ev = parseLine(line);
        if (ev && ev.ev === 'done' && Array.isArray(ev.registered)) {
          sourcesCache = { at: Date.now(), keys: ev.registered };
          return ev.registered;
        }
      }
    }
  } catch { /* 探测失败：回落静态目录 */ }
  return null;
}

/** 音源目录（静态 6 分组 + 与运行时 REGISTERED_MODULES 合并）。 */
async function querySources() {
  const registered = await registeredSources();
  return catalog.merge(registered);
}

/** 下载目录 / 命名模板 / 通道 / 已选音源 / 代理配置（v2 新增 proxy* + templatePresets）。 */
function queryConfig() {
  const c = store.readMackit();
  // proxyHomebrew：实时读 ~/.brewgo_config（只读回显）；读取失败回落 7897（A9 不报错、不阻断）
  let proxyHomebrew = { http: `${paths.PROXY_HOST}:7897`, socks5: `${paths.PROXY_HOST}:7897` };
  try {
    const b = store.readBrewgo();
    proxyHomebrew = { http: `${paths.PROXY_HOST}:${b.httpPort}`, socks5: `${paths.PROXY_HOST}:${b.socksPort}` };
  } catch { /* 回落默认端口 */ }
  return {
    downloadDir: c.musicDownloadDir,
    nameTemplate: c.musicNameTemplate,
    channel: c.musicChannel,
    sources: c.musicSources,
    saveLyrics: c.musicSaveLyrics !== false,
    // 在线播放 / 边听边存：音频缓存容量上限（MB）与下载并发度（B1/B2 回显）
    cacheMaxMb: c.musicCacheMaxMb,
    downloadConcurrency: c.musicDownloadConcurrency,
    // 增强搜索（实验）：true 时搜索走第三方代理 API；前端据此渲染开关与状态提示
    enhancedSearch: c.musicEnhancedSearch === true,
    templateVars: ['{歌手}', '{歌名}', '{专辑}', '{来源}', '{ext}'],
    // R0：代理配置回显（原样，供 UI 三选一/输入框回填）
    proxySource: c.musicProxySource,
    proxyHttp: c.musicProxyHttp,
    proxySocks5: c.musicProxySocks5,
    proxyHomebrew,
    // R2：模板预设（单一事实源，前端只回显不硬编码）
    templatePresets: TEMPLATE_PRESETS.map((p) => ({ ...p })),
    dirWritable: dirWritable(c.musicDownloadDir),
  };
}

/**
 * 发起搜索（立即返回，后台跑桥接子进程）。
 * @param {{keyword?:string, sources?:string[], perSource?:number, threads?:number}} params
 */
async function querySearch(params = {}) {
  const keyword = String(params.keyword || '').trim();
  if (!keyword) throw new AppError(ERR.PARSE_FAILED, '请输入搜索关键词');

  // 音源：显式传入优先；为空则用默认勾选（大中华区 12）
  let sources = Array.isArray(params.sources)
    ? params.sources.filter((s) => typeof s === 'string' && s.length > 0) : [];
  if (sources.length === 0) sources = catalog.defaultSelected();
  if (sources.length === 0) throw new AppError(ERR.PARSE_FAILED, '请至少选择一个音源');

  await requireReady();

  const ch = resolveProxy();
  // 先由调用方生成 id → 推导缓存路径（下载阶段用同一 id 重新定位快照，见 cachePathFor）
  const id = session.newSearchId();
  const cachePath = cachePathFor(id);
  try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); } catch { /* 建目录失败不阻断搜索 */ }

  const started = session.start({
    id,
    keyword,
    sources,
    perSource: Number.isInteger(params.perSource) ? params.perSource : undefined,
    threads: Number.isInteger(params.threads) ? params.threads : undefined,
    // 增强搜索（实验）：true 时 bridge 走 musicsquare 式第三方代理后端
    enhanced: params.enhanced === true,
    channel: ch.channel,
    proxies: ch.proxies,
    subprocEnv: ch.subprocEnv,
    cachePath,
  });

  return { searchId: started.id, keyword, sourcesTotal: started.sourcesTotal };
}

function querySearchPoll(params = {}) {
  const id = String(params.id || '');
  if (!id) throw new AppError(ERR.PARSE_FAILED, '缺少搜索 id');
  return session.poll(id, Number.isInteger(params.since) ? params.since : 0);
}

function querySearchCancel(params = {}) {
  const id = String(params.id || '');
  if (!id) throw new AppError(ERR.PARSE_FAILED, '缺少搜索 id');
  return session.cancel(id);
}

/**
 * 歌单 / 专辑解析（P1-2）——只读查询，产出与搜索结果**同构**的会话。
 *
 * 解析结果为一批 `song` 事件（含两级：专辑 → 子曲目），攒进同一个会话注册表；
 * 前端在**同一张结果表**里渲染、勾选后走**已有的 `download` action**
 * （快照已按 searchId 落到 cachePath，download 的 `cachePathFor(searchId)` 能直接命中）。
 *
 * @param {{url?:string, sources?:string[]}} params
 * @returns {Promise<{searchId:string, url:string, sourcesTotal:number}>}
 */
async function queryPlaylist(params = {}) {
  const url = String(params.url || '').trim();
  if (!url) throw new AppError(ERR.PARSE_FAILED, '请粘贴歌单 / 专辑 / 频道链接');

  // 音源：显式传入优先；为空则由桥接层遍历全部已登记音源
  const sources = Array.isArray(params.sources)
    ? params.sources.filter((s) => typeof s === 'string' && s.length > 0) : [];

  await requireReady();

  const ch = resolveProxy();
  const id = session.newSearchId();
  const cachePath = cachePathFor(id);
  try { fs.mkdirSync(path.dirname(cachePath), { recursive: true }); } catch { /* 建目录失败不阻断解析 */ }

  const started = session.startPlaylist({
    id,
    url,
    sources,
    channel: ch.channel,
    proxies: ch.proxies,
    subprocEnv: ch.subprocEnv,
    cachePath,
  });

  return { searchId: started.id, url, sourcesTotal: started.sourcesTotal };
}

/**
 * 选择下载目录（调用系统「选择文件夹」对话框）——只读查询，**不写任何配置**。
 *
 * 用 osascript 弹原生目录框：成功返回 POSIX 路径；用户取消返回 `{cancelled:true}`；
 * 无 GUI 会话 / 被拒绝时抛错，前端据此**回落「手输路径 + 可写校验」**（设计 §10 项 7）。
 *
 * @returns {Promise<{cancelled:boolean, path:string|null, writable:boolean}>}
 */
async function queryChooseFolder() {
  const script = [
    'with timeout of 110 seconds',
    '  try',
    '    set f to choose folder with prompt "选择音乐下载目录"',
    '    return "OK:" & (POSIX path of f)',
    '  on error number -128',
    '    return "CANCELLED"',
    '  end try',
    'end timeout',
  ].join('\n');

  const res = await exec.runSafe('osascript', ['-e', script], {
    noMirror: true,
    timeoutMs: CHOOSE_FOLDER_TIMEOUT_MS,
  });
  if (res.code !== 0) {
    // 无 GUI / 被拒绝 / 超时：交给前端回落手输路径
    throw new AppError(ERR.CMD_FAILED, '无法打开系统目录选择框，请手动输入路径',
      tail(res.stderr || res.stdout));
  }
  const out = String(res.stdout || '').trim();
  if (out === 'CANCELLED') return { cancelled: true, path: null, writable: false };
  const dir = out.startsWith('OK:') ? out.slice(3).trim() : out;
  if (!dir) throw new AppError(ERR.CMD_FAILED, '未获取到目录路径，请手动输入');
  return { cancelled: false, path: dir, writable: dirWritable(dir) };
}

/**
 * 在线播放元信息（内部 query，B2）：解析快照直链 + 请求头，供 stream 路由使用。
 *
 * ★ 命中内存 TTL 缓存则直接返回，避免浏览器 seek 时每个 Range 都起一次 python。
 * ★ SSRF：只读「快照内 uid」的解析结果，绝不接受任何外部 url 入参；仅 http/https（bridge 侧保证）。
 * @param {{id?:string, uid?:string}} params
 * @returns {Promise<{url:string, ext:string, protocol:'HTTP'|'HLS', headers:object,
 *                    hasCover:boolean, coverUrl:string|null, size:number,
 *                    cacheKey:string, channel:'direct'|'proxy', proxies:object|null}>}
 */
async function queryStreamMeta(params = {}) {
  const id = String(params.id || '');
  const uid = String(params.uid || '');
  if (!session.SEARCH_ID_RE.test(id)) throw new AppError(ERR.PARSE_FAILED, '搜索 id 非法');
  if (!uid) throw new AppError(ERR.PARSE_FAILED, '缺少 uid');

  const ck = `${id}:${uid}`;
  const now = Date.now();
  const hit = streamMetaCache.get(ck);
  if (hit && now - hit.at < STREAM_META_TTL_MS) {
    streamMetaCache.delete(ck);
    streamMetaCache.set(ck, hit); // LRU touch
    return hit.meta;
  }

  const cachePath = cachePathFor(id);
  const res = await exec.runSafe(paths.MUSIC_VENV_PY, [paths.MUSIC_BRIDGE, 'stream'], {
    stdin: JSON.stringify({ command: 'stream', uid, cache_path: cachePath }),
    noMirror: true,
    timeoutMs: MUSIC_META_TIMEOUT_MS,
  });
  let done = null;
  let fatal = null;
  for (const line of paths.lines(res.stdout)) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (ev.ev === 'error') fatal = ev;
    else if (ev.ev === 'done' && ev.command === 'stream') done = ev;
  }
  if (fatal) throw toAppError(fatal);
  if (!done) throw new AppError(ERR.CMD_FAILED, '未能解析播放直链', tail(res.stderr || res.stdout));

  const ch = resolveProxy();
  const meta = {
    url: String(done.url || ''),
    ext: String(done.ext || '').replace(/^\./, ''),
    protocol: done.protocol === 'HLS' ? 'HLS' : 'HTTP',
    headers: done.headers && typeof done.headers === 'object' ? done.headers : {},
    hasCover: !!done.has_cover,
    coverUrl: typeof done.cover_url === 'string' && done.cover_url ? done.cover_url : null,
    size: Number.isFinite(done.size) ? done.size : 0,
    cacheKey: audioCacheKey(readSnapshotRec(id, uid)),
    channel: ch.channel,
    proxies: ch.proxies,
  };
  if (!meta.url) throw new AppError(ERR.CMD_FAILED, '无可用在线播放直链');

  streamMetaCache.set(ck, { meta, at: now });
  while (streamMetaCache.size > STREAM_META_MAX) {
    const oldest = streamMetaCache.keys().next().value;
    streamMetaCache.delete(oldest);
  }
  return meta;
}

/**
 * 歌词查询（内部 query）：从快照取词，返回 `{has, synced, lrc}`。
 * @param {{id?:string, uid?:string}} params
 * @returns {Promise<{has:boolean, synced:boolean, lrc:string}>}
 */
async function queryLyric(params = {}) {
  const id = String(params.id || '');
  const uid = String(params.uid || '');
  if (!session.SEARCH_ID_RE.test(id)) throw new AppError(ERR.PARSE_FAILED, '搜索 id 非法');
  if (!uid) throw new AppError(ERR.PARSE_FAILED, '缺少 uid');

  const cachePath = cachePathFor(id);
  const res = await exec.runSafe(paths.MUSIC_VENV_PY, [paths.MUSIC_BRIDGE, 'lyric'], {
    stdin: JSON.stringify({ command: 'lyric', uid, cache_path: cachePath }),
    noMirror: true,
    timeoutMs: MUSIC_META_TIMEOUT_MS,
  });
  let done = null;
  let fatal = null;
  for (const line of paths.lines(res.stdout)) {
    const ev = parseLine(line);
    if (!ev) continue;
    if (ev.ev === 'error') fatal = ev;
    else if (ev.ev === 'done' && ev.command === 'lyric') done = ev;
  }
  if (fatal) throw toAppError(fatal);
  if (!done) throw new AppError(ERR.CMD_FAILED, '未能读取歌词', tail(res.stderr || res.stdout));

  const lrc = typeof done.lrc === 'string' && done.lrc ? done.lrc : '';
  return { has: !!(done.has && lrc), synced: !!lrc && SYNCED_LRC_RE.test(lrc), lrc };
}

/** 音频缓存清理（内部 query）：启动 / 配置变更时由 server.js 触发。 */
function queryPruneAudio() {
  return pruneAudioCache();
}

// ------------------------------ 动作步骤 ------------------------------
function checkPythonStep() {
  return {
    id: 'check_python',
    title: '检查 Python 3.12+',
    run: async (ctx) => {
      const py = await env.findPython312();
      if (!py.found) {
        ctx.log('error', '未检测到 Python 3.12 或更高版本。');
        ctx.log('info', '方案一（推荐）：在「Homebrew 管家」里安装 python@3.12');
        ctx.log('info', '方案二：终端执行 brew install python@3.12');
        throw new AppError(ERR.ENV_MISSING, '未检测到 Python 3.12+',
          `候选：${py.candidates.map((c) => c.path).join(', ') || '（无）'}`);
      }
      ctx.log('ok', `Python ${py.version}（${py.path}）`);
      const free = env.diskFreeBytes(paths.PY_DIR);
      const need = (await env.detect()).disk.needBytes;
      if (typeof free === 'number' && free < need) {
        throw new AppError(ERR.IO_ERROR, `磁盘空间不足：需约 ${fmtBytes(need)}，当前可用 ${fmtBytes(free)}`,
          '请清理磁盘后重试');
      }
      ctx.log('info', `磁盘可用：${typeof free === 'number' ? fmtBytes(free) : '未知'}`);
    },
  };
}

/**
 * 创建 / 自愈独立虚拟环境。
 *
 * ★ Bug A（静默失败根因）：建 venv 用的解释器往往是**符号链接**（uv / pyenv / asdf / Homebrew）。
 *   用符号链接路径建 venv 会把 pyvenv.cfg 的 home 写成符号链接所在目录（无 stdlib）→ venv 内
 *   python 起不来、pip 装不上 → 安装瞬间失败。修复：realpath 解释器并修正 home。
 *   （细节与「为什么不直接 spawn realpath」见 lib/music/env.js 的 ensureVenv / repairVenvHome。）
 *
 * ★ Bug B（「修复」形同虚设）：已有 venv 必须**可用**才跳过；不可用则删除并重建（自愈）。
 *   删除范围严格限定 paths.MUSIC_VENV，绝不触碰 ~/Music/MacKit 里用户的音乐。
 *
 * 具体编排（realpath / 可用性自检 / 重建 / ensurepip）全部下沉到 env.ensureVenv，
 * 本步骤只负责「取解释器 + 心跳日志」。心跳覆盖整个建 venv 过程，防长静默期无反馈。
 */
function createVenvStep() {
  return {
    id: 'create_venv',
    title: '创建独立虚拟环境',
    timeoutMs: VENV_TIMEOUT_MS,
    run: async (ctx) => {
      const py = await env.findPython312();
      if (!py.found) throw new AppError(ERR.ENV_MISSING, '未检测到 Python 3.12+');
      const stop = startHeartbeat(ctx, '创建虚拟环境');
      try {
        // ctx.exec.run 是 runner 注入的箭头函数（已默认绑定本步 AbortSignal + lane），可安全直接传递。
        await env.ensureVenv({
          interpreterPath: py.path,
          venvDir: paths.MUSIC_VENV,
          run: ctx.exec.run,
          log: ctx.log,
        });
      } finally {
        stop();
      }
    },
  };
}

/**
 * 升级 pip + 安装 musicdl（代理优先，双通道自动降级）。
 *
 * ★ design v2 §A.5（Q5）：**不改 exec.js 通用层**，改由本步骤**自管两段尝试**：
 *   现有 `runWithChannel('proxy_first')` 的 `opts.env` 是**静态**、两次尝试都会叠加，
 *   会把自定义代理带进「直连回退」那次、破坏回退语义。故此处显式两次 `ctx.exec.run`：
 *     · proxy 模式：先试代理（`channel:'proxy'` + `env:{...base, ...proxyEnv}`）；
 *       失败再试直连（`channel:'direct'` + 显式删除三键）。
 *     · direct 模式：只做一次直连。
 *   代理地址经 resolveInstallProxyEnv()（唯一下发出口，含 socks5）。
 * ★ 2026-09-21：原先每个 plan 上还挂了一个 `channelPolicy` 字段，标注「仅作为元数据供 runner
 *   存档展示」—— 但全项目没有任何读取方（runner 只在 steps 投影里抄一份，前端从不显示），
 *   属死字段，已随本次清理删除；实际通道仍由本函数内的显式 run/runWithChannel 决定。
 */
function pipInstallStep() {
  return {
    id: 'pip_install',
    title: '安装 musicdl（约 300–500 MB）',
        timeoutMs: PIP_TIMEOUT_MS,
    run: async (ctx) => {
      if (!paths.exists(paths.MUSIC_VENV_PIP)) {
        throw new AppError(ERR.ENV_MISSING, '未找到 venv 内的 pip', `期望位置：${paths.MUSIC_VENV_PIP}`);
      }
      const baseEnv = {
        PIP_CACHE_DIR: paths.MUSIC_PIP_CACHE,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        PIP_NO_INPUT: '1',
      };
      const args = ['install', '-U', 'pip', 'musicdl'];
      const onLine = (line, which) => { const t = String(line || '').trim(); if (t) ctx.log(which === 'stderr' ? 'warn' : 'info', t); };
      ctx.log('info', `执行：${paths.MUSIC_VENV_PIP} install -U pip musicdl`);

      // Enhancement D：pip 下载 300–500MB 期间输出稀疏，加心跳避免用户以为卡死；步骤结束/取消即停。
      const stopHeartbeat = startHeartbeat(ctx, '安装 musicdl 依赖');
      try {
        const { channel, env: proxyEnv } = resolveInstallProxyEnv();
        if (channel === 'proxy') {
          ctx.log('info', '尝试代理安装 musicdl …');
          const resProxy = await ctx.exec.run(paths.MUSIC_VENV_PIP, args, {
            noMirror: true, channel: 'proxy', env: { ...baseEnv, ...proxyEnv }, onLine,
          });
          if (resProxy.code === 0) {
            ctx.setChannel('proxy');
            ctx.log('ok', 'musicdl 安装完成（代理）');
            return;
          }
          ctx.log('warn', '代理失败，改用直连重试…');
        }

        // 直连：显式删除三键（base 覆盖 + delete 语义），确保真的不走代理
        const resDirect = await ctx.exec.run(paths.MUSIC_VENV_PIP, args, {
          noMirror: true, channel: 'direct',
          env: { ...baseEnv, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined },
          onLine,
        });
        if (resDirect.code !== 0) {
          throw new AppError(ERR.CMD_FAILED, '安装 musicdl 失败，试试切换「网络通道」',
            tail(resDirect.stderr || resDirect.stdout));
        }
        ctx.setChannel('direct');
        ctx.log('ok', 'musicdl 安装完成（直连）');
      } finally {
        stopHeartbeat();
      }
    },
  };
}

function verifyEnvStep() {
  return {
    id: 'verify',
    title: '验证音频环境',
    run: async (ctx) => {
      // 首次 `import musicdl` 可能要数十秒（冷启动 / 首次解压 / 反病毒扫描），先行一条即时日志，
      // 让用户在这段静默期立刻看到反馈（probeMusicdl 的 IMPORT_TIMEOUT_MS 最长 30s）。
      ctx.log('info', '正在验证音频环境（首次导入 musicdl 可能需要数十秒）…');
      // Enhancement D：本步的 import 探针最长 30s，同样需要心跳；结束 / 异常两条路径都必须停。
      const stop = startHeartbeat(ctx, '验证音频环境');
      try {
        let r;
        try { r = await env.probeMusicdl(); }
        catch (err) { r = { installed: false, version: null, importError: String((err && err.message) || err) }; }
        if (!r.installed) {
          // ★ 升级安全网（Task B）：`pip install -U musicdl` 可能装到坏包 / 上游新版本有破坏性变更，
          //   此时 `import musicdl` 失败。自动回滚到 MacKit 锁定版本（**用常量**，不硬编码）后复查；
          //   回滚后仍异常才走既有失败路径。已装版本 > target 的「不判 outdated」语义不受影响。
          ctx.log('warn', `import musicdl 失败，尝试回滚到锁定版本 ${MUSICDL_TARGET_VERSION} …`);
          const rolled = await rollbackMusicdl(ctx);
          r = await env.probeMusicdl();
          if (!r.installed) {
            invalidateMusicEnvCache();
            throw new AppError(ERR.CMD_FAILED,
              rolled ? `安装已结束，回滚到 ${MUSICDL_TARGET_VERSION} 后 import musicdl 仍失败` : '安装已结束，但 import musicdl 仍失败',
              r.importError || undefined);
          }
          invalidateMusicEnvCache();
          // 日志按**实际结果**区分：真的执行了回滚 vs 只是探针瞬时失败、复查已通过
          ctx.log('warn', rolled
            ? `升级失败，已回滚到 ${MUSICDL_TARGET_VERSION}`
            : `探测瞬时失败，复查已通过（未执行回滚，当前 musicdl ${r.version || '未知版本'}）`);
        }
        invalidateMusicEnvCache();
        ctx.log('ok', `音乐环境已就绪：musicdl ${r.version || '未知版本'}`);
        ctx.log('info', `桥接脚本：${paths.MUSIC_BRIDGE}${paths.exists(paths.MUSIC_BRIDGE) ? '' : '（缺失！）'}`);
      } finally {
        stop();
      }
    },
  };
}

/**
 * 升级安全网：把 musicdl 回滚到 MacKit 锁定版本（`pip install 'musicdl==<TARGET>'`）。
 *
 * 通道策略与 pipInstallStep 一致（代理优先、失败换直连）；任何失败都不抛 —— 由调用方
 * 复查 `import musicdl` 决定后续（回滚成功与否都能得到明确的最终结论）。
 * @param {object} ctx runner 步骤上下文（含 ctx.exec / ctx.log）
 * @returns {Promise<boolean>} 回滚命令是否退出码 0
 */
async function rollbackMusicdl(ctx) {
  if (!paths.exists(paths.MUSIC_VENV_PIP)) {
    ctx.log('warn', `未找到 venv 内的 pip，无法回滚：${paths.MUSIC_VENV_PIP}`);
    return false;
  }
  const args = ['install', `musicdl==${MUSICDL_TARGET_VERSION}`];
  ctx.log('info', `执行：${paths.MUSIC_VENV_PIP} ${args.join(' ')}`);
  const baseEnv = {
    PIP_CACHE_DIR: paths.MUSIC_PIP_CACHE,
    PIP_DISABLE_PIP_VERSION_CHECK: '1',
    PIP_NO_INPUT: '1',
  };
  const onLine = (line, which) => { const t = String(line || '').trim(); if (t) ctx.log(which === 'stderr' ? 'warn' : 'info', t); };
  try {
    const { channel, env: proxyEnv } = resolveInstallProxyEnv();
    if (channel === 'proxy') {
      const resProxy = await ctx.exec.run(paths.MUSIC_VENV_PIP, args, {
        noMirror: true, channel: 'proxy', env: { ...baseEnv, ...proxyEnv }, onLine, timeoutMs: PIP_TIMEOUT_MS,
      });
      if (resProxy.code === 0) return true;
      ctx.log('warn', '代理回滚失败，改用直连重试…');
    }
    const resDirect = await ctx.exec.run(paths.MUSIC_VENV_PIP, args, {
      noMirror: true, channel: 'direct',
      env: { ...baseEnv, http_proxy: undefined, https_proxy: undefined, all_proxy: undefined },
      onLine, timeoutMs: PIP_TIMEOUT_MS,
    });
    return resDirect.code === 0;
  } catch (err) {
    ctx.log('warn', `回滚执行异常（忽略，继续复查）：${(err && err.message) || err}`);
    return false;
  }
}

function removeEnvStep() {
  return {
    id: 'remove',
    title: '卸载音频环境',
    run: async (ctx) => {
      const targets = [paths.MUSIC_VENV, paths.MUSIC_PIP_CACHE];
      for (const dir of targets) {
        if (!paths.exists(dir)) { ctx.log('info', `不存在，跳过：${dir}`); continue; }
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          ctx.log('ok', `已删除：${dir}`);
        } catch (err) {
          throw new AppError(ERR.IO_ERROR, `删除失败：${dir}`, String(err && err.message));
        }
      }
      // PY_DIR 若已空也一并清掉（保持 ~/.mackit 整洁）
      try {
        if (paths.exists(paths.PY_DIR) && fs.readdirSync(paths.PY_DIR).length === 0) fs.rmdirSync(paths.PY_DIR);
      } catch { /* 非空或权限问题：忽略 */ }
      invalidateMusicEnvCache();
    },
  };
}

/**
 * 单曲下载（一个 bridge 子进程 → 一首歌）。
 *
 * 成功返回 'ok'，被跳过返回 'skip'；**失败抛错**（由调用方决定「是否拖垮整步」：
 * concurrency=1 时抛出即步骤失败；批量并发时由批量步自行吞掉单曲失败）。
 * @param {object} ctx runner 步骤上下文（含 ctx.exec / ctx.log）
 * @param {string} uid
 * @param {{searchId:string, dir:string, template:string, saveLyrics:boolean}} t
 * @returns {Promise<'ok'|'skip'>}
 */
async function downloadSingle(ctx, uid, t) {
  await requireReady();
  const ch = resolveProxy();
  const cachePath = cachePathFor(t.searchId);
  const payload = {
    command: 'download',
    search_id: t.searchId,
    cache_path: cachePath,
    uids: [uid],
    dir: t.dir,
    template: t.template,
    save_lyrics: t.saveLyrics !== false,
    channel: ch.channel,
    proxies: ch.proxies,
  };
  let fatal = null;
  /** @type {object[]} */
  const results = [];
  const res = await ctx.exec.run(paths.MUSIC_VENV_PY, [paths.MUSIC_BRIDGE, 'download'], {
    stdin: JSON.stringify(payload),
    noMirror: true,
    channel: ch.channel,
    env: ch.subprocEnv, // ★ A-6：环境变量代理（HLS 子下载器 / trust_env 裸 requests），只摘 all_proxy
    onLine: (line, which) => {
      if (which === 'stdout') {
        const ev = parseLine(line);
        if (!ev) return;
        if (ev.ev === 'result') results.push(ev);
        else if (ev.ev === 'error') fatal = ev;
      } else {
        const text = String(line || '').trim();
        if (text) ctx.log('warn', text);
      }
    },
  });
  if (fatal) throw toAppError(fatal);
  if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, '下载子进程异常退出', tail(res.stderr));

  const mine = results.find((r) => r.uid === uid) || results[0];
  if (!mine) throw new AppError(ERR.CMD_FAILED, '下载未返回结果');
  if (mine.status === 'ok') {
    // R3a-2：日志四要素「编码 · 码率 · 采样率 · 大小」，缺项以 — 占位（C7）
    const quality = [
      fmtCodec(mine.codec),
      fmtMeasuredBitrate(mine.bitrate),
      fmtSamplerate(mine.samplerate),
      fmtBytes(mine.bytes),
    ].join(' · ');
    ctx.log('ok', `已下载：${mine.file}（${quality}${mine.lyrics ? ' · 含歌词' : ''}）`);
    return 'ok';
  }
  if (mine.status === 'skip') return 'skip';
  throw new AppError(ERR.CMD_FAILED, `下载失败：${mine.error || '未知原因'}`);
}

/**
 * 单曲下载步骤（**concurrency=1 时使用**：每曲一步，与历史行为完全一致）。
 * @param {number} i 序号
 * @param {string} uid 曲目 uid
 * @param {{searchId:string, dir:string, template:string, saveLyrics:boolean}} t 下载上下文
 */
function downloadStep(i, uid, t) {
  return {
    id: `dl_${i}`,
    title: `下载曲目 ${i + 1}`,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    run: async (ctx) => {
      const r = await downloadSingle(ctx, uid, t);
      if (r === 'skip') throw new AppError('SKIP', `已跳过：${uid}`);
    },
  };
}

/** 读取下载并发度（配置缺失/非法一律回落 1 = 每曲一步）。 */
function readDownloadConcurrency() {
  try {
    const n = Number(store.readMackit().musicDownloadConcurrency);
    if (Number.isFinite(n)) return Math.min(5, Math.max(1, Math.trunc(n)));
  } catch { /* 回落 1 */ }
  return 1;
}

/**
 * 固定并发子进程池：把 items 分给至多 size 个 worker 并发跑。
 * worker 必须自行吞掉异常（否则会中断整轮 Promise.all）——本函数只保证调度。
 * @param {any[]} items
 * @param {number} size
 * @param {(item:any) => Promise<void>} worker
 */
async function runPool(items, size, worker) {
  const queue = items.slice();
  const n = Math.max(1, Math.min(Math.trunc(size) || 1, queue.length));
  const runners = [];
  for (let i = 0; i < n; i++) {
    runners.push((async () => {
      while (queue.length > 0) {
        const item = queue.shift();
        await worker(item);
      }
    })());
  }
  await Promise.all(runners);
}

/**
 * 批量下载步骤（**concurrency>1 时使用**）：一批 uids 并发跑（子进程池 = concurrency）。
 *
 * 计数口径沿用 runner.countSteps（**以步为单位**）：本批只要有一首成功或被跳过，就不算整步失败；
 * 仅当**整批全失败**时抛错（与 finalizeDownloads「全部失败才算失败」的口径一致）。
 * @param {number} idx 批序号
 * @param {string[]} batch 本批 uids
 * @param {object} t 下载上下文
 * @param {number} concurrency 并发度
 */
function downloadBatchStep(idx, batch, t, concurrency) {
  return {
    id: `dl_batch_${idx}`,
    title: batch.length > 1 ? `下载曲目 ${idx * concurrency + 1}–${idx * concurrency + batch.length}` : `下载曲目 ${idx * concurrency + 1}`,
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    run: async (ctx) => {
      /** @type {Array<'ok'|'skip'|'fail'>} */
      const outcomes = [];
      await runPool(batch, concurrency, async (uid) => {
        try {
          outcomes.push(await downloadSingle(ctx, uid, t));
        } catch (err) {
          if (err && err.code === 'SKIP') { outcomes.push('skip'); return; }
          outcomes.push('fail');
          ctx.log('error', `下载失败：${uid} —— ${(err && err.message) || err}`);
        }
      });
      const anySuccessOrSkip = outcomes.some((o) => o === 'ok' || o === 'skip');
      if (!anySuccessOrSkip && outcomes.length > 0) {
        throw new AppError(ERR.CMD_FAILED, '本批曲目全部下载失败');
      }
    },
  };
}

/** 批量下载步骤集（download / retry 共用）。 */
function downloadSteps(params) {
  const searchId = String(params.searchId || '');
  const uids = Array.isArray(params.uids) ? params.uids.filter((u) => typeof u === 'string' && u) : [];
  if (!searchId) return [badStep('缺少 searchId')];
  if (!session.SEARCH_ID_RE.test(searchId)) return [badStep('searchId 非法')];
  if (uids.length === 0) return [badStep('未选择任何曲目')];

  const { dir, template, saveLyrics } = resolveTargets(params);
  const t = { searchId, dir, template, saveLyrics };

  const concurrency = readDownloadConcurrency();
  // ★ E1：concurrency=1 → 「每曲一步」与现状完全一致；>1 → 按并发度切批，批内子进程池并发。
  if (concurrency <= 1) return uids.map((uid, i) => downloadStep(i, uid, t));
  const batches = [];
  for (let i = 0; i < uids.length; i += concurrency) batches.push(uids.slice(i, i + concurrency));
  return batches.map((batch, idx) => downloadBatchStep(idx, batch, t, concurrency));
}

/** 下载类动作终态：只要不是「全部失败」即算成功（复用 runner.countSteps 口径，§3.3）。 */
function finalizeDownloads(task, { log }) {
  const counts = countSteps(task.steps);
  if (task.status === 'cancelled') { log('info', `任务已取消：成功 ${counts.ok} / 跳过 ${counts.skip} / 失败 ${counts.fail}`); return; }
  if (counts.fail > 0 && counts.ok === 0 && counts.skip === 0) {
    task.status = 'fail';
  } else {
    task.status = 'ok';
    task.error = null;
  }
  log('info', `下载完成：成功 ${counts.ok} / 跳过 ${counts.skip} / 失败 ${counts.fail}`);
}

/**
 * 「在 Finder 打开下载目录」步骤（P0-6）。
 *
 * 语义等价于 `open <下载目录>`：
 *   · 目录不存在时**自动创建**（`fs.mkdirSync(recursive)`，与「自动创建」的 P0-6 语义一致），
 *     创建失败给明确错误；随后交给系统 `open`；
 *   · ★ 目录由用户配置、**用户可控**，因此绝不拼 shell 字符串 —— 经 exec 层语义封装
 *     `ctx.exec.openInFinder(dir)` 以**参数数组**把目录原样交给 `/usr/bin/open`
 *     （exec 层 `shell:false`，无注入面；bin 常量统一收敛在 exec.js）。
 *
 * @param {{dir?:string}} [params] 允许指定目录；缺省取配置 / 默认目录（resolveTargets）
 * @returns {{id:string, title:string, run:Function}}
 */
function openFolderStep(params) {
  return {
    id: 'open_folder',
    title: '在 Finder 打开下载目录',
    run: async (ctx) => {
      const { dir } = resolveTargets(params);
      if (!dir) throw new AppError(ERR.PARSE_FAILED, '下载目录未设置');
      // P0-6：目录不存在则自动创建（下载目标目录本来也会在下载时创建）
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (err) {
        throw new AppError(ERR.IO_ERROR, `无法创建目录：${dir}`, String(err && err.message));
      }
      ctx.log('info', `打开：${dir}`);
      const res = await ctx.exec.openInFinder(dir);
      if (res.code !== 0) {
        throw new AppError(ERR.CMD_FAILED, '无法在 Finder 中打开目录', tail(res.stderr || res.stdout));
      }
      ctx.log('ok', '已在 Finder 中打开');
    },
  };
}

// ------------------------------ 动作定义 ------------------------------
const actions = {
  /** 一键安装音频环境（destructive：需 confirm:true）。 */
  install_env: {
    title: '安装音频环境',
    destructive: true,
    steps: () => [checkPythonStep(), createVenvStep(), pipInstallStep(), verifyEnvStep()],
  },

  /** 卸载音频环境（删除 venv 与 pip 缓存，可逆）。 */
  uninstall_env: {
    title: '卸载音频环境',
    destructive: true,
    steps: () => [removeEnvStep()],
  },

  /** 下载选中曲目（一曲一步，失败不中断）。歌单解析结果也用本动作（同构 rows + 同一 searchId）。 */
  download: {
    title: '下载曲目',
    steps: (params) => downloadSteps(params),
    finalize: finalizeDownloads,
  },

  /** 失败重试（仅重下传入的 uids）。 */
  retry: {
    title: '重试下载',
    steps: (params) => downloadSteps(params),
    finalize: finalizeDownloads,
  },

  /**
   * 在 Finder 打开下载目录（P0-6）。**普通动作**：只读式副作用（不起下载），
   * 非 destructive、无需 `confirm`。目录不存在则自动创建。
   */
  open_folder: {
    title: '在 Finder 打开',
    steps: (params) => [openFolderStep(params || {})],
  },
};

export default {
  id: 'music',
  lane: 'music', // ★ server.js 透传给 runner.submit（§3.3）
  actions,
  queries: {
    deployStatus: queryDeployStatus,
    // musicdl 上游版本（PyPI，纯提示；绝不抛网络错误，见 queryMusicdlUpstream）
    musicdlUpstream: queryMusicdlUpstream,
    sources: querySources,
    config: queryConfig,
    search: querySearch,
    searchPoll: querySearchPoll,
    searchCancel: querySearchCancel,
    playlist: queryPlaylist,
    chooseFolder: queryChooseFolder,
    // 在线播放：元信息（内部）+ 歌词 + 缓存清理（启动 / 配置变更触发）
    streamMeta: queryStreamMeta,
    lyric: queryLyric,
    pruneAudio: queryPruneAudio,
  },
  /**
   * 优雅退出钩子（server.js gracefulShutdown 经 registry 可选调用）：
   * 取消所有只读会话（搜索 / 歌单）子进程 —— 它们 lane='music-search'、**不经 runner**，
   * 只有搜索在跑时 runner.isBusy() 为 false，必须由此主动回收，避免孤儿进程。
   * @returns {number} 被请求取消的会话数
   */
  shutdown() {
    return session.cancelAllSessions();
  },
};
