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
 * 通用「目录按 mtime 的 LRU 清理」——音乐模块两个缓存目录共用（搜索快照 / 在线播放音频）。
 *
 * 读目录 → 逐项：跳过点文件 → `statSync` → ：
 *   ① `.part` 崩溃孤儿回收：`stalePartMs>0` 且 mtime 早于 `now-stalePartMs` 的删除
 *      （正常关闭会自删自己的 `.part`，残留超时者视为孤儿）；
 *   ② `ttlMs>0` 且 mtime 早于 `now-ttlMs` 的删除；
 *   ③ 其余经 `accept(name)` 过滤后归集：先按 `maxBytes`（累计 size，旧→新删至不超限）、
 *      再按 `maxEntries`（保留 mtime 最新的 N 个）做 LRU 收敛。
 * 目录不存在 / 读取失败 / 删除失败一律静默（绝不打断调用方）。
 * @param {string} dir 目标目录
 * @param {{accept?:(name:string)=>boolean, ttlMs?:number, stalePartMs?:number, maxEntries?:number, maxBytes?:number}} [opts]
 * @returns {{removed:number, bytes:number}} 删除数 + 存活项累计字节
 */
export function pruneDirByLru(dir, opts = {}) {
  const accept = typeof opts.accept === 'function' ? opts.accept : () => true;
  const ttlMs = Number(opts.ttlMs) || 0;
  const stalePartMs = Number(opts.stalePartMs) || 0;
  const maxEntries = Number(opts.maxEntries) || 0;
  const maxBytes = Number(opts.maxBytes) || 0;
  let names;
  try { names = fs.readdirSync(dir); } catch { return { removed: 0, bytes: 0 }; }
  const now = Date.now();
  /** @type {Array<{path:string, mtime:number, size:number}>} */
  const kept = [];
  let total = 0;
  let removed = 0;
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    // ① `.part` 崩溃孤儿回收
    if (name.endsWith('.part') && stalePartMs > 0 && now - st.mtimeMs > stalePartMs) {
      try { fs.rmSync(full, { force: true }); removed += 1; } catch { /* ignore */ }
      continue;
    }
    if (!accept(name)) continue;
    // ② TTL
    if (ttlMs > 0 && now - st.mtimeMs > ttlMs) {
      try { fs.rmSync(full, { force: true }); removed += 1; } catch { /* ignore */ }
      continue;
    }
    kept.push({ path: full, mtime: st.mtimeMs, size: st.size });
    total += st.size;
  }
  // ③ 尺寸预算：旧 → 新 删到累计 size ≤ maxBytes
  if (maxBytes > 0 && total > maxBytes) {
    kept.sort((a, b) => a.mtime - b.mtime);
    for (const f of kept) {
      if (total <= maxBytes) break;
      try { fs.rmSync(f.path, { force: true }); total -= f.size; removed += 1; } catch { /* ignore */ }
    }
  }
  // ④ 条目预算：保留 mtime 最新的 maxEntries 个
  if (maxEntries > 0 && kept.length > maxEntries) {
    kept.sort((a, b) => b.mtime - a.mtime);
    for (const f of kept.slice(maxEntries)) {
      try { fs.rmSync(f.path, { force: true }); removed += 1; } catch { /* ignore */ }
    }
  }
  return { removed, bytes: total };
}

/**
 * 清理搜索 / 歌单快照目录（`~/.mackit/cache/music/search/search-<id>.json`）。
 *
 * 策略（设计 §3.3 快照的落盘副作用，原设计未覆盖其回收）：**7 天 TTL** 优先，
 * 再对存活项按 mtime 新→旧排序、**只保留最近 50 份**，多余删除。
 * 目录不存在（从未搜过）或读取失败一律静默跳过，绝不打断会话。
 */
function pruneSearchCache() {
  pruneDirByLru(paths.MUSIC_SEARCH_CACHE_DIR, {
    accept: (name) => name.startsWith('search-') && name.endsWith('.json'),
    ttlMs: CACHE_TTL_MS,
    maxEntries: CACHE_KEEP_FILES,
  });
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
      // 该源已出结果（ok/fail/timeout），从「正在搜索」集合移除
      s.runningSources.delete(String(ev.source || ''));
      if (s.currentSource === String(ev.source || '')) s.currentSource = null;
      if (ev.status === 'ok') s.counts.sourcesOk += 1;
      else s.counts.sourcesFail += 1;
      break;
    case 'source_start':
      // 并行搜索：每个源开搜前发本事件；集合里保留所有仍在跑的源，前端据此显示「正在搜索：A / B / C」
      s.runningSources.add(String(ev.source || ''));
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
      // ★ A3：在线播放口径（三处投影必须一致，见 bridge.py project_song / cmd_search_proxy）。
      //   ★ 硬约束：download_url / 直链绝不投影进 row、绝不下发前端。
      row.has_cover = !!ev.has_cover;
      row.protocol = ev.protocol === 'HLS' ? 'HLS' : 'HTTP';
      row.playable = !!ev.playable;
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
    runningSources: new Set(), // ★ 并行搜索：仍在跑的音源集合（source_start 加、source 出结果删）
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
      // 增强搜索（实验）：true 时 bridge 走 musicsquare 式第三方代理后端
      enhanced: opts.enhanced === true,
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
      // 增强搜索（实验）：true 时 bridge 走 musicsquare 式第三方代理后端
      enhanced: opts.enhanced === true,
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
    currentSources: [...s.runningSources],
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
