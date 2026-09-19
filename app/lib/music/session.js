/**
 * MacKit · 音乐模块 · 会话注册表（设计文档 §3.3 SearchSession）
 *
 * 搜索与歌单解析都是**只读查询**，不进任务队列（否则 57 源并发会阻塞 brew 等 default lane 任务）。
 * 每次查询起一个独立子进程（lane='music-search'），本模块把 bridge 吐出的 NDJSON 事件
 * 攒进内存缓冲，前端通过轮询 `poll(since)` 增量取回；支持取消与 TTL 回收。
 *
 * 两种 command 共用同一注册表与同一套「事件 → 行」投影：
 *   · 'search'   —— 关键词搜索（start(keyword)）；
 *   · 'playlist' —— 歌单/专辑 URL 解析（startPlaylist(url)），产出与搜索结果**同构**的 rows，
 *                  用户勾选后走**已有的** download action（快照已按 searchId 落盘）。
 *
 * 生命周期：start() → append()*（由 onLine 驱动）→ poll()* → done/error/cancel；
 * 超过 SESSION_TTL_MS 未再被访问的会话会被 sweep 回收（含 abort 子进程）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as paths from '../paths.js';
import * as exec from '../exec.js';
import { parseLine, toAppError } from './ndjson.js';

/** 会话空闲回收时长（10 分钟） */
const SESSION_TTL_MS = 10 * 60 * 1000;
/** 单次搜索子进程超时（与 runner 默认一致） */
const SEARCH_TIMEOUT_MS = 600_000;
/** 搜索快照保留上限（份）与 TTL（7 天）——超出任一即删，避免缓存目录长期堆积 */
const CACHE_KEEP_FILES = 50;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** 快照清理的最小间隔（毫秒）：sweepTtl 每次轮询都会跑，别每次都 readdir */
const CACHE_PRUNE_INTERVAL_MS = 60_000;

/** @type {Map<string, object>} */
const sessions = new Map();

/** 生成搜索 id：`s_<ts>_<rand6>`（不复用 t_ 前缀，避免与 TASK_ID_RE 冲突，见 §9）。 */
export function newSearchId() {
  return `s_${Date.now()}_${crypto.randomBytes(4).toString('hex').slice(0, 6)}`;
}

/** 搜索 id 格式校验（download 用 id 拼缓存路径，必须校验防目录穿越）。 */
export const SEARCH_ID_RE = /^s_\d+_[0-9a-f]{6}$/;

/** 上次快照清理时间（节流用）。 */
let lastPruneAt = 0;

/**
 * 清理超时会话（取消仍在跑的子进程）——顺带按节流清理搜索快照目录。
 * 每次 start / poll 都会调用，无需常驻定时器。
 */
function sweepTtl() {
  const deadline = Date.now() - SESSION_TTL_MS;
  for (const [id, s] of sessions) {
    if (s.updatedAt >= deadline) continue;
    try { s.controller.abort(); } catch { /* ignore */ }
    sessions.delete(id);
  }
  if (Date.now() - lastPruneAt > CACHE_PRUNE_INTERVAL_MS) {
    lastPruneAt = Date.now();
    pruneSearchCache();
  }
}

/**
 * 清理搜索 / 歌单快照目录（`~/.mackit/cache/music/search/search-<id>.json`）。
 *
 * 策略（设计 §3.3 快照的落盘副作用，原设计未覆盖其回收）：**7 天 TTL** 优先，
 * 再对存活项按 mtime 新→旧排序、**只保留最近 50 份**，多余删除。
 * 目录不存在（从未搜过）或读取失败一律静默跳过，绝不打断会话。
 */
function pruneSearchCache() {
  let names;
  try { names = fs.readdirSync(paths.MUSIC_SEARCH_CACHE_DIR); }
  catch { return; }
  const now = Date.now();
  /** @type {Array<{path:string, mtime:number}>} */
  const kept = [];
  for (const name of names) {
    if (!name.startsWith('search-') || !name.endsWith('.json')) continue;
    const full = path.join(paths.MUSIC_SEARCH_CACHE_DIR, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (now - st.mtimeMs > CACHE_TTL_MS) {
      try { fs.rmSync(full, { force: true }); } catch { /* ignore */ }
      continue;
    }
    kept.push({ path: full, mtime: st.mtimeMs });
  }
  if (kept.length <= CACHE_KEEP_FILES) return;
  kept.sort((a, b) => b.mtime - a.mtime); // 新的在前
  for (const f of kept.slice(CACHE_KEEP_FILES)) {
    try { fs.rmSync(f.path, { force: true }); } catch { /* ignore */ }
  }
}

function pushStderr(s, line) {
  const t = String(line || '').trim();
  if (!t) return;
  s.stderr.push(t);
  if (s.stderr.length > 40) s.stderr.splice(0, s.stderr.length - 40);
}

/** 把一条 NDJSON 事件并入会话状态。 */
function append(s, ev) {
  s.updatedAt = Date.now();
  switch (ev.ev) {
    case 'start':
      s.sourcesTotal = Number.isInteger(ev.sources_total) ? ev.sources_total : s.sourcesTotal;
      break;
    case 'source':
      s.currentSource = null; // 该源已出结果（ok/fail），清除「正在搜索」指示
      if (ev.status === 'ok') s.counts.sourcesOk += 1;
      else s.counts.sourcesFail += 1;
      break;
    case 'source_start':
      // bridge 串行搜每个源前都会先发本事件：某源挂住时前端能显示卡在谁身上
      s.currentSource = String(ev.source || '');
      break;
    case 'song': {
      const row = {
        uid: String(ev.uid || ''),
        parentUid: ev.parent_uid == null ? null : String(ev.parent_uid),
        source: String(ev.source || ''),
        kind: ev.kind === 'album' ? 'album' : 'track',
        songname: String(ev.songname || ''),
        singers: String(ev.singers || ''),
        album: String(ev.album || ''),
        duration: Number.isFinite(ev.duration) ? ev.duration : 0,
        ext: String(ev.ext || ''),
        // R3a-1：码率缺失一律 null（不再用 0 占位，避免前端误显 `0k`）；新增 codec / samplerate
        bitrate: Number.isFinite(ev.bitrate) ? ev.bitrate : null,
        codec: typeof ev.codec === 'string' && ev.codec ? ev.codec : null,
        samplerate: Number.isFinite(ev.samplerate) ? ev.samplerate : null,
        filesize: Number.isFinite(ev.filesize) ? ev.filesize : 0,
        hasEpisodes: !!ev.has_episodes,
        childrenCount: Number.isFinite(ev.children_count) ? ev.children_count : 0,
      };
      s.rows.push(row);
      s.rowByUid.set(row.uid, row);
      s.counts.songs += 1;
      break;
    }
    case 'error': {
      const err = toAppError(ev);
      s.status = 'fail';
      s.error = err.toObj();
      break;
    }
    case 'done':
      if (s.status === 'running') s.status = 'done';
      if (Number.isFinite(ev.count)) s.counts.songs = ev.count;
      if (Number.isFinite(ev.sources_ok)) s.counts.sourcesOk = ev.sources_ok;
      if (Number.isFinite(ev.sources_fail)) s.counts.sourcesFail = ev.sources_fail;
      s.doneSeen = true;
      break;
    default:
      break; // progress / result 等对搜索无意义，仅转发
  }
  s.events.push(ev);
}

/**
 * 启动一次会话（搜索或歌单解析）。
 *
 * @param {object} opts
 * @param {string} [opts.id] 会话 id（由调用方预生成，便于同时推导缓存路径）
 * @param {'search'|'playlist'} [opts.command='search'] 子命令
 * @param {string} [opts.keyword] 搜索关键词（command='search' 时必填）
 * @param {string} [opts.url] 歌单/专辑 URL（command='playlist' 时必填）
 * @param {string[]} opts.sources
 * @param {number} [opts.perSource]
 * @param {number} [opts.threads]
 * @param {'direct'|'proxy'} [opts.channel]
 * @param {object|null} [opts.proxies]
 * @param {object} [opts.subprocEnv] 传给 exec.run 的 opts.env（A-6：环境代理，只摘 all_proxy）
 * @param {string} opts.cachePath 快照落盘路径
 * @returns {{id:string, command:'search'|'playlist', keyword:string, url:string, sourcesTotal:number}}
 */
export function start(opts) {
  sweepTtl();
  const command = opts.command === 'playlist' ? 'playlist' : 'search';
  const id = SEARCH_ID_RE.test(String(opts.id || '')) ? String(opts.id) : newSearchId();
  const keyword = String(opts.keyword || '').trim();
  const url = String(opts.url || '').trim();
  const sources = Array.isArray(opts.sources) ? opts.sources.slice() : [];
  const cachePath = String(opts.cachePath || '');

  const session = {
    id,
    command,
    keyword,
    url,
    sources,
    sourcesTotal: sources.length,
    events: [],
    rows: [],
    rowByUid: new Map(),
    counts: { sourcesOk: 0, sourcesFail: 0, songs: 0 },
    currentSource: null,
    status: 'running',
    error: null,
    doneSeen: false,
    cancelRequested: false,
    stderr: [],
    cachePath,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    controller: new AbortController(),
  };
  sessions.set(id, session);

  const payload = command === 'playlist'
    ? {
      command: 'playlist',
      url,
      sources,
      channel: opts.channel === 'proxy' ? 'proxy' : 'direct',
      proxies: opts.proxies && typeof opts.proxies === 'object' ? opts.proxies : null,
      search_id: id,
      cache_path: cachePath,
    }
    : {
      command: 'search',
      keyword,
      sources,
      per_source: Number.isInteger(opts.perSource) && opts.perSource > 0 ? opts.perSource : 5,
      threads: Number.isInteger(opts.threads) && opts.threads > 0 ? opts.threads : 8,
      channel: opts.channel === 'proxy' ? 'proxy' : 'direct',
      proxies: opts.proxies && typeof opts.proxies === 'object' ? opts.proxies : null,
      search_id: id,
      cache_path: cachePath,
    };

  const finish = (err) => {
    session.updatedAt = Date.now();
    if (err) {
      if (session.cancelRequested) {
        session.status = 'cancelled';
        session.error = { code: exec.ERR.CANCELLED, message: '已取消' };
      } else if (session.status === 'running') {
        session.status = 'fail';
        session.error = exec.toErrObj(err);
      }
    } else if (session.status === 'running') {
      // 进程正常退出但没收到 done 事件 → 协议异常
      session.status = 'fail';
      session.error = {
        code: exec.ERR.PARSE_FAILED,
        message: `${command === 'playlist' ? '歌单解析' : '搜索'}未正常结束（未收到 done 事件）`,
        detail: session.stderr.slice(-5).join('\n') || undefined,
      };
    }
  };

  exec.run(paths.MUSIC_VENV_PY, [paths.MUSIC_BRIDGE, command], {
    stdin: JSON.stringify(payload),
    lane: 'music-search', // 独立 lane：取消音乐下载时不得误杀搜索子进程
    signal: session.controller.signal,
    channel: payload.channel,
    // ★ A-6：环境变量代理（服务 HLS 子下载器与 trust_env 裸 requests）；subprocEnv 在 applyProxyEnv 之后覆盖
    env: opts.subprocEnv && typeof opts.subprocEnv === 'object' ? opts.subprocEnv : undefined,
    noMirror: true,
    timeoutMs: SEARCH_TIMEOUT_MS,
    onLine: (line, which) => {
      if (which === 'stdout') {
        const ev = parseLine(line);
        if (ev) append(session, ev);
      } else {
        pushStderr(session, line);
      }
    },
  }).then(() => finish(null)).catch((err) => finish(err));

  return { id, command, keyword, url, sourcesTotal: sources.length };
}

/**
 * 启动一次歌单/专辑解析会话（与搜索同构，复用同一注册表与轮询/取消接口）。
 * @param {object} opts 同 start()，另需 opts.url
 * @returns {{id:string, command:'playlist', keyword:string, url:string, sourcesTotal:number}}
 */
export function startPlaylist(opts) {
  return start({ ...opts, command: 'playlist' });
}

/**
 * 轮询读取会话增量。
 * @param {string} id
 * @param {number} since 已消费的事件数（前端上次拿到的 nextSince）
 * @returns {{status:string, events:object[], rows:object[], counts:object,
 *            currentSource:string|null, error:object|null, nextSince:number, total:number}}
 */
export function poll(id, since) {
  sweepTtl();
  const s = sessions.get(id);
  if (!s) throw new exec.AppError(exec.ERR.NOT_FOUND, '搜索会话不存在或已过期');
  s.updatedAt = Date.now();
  const from = Number.isInteger(since) && since >= 0 ? Math.min(since, s.events.length) : 0;
  return {
    status: s.status,
    events: s.events.slice(from),
    rows: s.rows,
    counts: { ...s.counts },
    currentSource: s.currentSource || null,
    error: s.error,
    nextSince: s.events.length,
    total: s.events.length,
  };
}

/**
 * 取消搜索：abort → exec 侧 SIGTERM→3s→SIGKILL 终止子进程。
 * @param {string} id
 * @returns {{cancelled:boolean}}
 */
export function cancel(id) {
  const s = sessions.get(id);
  if (!s) return { cancelled: false };
  if (s.status !== 'running') return { cancelled: false };
  s.cancelRequested = true;
  s.updatedAt = Date.now();
  try { s.controller.abort(); } catch { /* ignore */ }
  return { cancelled: true };
}

/**
 * 取消**所有**仍在运行的会话（供 server.js 优雅退出调用）。
 *
 * 搜索 / 歌单会话**不经 runner**（本模块直接用 exec.run 起 bridge.py，lane 'music-search'），
 * 因此「只有搜索在跑、没有任何任务」时 runner 侧看不到任何东西；必须由模块主动回收，
 * 否则进程退出会留下孤儿 Python 子进程。abort → exec 的 SIGTERM→3s→SIGKILL 路径。
 *
 * @returns {number} 被请求取消的会话数
 */
export function cancelAllSessions() {
  let n = 0;
  for (const s of sessions.values()) {
    if (s.status !== 'running') continue;
    s.cancelRequested = true;
    s.updatedAt = Date.now();
    try { s.controller.abort(); n += 1; } catch { /* ignore */ }
  }
  return n;
}

/** 会话快照（调试 / 测试用）。 */
export function get(id) {
  const s = sessions.get(id);
  if (!s) return null;
  return {
    id: s.id, command: s.command, keyword: s.keyword, url: s.url, status: s.status,
    counts: { ...s.counts }, rows: s.rows.slice(), events: s.events.length,
  };
}
