/**
 * MacKit · HTTP 边界
 *
 *   - 仅监听 127.0.0.1；端口从 18080 起，EADDRINUSE 则 +1 顺延
 *   - 静态托管 web/（Cache-Control: no-store，零外部资源）
 *   - REST 路由（统一包裹 { ok, data } / { ok, error }）
 *   - SSE 挂载（hello 快照 + Last-Event-ID 补齐 + 15s 心跳）
 *   - confirm 二次确认基座（destructive 动作强制 confirm:true）
 *   - /api/ 来源校验：Host 必须是回环主机名、Origin（若有）必须与 Host 同源 —— 防 CSRF / DNS rebinding
 *   - /api/shutdown 优雅退出（取消运行中任务 → 关 SSE → 关服务 → 退出 → 删 runtime.json）
 *
 * 本文件不做业务逻辑；功能模块通过「动态导入 + 注册表」接入：
 *   - 每个模块默认导出 ModuleDefinition：{ id, actions, queries? }
 *   - actions[action] = { title, destructive?, steps(params, ctx), finalize? }
 *   - queries[queryName] = (params) => Promise<data>（本文件约定的只读查询扩展点）
 *   模块文件缺失时该模块相关接口返回 501，不影响服务启动。
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import * as paths from './lib/paths.js';
import * as store from './lib/store.js';
import * as runner from './lib/runner.js';
import * as env from './lib/env.js';
import { AppError, ERR, toErrObj, hasLiveChildren, spawnDetached } from './lib/exec.js';
import { DAV_ERR, urlHasCredentials } from './lib/webdav.js';
import { parseReqUrl } from './lib/requrl.js';
import {
  openUpstream,
  buildStreamResponseHeaders,
  buildCoverResponseHeaders,
  contentTypeForExt,
  parseRangeHeader,
} from './lib/music/stream.js';

/** 版本号（读取 package.json，失败回落）。 */
function readVersion() {
  try {
    const obj = JSON.parse(fs.readFileSync(path.join(paths.APP_DIR, 'package.json'), 'utf8'));
    return typeof obj.version === 'string' ? obj.version : '1.0.0';
  } catch { return '1.0.0'; }
}
const VERSION = readVersion();

function log(...args) { console.log('[MacKit]', ...args); } // 被启动器重定向到 ~/.mackit/server.out

// ------------------------------ 功能模块注册表（动态接入） ------------------------------
const MODULE_FILES = Object.freeze({ brew: 'brew.js', sysinit: 'sysinit.js', rime: 'rime.js', unseal: 'unseal.js', backup: 'backup.js', dsh: 'dsh.js', selfupdate: 'selfupdate.js', music: 'music.js' });
const registry = new Map();

async function loadModules() {
  for (const [id, file] of Object.entries(MODULE_FILES)) {
    try {
      const mod = await import(new URL(`./lib/${file}`, import.meta.url));
      const def = mod && mod.default;
      if (def && def.actions && typeof def.actions === 'object') { registry.set(id, def); log(`已加载模块：${id}`); }
      else log(`模块 ${id} 缺少 actions，跳过`);
    } catch (err) {
      log(`模块 ${id} 未加载（${err && err.message}）`);
    }
  }
}

/** 调用模块的只读查询。 */
async function queryModule(moduleId, queryName, params) {
  const def = registry.get(moduleId);
  if (!def) throw new AppError(ERR.NOT_FOUND, `模块「${moduleId}」尚未实现`);
  const q = def.queries && def.queries[queryName];
  if (typeof q !== 'function') throw new AppError(ERR.NOT_FOUND, `模块「${moduleId}」未提供查询「${queryName}」`);
  return await q(params || {});
}

// ------------------------------ 响应工具 ------------------------------
/** HTTP 状态码映射（body 结构不变，仅状态码便于排查）。 */
function statusForCode(code) {
  switch (code) {
    case ERR.CONFIRM_REQUIRED: return 400;
    case ERR.CMD_NOT_ALLOWED: return 400;
    case ERR.PARSE_FAILED: return 422;
    case ERR.NOT_FOUND: return 404;
    case ERR.ENV_MISSING: return 409;
    case ERR.CANCELLED: return 409;
    case ERR.AUTH_CANCELLED: return 409;
    case ERR.TIMEOUT: return 504;
    case ERR.NET_UNREACHABLE: return 503;
    case ERR.CMD_FAILED: return 502;
    case ERR.FORBIDDEN: return 403;
    case ERR.IO_ERROR: return 500;
    // WebDAV 备份错误码（见 lib/webdav.js DAV_ERR）
    case DAV_ERR.CONFIG: return 400;
    case DAV_ERR.AUTH: return 401;
    case DAV_ERR.FORBIDDEN: return 403;
    case DAV_ERR.NOT_FOUND: return 404;
    case DAV_ERR.UNSUPPORTED: return 405;
    case DAV_ERR.CONFLICT: return 409;
    case DAV_ERR.NO_SPACE: return 507;
    case DAV_ERR.TLS: return 502;
    case DAV_ERR.PARSE: return 502;
    case DAV_ERR.NAME: return 422;
    default: return 500;
  }
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}
function ok(res, data) { sendJson(res, 200, { ok: true, data }); }
function sendError(res, err) { const obj = toErrObj(err); sendJson(res, statusForCode(obj.code), { ok: false, error: obj }); }

// ------------------------------ 请求体 ------------------------------
const MAX_BODY = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new AppError(ERR.PARSE_FAILED, '请求体过大（>1MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        const obj = JSON.parse(raw);
        resolve(obj && typeof obj === 'object' ? obj : {});
      } catch { reject(new AppError(ERR.PARSE_FAILED, '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

// ------------------------------ 静态文件 ------------------------------
const MIME = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
});

function serveStatic(res, pathname) {
  let rel = pathname.replace(/^\/web\//, '').replace(/^\//, '');
  if (rel === '') rel = 'index.html';
  const target = path.resolve(paths.WEB_DIR, rel);
  if (target !== paths.WEB_DIR && !target.startsWith(paths.WEB_DIR + path.sep)) { // 目录穿越防护
    sendJson(res, 403, { ok: false, error: { code: ERR.NOT_FOUND, message: '禁止访问' } });
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) { sendJson(res, 404, { ok: false, error: { code: ERR.NOT_FOUND, message: '资源不存在' } }); return; }
    const ext = path.extname(target).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Length': data.length });
    res.end(data);
  });
}

// ------------------------------ SSE ------------------------------
const sseClients = new Set();
const HEARTBEAT_MS = 15_000;

function sseFrame(evt, id) {
  let s = '';
  if (id !== undefined && id !== null) s += `id: ${id}\n`;
  return s + `data: ${JSON.stringify(evt)}\n\n`;
}

function handleSse(req, res, taskId, url) {
  const snap = runner.getSnapshot(taskId);
  if (!snap) { sendJson(res, 404, { ok: false, error: { code: ERR.NOT_FOUND, message: '任务不存在' } }); return; }

  const headerId = req.headers['last-event-id'];
  const queryId = url.searchParams.get('lastEventId');
  const lastEventId = Number.parseInt(String(headerId || queryId || '0'), 10) || 0;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');

  const backlog = (snap.logs || []).filter((l) => l.seq > lastEventId);
  const lastSeq = backlog.length > 0 ? backlog[backlog.length - 1].seq : lastEventId;
  res.write(sseFrame({ type: 'hello', taskId, backlog, task: snap.task }, lastSeq));
  sseClients.add(res);

  const heartbeat = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, HEARTBEAT_MS);
  if (heartbeat.unref) heartbeat.unref();

  let closed = false;
  let unsubscribe = () => {};
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    sseClients.delete(res);
    try { unsubscribe(); } catch { /* ignore */ }
  };

  // 任务已终态：发完 hello 直接收尾
  if (runner.isFinished(taskId)) {
    try { res.write(sseFrame({ type: 'done', taskId, task: snap.task }, lastSeq)); } catch { /* ignore */ }
    cleanup();
    try { res.end(); } catch { /* ignore */ }
    return;
  }

  unsubscribe = runner.subscribe(taskId, (evt) => {
    if (closed) return;
    try {
      const id = evt.type === 'log' && evt.line ? evt.line.seq : undefined;
      res.write(sseFrame(evt, id));
      if (evt.type === 'done') { cleanup(); res.end(); }
    } catch {
      cleanup();
      try { res.end(); } catch { /* ignore */ }
    }
  });
  res.on('close', cleanup);
  req.on('close', cleanup);
}

// ------------------------------ 音乐：在线播放 / 封面 / 歌词 ------------------------------
/**
 * 把上游响应流式透传给客户端：统一的 `writeHead` + 错误/关闭收尾 + `pipe`。
 *
 * 抽出 handleMusicStream / handleMusicCover 共享的骨架，保证 status / header / abort 语义一致：
 * 任何一路（上游 error / 客户端 close）触发即 `abort()` 上游、跑一次 `onCleanup`、`res.end()` 收尾。
 * @param {{abort:()=>void, stream:NodeJS.ReadableStream}} upstream openUpstream 的返回值
 * @param {import('node:http').ServerResponse} res
 * @param {{status:number, headers:Record<string,string>, onData?:(chunk:Buffer)=>void, onEnd?:()=>void, onCleanup?:()=>void}} opts
 */
function pipeUpstream(upstream, res, opts) {
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { upstream.abort(); } catch { /* ignore */ }
    if (opts.onCleanup) { try { opts.onCleanup(); } catch { /* ignore */ } }
    try { res.end(); } catch { /* ignore */ } // 上游中断（error）时收尾响应
  };
  res.writeHead(opts.status, opts.headers);
  if (opts.onData) upstream.stream.on('data', opts.onData);
  if (opts.onEnd) upstream.stream.on('end', opts.onEnd);
  upstream.stream.on('error', cleanup);
  res.on('close', cleanup);
  upstream.stream.pipe(res);
}

/**
 * 音频缓存文件名的白名单（纵深防御）。
 *
 * key 由 `music.js:audioCacheKey()` 生成，形状 `snd-<32hex>.<ext>`。这里再校验一次的原因：
 * 这个值最终会被 `path.join` 拼成路径、被 `fs.rmSync` / `renameSync` 操作 —— 任何
 * 上游（bridge.py 的 ext）没洗干净的情况都不该升级成「任意路径删除 / 写入」。
 * @type {RegExp}
 */
const AUDIO_CACHE_KEY_RE = /^snd-[0-9a-f]{32}\.[A-Za-z0-9]{1,8}$/;

/** 解析缓存文件路径；key 非法 / 文件不存在 / 长度为 0 → null。 */
function audioCachePathIfPresent(cacheKey) {
  const key = String(cacheKey || '');
  if (!AUDIO_CACHE_KEY_RE.test(key)) return null;
  try {
    const p = path.join(paths.MUSIC_AUDIO_CACHE_DIR, key);
    const st = fs.statSync(p);
    if (!st.isFile() || st.size <= 0) return null;
    return { path: p, size: st.size };
  } catch { return null; }
}

/** 原子替换：先删目标再 rename；被 macOS 拒（EPERM，脱离终端的常驻进程常见）则降级为复制。 */
function promoteFile(tmp, target) {
  try {
    fs.rmSync(target, { force: true });
    fs.renameSync(tmp, target);
    return true;
  } catch (err) {
    if (err && (err.code === 'EPERM' || err.code === 'EXDEV')) {
      // 与 store.js writeJsonSafe / rime.js 同款降级：这台 macOS 上常驻进程 rename 会被拒。
      try { fs.copyFileSync(tmp, target); fs.rmSync(tmp, { force: true }); return true; }
      catch { return false; }
    }
    return false;
  }
}

/**
 * 边听边存：整段播放时把上游字节同时写进 `MUSIC_AUDIO_CACHE_DIR/<key>.part`。
 *
 * ★ 2026-09-21 重写，修掉三个真实缺陷（此前实测 15 个 `.part` = 401MB 却没有一个成品文件）：
 *   1) **没有背压**：`cacheStream.write()` 的返回值被忽略，磁盘慢时 Node 会在内存里
 *      无限堆积上游数据。现在 write 返回 false 时调用方暂停上游，drain 后恢复。
 *   2) **finish / cleanup 赛跑**：`res.on('close')` 触发的 onCleanup 可能早于
 *      `end()` 的回调执行，`.part` 刚改名就被删（或反之），成品永远落不下来。
 *      现在用 `ended` 标记：只要正文收完就不再删 `.part`。
 *   3) **残片被当成成品**：断流时也会走到 onEnd；现在拿上游声明的 Content-Length 自证，
 *      长度不符就不提升为缓存（避免播放器拿到截断文件）。
 *   4) rename EPERM 无降级 → 走 promoteFile 的复制兜底。
 * @param {string} cacheKey
 */
function createAudioCacheWriter(cacheKey) {
  let stream = null;
  let partPath = null;
  let finalPath = '';
  let written = 0;
  let ended = false;
  let finalized = false;
  const dropPart = () => { if (partPath) { try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ } } };
  try {
    fs.mkdirSync(paths.MUSIC_AUDIO_CACHE_DIR, { recursive: true });
    finalPath = path.join(paths.MUSIC_AUDIO_CACHE_DIR, cacheKey);
    partPath = `${finalPath}.part`;
    stream = fs.createWriteStream(partPath);
    stream.on('error', () => { try { stream.destroy(); } catch { /* ignore */ } stream = null; });
  } catch { stream = null; }

  return {
    /** 是否真的在写（创建流失败 / 出错后为 false）。 */
    get active() { return !!stream; },
    /** 写一块数据；返回 false = 缓存侧需背压（调用方应暂停上游，并在 onDrain 后恢复）。 */
    write(chunk, onDrain) {
      if (!stream) return true;
      written += chunk.length;
      let ok = true;
      try { ok = stream.write(chunk); } catch { ok = false; }
      if (ok === false && typeof onDrain === 'function') stream.once('drain', onDrain);
      return ok;
    },
    /** 正文收完 → 校验长度后把 `.part` 提升为正式缓存文件。 */
    finish(contentLength, onDone) {
      if (!stream) { if (onDone) onDone(false); return; }
      ended = true;
      const s = stream;
      stream = null;
      s.end(() => {
        const declared = Number.parseInt(contentLength, 10);
        if (Number.isFinite(declared) && declared > 0 && written !== declared) {
          dropPart(); // 断流残片
          if (onDone) onDone(false);
          return;
        }
        const ok = promoteFile(partPath, finalPath);
        finalized = ok;
        if (!ok) dropPart();
        if (onDone) onDone(ok);
      });
    },
    /** 结束 / 失败清理：正文没收完才删 `.part`（见上方「赛跑」注释）。 */
    cleanup() {
      if (finalized || ended) return;
      dropPart();
    },
  };
}

/**
 * 从完整缓存文件直接回放（不打网络）。
 * @param {import('node:http').ServerResponse} res
 * @param {{path:string, size:number}} hit
 * @param {string} ext
 */
function serveAudioCache(res, hit, ext) {
  // 触摸 mtime：pruneAudioCache 是按 mtime 做 LRU 的，命中即说明「最近在用」。
  try { const now = new Date(); fs.utimesSync(hit.path, now, now); } catch { /* ignore */ }
  res.writeHead(200, {
    'Content-Type': contentTypeForExt(ext),
    'Content-Length': String(hit.size),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
  });
  const rs = fs.createReadStream(hit.path);
  rs.on('error', () => { try { res.destroy(); } catch { /* ignore */ } });
  res.on('close', () => { try { rs.destroy(); } catch { /* ignore */ } });
  rs.pipe(res);
}

/**
 * 处理 `GET /api/music/stream/:id/:uid`。
 *
 * ★ 成功 = **裸二进制流**（不走 `{ok,data}` 包络）；失败 = JSON 包络。
 * ★ SSRF 口径：url 只来自「快照内 uid 解析结果」（`streamMeta` 查询），路由**绝不接受任何外部 url 入参**。
 * ★ 边听边存：仅整段播放（无 Range 或 Range 从 0 起）才 tee 到 `MUSIC_AUDIO_CACHE_DIR/<key>.part`，
 *   结束 rename；整段播放**优先命中已有缓存**（不再回源）。
 */
async function handleMusicStream(req, res, id, uid) {
  const meta = await queryModule('music', 'streamMeta', { id, uid });
  const range = req.headers.range;
  const parsedRange = parseRangeHeader(range);
  const isFull = !range || !!(parsedRange && parsedRange.isFull);

  // 边听边存的下半场（2026-09-21 修）：此前只写不读 —— 缓存白占磁盘，二次播放仍回源。
  // 只在「整段播放」时命中：带 Range 的拖动需要重算 Content-Range，交给上游更稳。
  if (isFull && meta.cacheKey) {
    const hit = audioCachePathIfPresent(meta.cacheKey);
    if (hit) { serveAudioCache(res, hit, meta.ext); return; }
  }

  const up = await openUpstream({
    url: meta.url,
    headers: meta.headers,
    range,
    channel: meta.channel,
    proxies: meta.proxies,
  });
  if (up.status >= 400) {
    try { up.abort(); } catch { /* ignore */ }
    throw new AppError(ERR.CMD_FAILED, `上游返回错误状态（${up.status}）`);
  }
  if (up.status !== 200 && up.status !== 206) {
    // 仅承认 200（整段）与 206（Range）为成功；重定向 / 1xx 等一律按上游异常处理。
    try { up.abort(); } catch { /* ignore */ }
    throw new AppError(ERR.CMD_FAILED, `上游返回非预期状态（${up.status}）`);
  }

  const built = buildStreamResponseHeaders({ status: up.status, upstreamHeaders: up.headers, ext: meta.ext });

  // 边听边存：仅整段播放才缓存（Range 分片不落缓存）。
  const cache = isFull && meta.cacheKey ? createAudioCacheWriter(meta.cacheKey) : null;

  pipeUpstream(up, res, {
    status: built.status,
    headers: built.headers,
    onData: (chunk) => {
      if (!cache) return;
      // 缓存写不动了 → 暂停上游（playback 一起慢下来），drain 后恢复；不这样做
      // 磁盘慢的时候上游字节会在 Node 堆里无限堆积。
      const ok = cache.write(chunk, () => { try { up.stream.resume(); } catch { /* ignore */ } });
      if (!ok) { try { up.stream.pause(); } catch { /* ignore */ } }
    },
    onEnd: () => {
      if (cache) cache.finish(up.headers && up.headers['content-length'], () => { /* 缓存失败不影响播放 */ });
    },
    onCleanup: () => {
      // 只在「正文没收完」时清 .part：收完后 finish 正在改名，抢着删会把成品删掉。
      if (cache) cache.cleanup();
    },
  });
}

/**
 * 处理 `GET /api/music/cover/:id/:uid`：成功 = 图片字节（透传 Content-Type）+ 长缓存；无封面 / uid 不存在 = 404。
 * 同样遵守 SSRF 口径（封面 url 只来自快照解析结果）。
 */
async function handleMusicCover(req, res, id, uid) {
  const meta = await queryModule('music', 'streamMeta', { id, uid });
  if (!meta.hasCover || !meta.coverUrl) throw new AppError(ERR.NOT_FOUND, '该曲目没有可用封面');
  const up = await openUpstream({ url: meta.coverUrl, headers: {}, channel: meta.channel, proxies: meta.proxies });
  if (up.status < 200 || up.status >= 300) {
    try { up.abort(); } catch { /* ignore */ }
    throw new AppError(ERR.CMD_FAILED, `封面拉取失败（${up.status}）`);
  }
  const headers = buildCoverResponseHeaders(up.headers);
  pipeUpstream(up, res, { status: 200, headers });
}

// ------------------------------ 路由 ------------------------------

/**
 * 任务 id 白名单，与 runner.newTaskId() 的产物一一对应：`t_<毫秒时间戳>_<6 位小写 hex>`。
 *
 * 为什么必须校验：这些 id 来自 URL，会被 decodeURIComponent 还原，而下游
 * store.readHistory / store.readLog 用 `path.join(目录, `${id}.json`)` 拼路径。
 * 若不校验，`GET /api/history/..%2Fwebdav` 中的 `%2F` 解码后变成 `/`，即可穿越读取
 * ~/.mackit 之外的任意 *.json / *.log（实测能读出 webdav.json 里的明文密码）。
 */
const TASK_ID_RE = /^t_\d+_[0-9a-f]{6}$/;

/**
 * decodeURIComponent 的安全包装：畸形转义（如 `%`、`%zz`、`%E0%A4`）会抛 URIError，
 * 原先会被顶层 catch 兜成 502 CMD_FAILED "URI malformed" —— 不泄露也不挂死，但语义不对。
 * 这类输入本质是「路径里的 id 不存在」，统一转成 NOT_FOUND（404）。
 * @param {string} raw URL 路径段（未解码）
 * @param {string} [message='未找到该目标'] 面向用户的 404 文案
 * @returns {string} 解码后的字符串
 */
function safeDecode(raw, message = '未找到该目标') {
  try { return decodeURIComponent(raw); }
  catch { throw new AppError(ERR.NOT_FOUND, message); }
}

/** 校验并返回任务 id；不合法一律按「不存在」处理，不泄露路径信息。 */
function requireTaskId(raw) {
  const id = safeDecode(raw, '未找到该任务');
  if (!TASK_ID_RE.test(id)) throw new AppError(ERR.NOT_FOUND, '未找到该任务');
  return id;
}

/**
 * 解析并提交一个「模块动作」任务（POST /api/tasks 与音乐专用路由 /api/music/openFolder 共用）。
 *
 * 校验链：模块存在 → 动作存在且有 steps → destructive 需 confirm → 透传模块 lane（音乐 lane='music'）。
 * 抽成函数是为了让「音乐专用路由」复用同一套语义（尤其 destructive / confirm 判定不重复实现）。
 *
 * @param {{module?:string, action?:string, params?:object, confirm?:boolean}} body 请求体
 * @returns {{taskId:string, task:object}}
 */
function submitModuleAction(body) {
  const moduleId = String((body && body.module) || '');
  const action = String((body && body.action) || '');
  const def = registry.get(moduleId);
  if (!def) throw new AppError(ERR.NOT_FOUND, `模块「${moduleId}」尚未实现`);
  const actionDef = def.actions && def.actions[action];
  if (!actionDef || typeof actionDef.steps !== 'function') throw new AppError(ERR.NOT_FOUND, `未知动作：${moduleId}.${action}`);
  if (actionDef.destructive === true && body.confirm !== true) {
    throw new AppError(ERR.CONFIRM_REQUIRED, '该操作为危险操作，缺少二次确认（confirm:true）');
  }
  // 透传模块声明的 lane：音乐模块 lane='music'，其余模块无 lane → runner 落 default lane。
  const task = runner.submit({
    module: moduleId, action,
    params: body.params && typeof body.params === 'object' ? body.params : {},
    actionDef,
    lane: typeof def.lane === 'string' && def.lane ? def.lane : undefined,
  });
  return { taskId: task.id, task };
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';

  if (method === 'GET' && pathname === '/api/health') {
    const code = checkBackendCode();
    ok(res, {
      ok: true, port: currentPort, pid: process.pid, version: VERSION,
      startedAt: BOOT_AT,
      // 磁盘上的后端代码与本进程加载的不一致 → 前端挂横幅提示重启（见 checkBackendCode 注释）
      needsRestart: code.changed,
      changedFiles: code.files,
      // 前端资源最近改动时刻：页面据此判断「自己是否已过期」（见 latestWebMtime 注释）
      webChangedAt: code.webChangedAt,
    });
    return;
  }

  if (method === 'GET' && pathname === '/api/env') {
    ok(res, await env.snapshot({ force: url.searchParams.get('force') === '1' }));
    return;
  }

  if (pathname === '/api/config' && method === 'GET') { ok(res, { brewgo: store.readBrewgo(), mackit: store.readMackit() }); return; }
  if (pathname === '/api/config' && method === 'PUT') {
    const body = await readBody(req);
    if (body.proxy || body.mirror !== undefined) {
      const cur = store.readBrewgo();
      store.writeBrewgo({
        httpPort: body.proxy && Number.isInteger(body.proxy.httpPort) ? body.proxy.httpPort : cur.httpPort,
        socksPort: body.proxy && Number.isInteger(body.proxy.socksPort) ? body.proxy.socksPort : cur.socksPort,
        // 未显式给 mirror 时传 undefined → writeBrewgo 不改写 MIRROR 行
        // （此前回落 cur.mirror，会把用户自定义的枚举外镜像静默改成 official）
        mirror: typeof body.mirror === 'string' ? body.mirror : undefined,
      });
    }
    if (body.defaultChannel !== undefined || body.autoFallback !== undefined || body.autoCleanup !== undefined || body.lastCheckedAt !== undefined) {
      store.writeMackit({ defaultChannel: body.defaultChannel, autoFallback: body.autoFallback, autoCleanup: body.autoCleanup, lastCheckedAt: body.lastCheckedAt });
    }
    env.invalidate();
    ok(res, { brewgo: store.readBrewgo(), mackit: store.readMackit() });
    return;
  }

  // Homebrew 只读查询
  if (method === 'GET' && pathname === '/api/brew/outdated') { ok(res, await queryModule('brew', 'outdated', {})); return; }
  if (method === 'GET' && pathname === '/api/brew/installed') { ok(res, await queryModule('brew', 'installed', {})); return; }
  if (method === 'GET' && pathname === '/api/brew/info') {
    ok(res, await queryModule('brew', 'info', { kind: url.searchParams.get('kind') || 'cask', name: url.searchParams.get('name') || '' }));
    return;
  }

  // 软件包搜索：kind=cask|formula（缺省 cask），q 为关键词
  if (method === 'GET' && pathname === '/api/brew/package-search') {
    ok(res, await queryModule('brew', 'packageSearch', {
      kind: url.searchParams.get('kind') || 'cask',
      q: url.searchParams.get('q') || '',
    }));
    return;
  }

  // Rime
  if (method === 'GET' && pathname === '/api/rime/status') {
    const r = (await env.snapshot()).rime || {};
    let skinSource = null;
    try { skinSource = (await queryModule('rime', 'skins', {})).source; } catch { skinSource = null; }
    ok(res, {
      status: r.status || null,
      rimeDir: r.dir || null,
      dirExists: !!r.dirExists,
      plumExists: !!r.plumExists,
      mainSchemaExists: !!r.mainSchemaExists,
      squirrelDeployable: !!r.squirrelDeployable,
      squirrelBin: r.squirrelPath || null,
      currentSkin: r.currentSkin || null,
      currentLayout: r.currentLayout || null,
      currentOrientation: r.currentOrientation || null,
      skinSource,
    });
    return;
  }
  if (method === 'GET' && pathname === '/api/rime/skins') { ok(res, await queryModule('rime', 'skins', {})); return; }
  if (method === 'GET' && pathname === '/api/rime/appearance') { ok(res, await queryModule('rime', 'appearance', {})); return; }
  if (method === 'GET' && pathname === '/api/rime/upstream') { ok(res, await queryModule('rime', 'upstream', {})); return; }

  // 系统初始化
  if (method === 'GET' && pathname === '/api/sysinit/state') { ok(res, await queryModule('sysinit', 'state', {})); return; }
  if (method === 'POST' && pathname === '/api/sysinit/alias/preview') {
    const body = await readBody(req);
    ok(res, await queryModule('sysinit', 'aliasPreview', { mode: body.mode || 'keep' }));
    return;
  }

  // DeepSeek Harness（安装状态 / 版本探测；安装本身走任务流 POST /api/tasks）
  if (method === 'GET' && pathname === '/api/dsh/status') { ok(res, await queryModule('dsh', 'status', {})); return; }

  // 音乐模块（只读查询 + 搜索/歌单会话；下载/安装走任务流 POST /api/tasks）
  // deployStatus：四态（not_deployed/broken/deployed/outdated）；/api/music/env 作为旧路径别名保留。
  if (method === 'GET' && (pathname === '/api/music/deployStatus' || pathname === '/api/music/env')) {
    ok(res, await queryModule('music', 'deployStatus', { force: url.searchParams.get('force') === '1' }));
    return;
  }
  if (method === 'GET' && pathname === '/api/music/sources') { ok(res, await queryModule('music', 'sources', {})); return; }
  // musicdl 上游版本（PyPI，24h 缓存；force=1 绕过。纯提示功能：查询内部绝不抛网络错误）
  if (method === 'GET' && pathname === '/api/music/musicdlUpstream') {
    ok(res, await queryModule('music', 'musicdlUpstream', { force: url.searchParams.get('force') === '1' }));
    return;
  }
  if (method === 'GET' && pathname === '/api/music/config') { ok(res, await queryModule('music', 'config', {})); return; }
  if (method === 'PUT' && pathname === '/api/music/config') {
    const body = await readBody(req);
    store.writeMackit({
      musicDownloadDir: body.downloadDir,
      musicNameTemplate: body.nameTemplate,
      musicChannel: body.channel,
      musicSources: body.sources,
      musicSaveLyrics: body.saveLyrics,
      // 增强搜索（实验）：true = 搜索走第三方代理 API（更快、组合词更宽容，但依赖外部服务）
      musicEnhancedSearch: body.enhancedSearch,
      // R0 · 代理配置（v2）：透传三个新增字段；非法地址由 writeMackit 抛 PARSE_FAILED → 422 且不写盘
      musicProxySource: body.proxySource,
      musicProxyHttp: body.proxyHttp,
      musicProxySocks5: body.proxySocks5,
      // 在线播放缓存上限（MB）与下载并发度：非法值由 writeMackit 回落当前值（不抛错）
      musicCacheMaxMb: body.cacheMaxMb,
      musicDownloadConcurrency: body.downloadConcurrency,
    });
    // 缓存上限可能被调小 → 立即按新上限裁剪音频缓存（best-effort，失败不影响响应）。
    try { await queryModule('music', 'pruneAudio', {}); } catch { /* 模块缺失 / 失败忽略 */ }
    ok(res, await queryModule('music', 'config', {}));
    return;
  }
  // 选择下载目录：osascript 弹系统目录框（只读，不写配置；失败前端回落手输）
  // ★ 这是**有可见副作用的 GET**，额外要求请求来自 MacKit 界面本身（防跨站弹窗轰炸）。
  if (method === 'GET' && pathname === '/api/music/chooseFolder') {
    requireUiTriggered(req, '选择下载目录');
    ok(res, await queryModule('music', 'chooseFolder', {}));
    return;
  }
  // 在 Finder 打开下载目录（P0-6）：音乐专用路由，复用 submitModuleAction 的动作语义
  // （open_folder 为普通动作、非 destructive，故无需 confirm）。目录不存在由步骤内自动创建。
  if (method === 'POST' && pathname === '/api/music/openFolder') {
    const body = await readBody(req);
    ok(res, submitModuleAction({
      module: 'music',
      action: 'open_folder',
      params: body && typeof body === 'object' ? body : {},
    }));
    return;
  }
  if (method === 'POST' && pathname === '/api/music/search') {
    const body = await readBody(req);
    ok(res, await queryModule('music', 'search', body));
    return;
  }
  if (method === 'POST' && pathname === '/api/music/playlist') {
    const body = await readBody(req);
    ok(res, await queryModule('music', 'playlist', body));
    return;
  }
  // 取消搜索 / 歌单：id 由 map 校验（非 task id 格式），必须先于下面的轮询路由匹配
  const musicCancelMatch = /^\/api\/music\/search\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && musicCancelMatch) {
    ok(res, await queryModule('music', 'searchCancel', { id: safeDecode(musicCancelMatch[1], '未找到该会话') }));
    return;
  }
  const playlistCancelMatch = /^\/api\/music\/playlist\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && playlistCancelMatch) {
    ok(res, await queryModule('music', 'searchCancel', { id: safeDecode(playlistCancelMatch[1], '未找到该会话') }));
    return;
  }
  const musicPollMatch = /^\/api\/music\/search\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && musicPollMatch) {
    ok(res, await queryModule('music', 'searchPoll', {
      id: safeDecode(musicPollMatch[1], '未找到该会话'),
      since: Number.parseInt(url.searchParams.get('since') || '0', 10) || 0,
    }));
    return;
  }
  // 歌单解析与搜索同构：轮询同一个会话注册表（同一 searchId）
  const playlistPollMatch = /^\/api\/music\/playlist\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && playlistPollMatch) {
    ok(res, await queryModule('music', 'searchPoll', {
      id: safeDecode(playlistPollMatch[1], '未找到该会话'),
      since: Number.parseInt(url.searchParams.get('since') || '0', 10) || 0,
    }));
    return;
  }

  // 在线播放 / 封面 / 歌词（音乐）：id、uid 由 safeDecode 解码（沿用既有方式），
  // 模块内再校验 id 规则；url 一律由快照 uid 解析，**绝不接受任何外部 url 入参**（SSRF 口径）。
  const musicStreamMatch = /^\/api\/music\/stream\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && musicStreamMatch) {
    await handleMusicStream(req, res,
      safeDecode(musicStreamMatch[1], '未找到该歌曲'),
      safeDecode(musicStreamMatch[2], '未找到该歌曲'));
    return;
  }
  const musicCoverMatch = /^\/api\/music\/cover\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && musicCoverMatch) {
    await handleMusicCover(req, res,
      safeDecode(musicCoverMatch[1], '未找到该歌曲'),
      safeDecode(musicCoverMatch[2], '未找到该歌曲'));
    return;
  }
  const musicLyricMatch = /^\/api\/music\/lyric\/([^/]+)\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && musicLyricMatch) {
    // 歌词**全程 JSON 包络**：{ok:true, data:{has, synced, lrc}}；uid 不存在 → 404。
    ok(res, await queryModule('music', 'lyric', {
      id: safeDecode(musicLyricMatch[1], '未找到该歌曲'),
      uid: safeDecode(musicLyricMatch[2], '未找到该歌曲'),
    }));
    return;
  }

  // MacKit 自身更新状态（force=1 绕过 10 分钟缓存，强制 fetch 一次）
  if (method === 'GET' && pathname === '/api/selfupdate/status') {
    ok(res, await queryModule('selfupdate', 'status', { force: url.searchParams.get('force') === '1' }));
    return;
  }

  // 解隔离预检
  if (method === 'GET' && pathname === '/api/unseal/precheck') {
    const raw = url.searchParams.get('paths') || '';
    ok(res, await queryModule('unseal', 'precheck', { paths: raw ? raw.split('|').filter((s) => s.length > 0) : [] }));
    return;
  }

  // 扫描 /Applications：被隔离且无法打开的应用
  if (method === 'GET' && pathname === '/api/unseal/scan') {
    ok(res, await queryModule('unseal', 'scan', {}));
    return;
  }

  // WebDAV 备份（配置 / 列表走同步接口；上传 / 恢复 / 删除走任务流 POST /api/tasks）
  if (method === 'GET' && pathname === '/api/webdav/config') {
    const c = store.publicWebdav();
    ok(res, { ...c, configured: !!c.url });
    return;
  }
  if (method === 'PUT' && pathname === '/api/webdav/config') {
    const body = await readBody(req);
    // URL 里内嵌的 userinfo 不参与认证，却会被写进日志 / 回显前端 → 直接拒绝
    if (urlHasCredentials(body.url)) {
      throw new AppError(ERR.PARSE_FAILED, 'WebDAV 地址里不要写账号密码',
        '请把用户名 / 密码填到下面的对应输入框（URL 里的 userinfo 不参与认证）');
    }
    // password 缺省（未传）→ 保持原密码；显式传 '' → 清空（见 store.writeWebdav）
    store.writeWebdav({
      url: body.url,
      username: body.username,
      password: body.password,
      allowInsecureTLS: body.allowInsecureTLS,
    });
    const c = store.publicWebdav();
    ok(res, { ...c, configured: !!c.url });
    return;
  }
  if (method === 'GET' && pathname === '/api/webdav/backups') { ok(res, await queryModule('backup', 'webdavList', {})); return; }

  // 历史
  if (method === 'GET' && pathname === '/api/history') { ok(res, store.listHistory()); return; }
  const histMatch = /^\/api\/history\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && histMatch) {
    const id = requireTaskId(histMatch[1]);
    // getTask 内部已经「内存优先、回落历史」（见 runner.getTask），此前的 `|| store.readHistory(id)`
    // 是永远走不到的死分支（2026-09-21 收敛为唯一入口）。
    const task = runner.getTask(id);
    if (!task) throw new AppError(ERR.NOT_FOUND, '未找到该任务');
    ok(res, { task, log: store.readLog(id) });
    return;
  }

  // 任务
  if (method === 'POST' && pathname === '/api/tasks') {
    const body = await readBody(req);
    ok(res, submitModuleAction(body));
    return;
  }
  if (method === 'GET' && pathname === '/api/tasks') { ok(res, runner.listTasks()); return; }

  const logMatch = /^\/api\/tasks\/([^/]+)\/log$/.exec(pathname);
  if (method === 'GET' && logMatch) { handleSse(req, res, requireTaskId(logMatch[1]), url); return; }

  const cancelMatch = /^\/api\/tasks\/([^/]+)\/cancel$/.exec(pathname);
  if (method === 'POST' && cancelMatch) {
    const id = requireTaskId(cancelMatch[1]);
    if (!runner.cancel(id)) throw new AppError(ERR.NOT_FOUND, '任务不存在或已结束');
    ok(res, { taskId: id, status: 'cancelled' });
    return;
  }

  const taskMatch = /^\/api\/tasks\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && taskMatch) {
    const id = requireTaskId(taskMatch[1]);
    const task = runner.getTask(id);
    if (!task) throw new AppError(ERR.NOT_FOUND, '任务不存在');
    ok(res, task);
    return;
  }

  if (method === 'POST' && pathname === '/api/shutdown') {
    // 与 chooseFolder 同一道闸：这两个动作会「终止正在跑的任务」，不能由任意网页通过
    // 跨站子请求触发（POST 的 Origin 规则已挡住表单，这里再加 Sec-Fetch-Site 一层）。
    requireUiTriggered(req, '关闭服务');
    ok(res, { ok: true });
    log('收到关闭请求，正在优雅退出…');
    setTimeout(() => { gracefulShutdown('api'); }, 100);
    return;
  }

  // 受控重启：拉起一个新的 detached 服务进程后本进程退出（供「更新 MacKit 后立即重启」使用）。
  // 语义上等于「关闭服务 + 重新双击 MacKit.command」，但不需要用户去 Dock / Finder 里操作。
  if (method === 'POST' && pathname === '/api/restart') {
    requireUiTriggered(req, '重启服务');
    if (restarting) throw new AppError(ERR.CMD_FAILED, '重启已在进行中，请稍候');
    restarting = true;
    ok(res, { ok: true, willRestart: true });
    log('收到重启请求：将拉起新服务进程后退出当前进程…');
    setTimeout(() => { restartService(); }, 100);
    return;
  }

  throw new AppError(ERR.NOT_FOUND, `未知接口：${method} ${pathname}`);
}

/**
 * 本机来源校验（防 CSRF / DNS rebinding）。
 *
 * 服务只绑回环地址，但**浏览器里任意网页都能向 http://127.0.0.1:18080 发请求**：
 * 简单请求不触发 CORS 预检，请求会真的送达并被处理（只是响应体读不到）。所以必须自己看两个头：
 *   · Host   —— 必须是回环主机名。挡 DNS rebinding：evil.com 解析到 127.0.0.1 时
 *               Host 仍是 evil.com，浏览器就认为同源、连响应体也能读走。
 *   · Origin —— 若存在，必须与 Host **同源（含端口）**。挡跨站 fetch / 表单 POST。
 *
 * 刻意宽松之处：**缺 Origin 头一律放行**。curl、HTTP/1.0 客户端、同源顶层导航都不发它，
 * 而这些场景本就没有「被第三方网页利用」的风险。
 *
 * 只校验 `/api/`：静态资源是本地代码、不含任何密钥，没必要让浏览器中途吃 403。
 */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function checkApiOrigin(req) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (hostname && !LOOPBACK_HOSTS.has(hostname)) {
    throw new AppError(ERR.FORBIDDEN, '仅允许从本机访问');
  }
  const origin = req.headers.origin;
  if (origin === undefined) return;
  if (origin === 'null') throw new AppError(ERR.FORBIDDEN, '来源不被允许');
  let o;
  try { o = new URL(origin); } catch { throw new AppError(ERR.FORBIDDEN, '来源不被允许'); }
  if (o.host.toLowerCase() !== host.toLowerCase()) throw new AppError(ERR.FORBIDDEN, '来源不被允许');
}

/**
 * 要求该请求**确由 MacKit 界面发起**（用于带可见副作用的 GET 路由）。
 *
 * ★ 为什么单独要一道闸（2026-09-21 修）：`checkApiOrigin` 刻意「缺 Origin 一律放行」，
 *   但跨站 `<img src="http://127.0.0.1:18080/api/...">` 这类子资源请求**根本不带 Origin**，
 *   于是任意网页都能反复触发 `/api/music/chooseFolder`（弹系统目录框）—— 弹窗轰炸 / DoS。
 *   浏览器会为这类请求带上 `Sec-Fetch-Site`，用它区分：
 *     · same-origin / none（界面内 fetch、用户在地址栏直接打开）→ 放行；
 *     · 其它（cross-site / same-site）→ 拒绝。
 *   完全没有该头的客户端（curl、老浏览器）回落到原来的 Origin 规则，命令行用法不受影响。
 * @param {import('node:http').IncomingMessage} req
 * @param {string} what 用于错误文案的动作名
 */
function requireUiTriggered(req, what) {
  const site = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (site === 'same-origin' || site === 'none') return;
  if (site) throw new AppError(ERR.FORBIDDEN, `仅允许从 MacKit 界面发起该操作（${what}）`);
  const origin = req.headers.origin;
  if (origin === undefined) return;
  checkApiOrigin(req);
}

async function handler(req, res) {
  try {
    // 解析必须放在 try 内：`new URL('//', base)` 会抛 Invalid URL（`//` 被当作
    // protocol-relative 的权威段）。若在 try 外解析，畸形路径（GET //、///…）会让异常
    // 逃出 catch → 连接永不返回（挂死）+ stderr 打印未处理的 Promise 拒绝。
    // parseReqUrl 会先把开头的连续斜杠折叠为单个 '/' 再解析，兜住这类畸形输入。
    const url = parseReqUrl(req.url, `http://${paths.LOOPBACK}`);
    if (url.pathname.startsWith('/api/')) { checkApiOrigin(req); await handleApi(req, res, url); }
    else serveStatic(res, url.pathname);
  } catch (err) {
    if (!res.headersSent) sendError(res, err);
    else { try { res.end(); } catch { /* ignore */ } }
  }
}

// ------------------------------ 运行态与生命周期 ------------------------------
let currentPort = 0;
let server = null;
/** 本进程启动时刻（自更新后用于让用户一眼看出「服务是什么时候起来的」）。 */
const BOOT_AT = Date.now();
/** 重启流程互斥标记（见 restartService）。 */
let restarting = false;

function writeRuntime(port) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(paths.RUNTIME_JSON, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }, null, 2), 'utf8');
  } catch (err) { log('写入 runtime.json 失败：', err && err.message); }
}
/**
 * 删除运行态文件。
 * ★ 2026-09-21：只删**属于本进程**的那一份 —— 「重启服务」会先删旧文件、再拉起新进程；
 * 旧进程随后走 process.exit，若这里无条件 rmSync 就会把**新服务刚写好的 runtime.json 删掉**
 * （启动器随后找不到运行态、又会去拉第三个实例）。文件里的 pid 不是自己就一律不动。
 */
function removeRuntime() {
  try {
    const cur = JSON.parse(fs.readFileSync(paths.RUNTIME_JSON, 'utf8'));
    if (cur && typeof cur.pid === 'number' && cur.pid !== process.pid) return;
  } catch { /* 读不到 / 损坏：当作自己那份处理 */ }
  try { fs.rmSync(paths.RUNTIME_JSON, { force: true }); } catch { /* ignore */ }
}

// ------------------------------ 「磁盘代码已换新」检测 ------------------------------
/**
 * 记录本进程启动时**后端代码**在磁盘上的样子，之后每次 /api/health 比对。
 *
 * 为什么需要它：MacKit 的「更新 MacKit」只改磁盘上的文件，常驻服务里的 ES 模块**不会**重新加载
 * （Node 会一直用启动时那份）。而前端 HTML/JS 是每次请求现读磁盘的（见 serveStatic），于是会出现
 * 「按钮文案是新的、行为却是旧的」这种最难排查的状态（2026-09-20 实测踩到：用户点了新版按钮，
 * 实际跑的还是旧版单步动作，索引刷新那两步根本没执行）。
 * 只扫后端：`server.js` + `lib/**` 下的 .js —— 前端 / Python 都是按需读取，改它们不需要重启。
 */
function scanBackendCode(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === 'test' || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { scanBackendCode(full, out); continue; }
    if (!e.name.endsWith('.js')) continue;
    try { const st = fs.statSync(full); out.push([full, st.mtimeMs, st.size]); } catch { /* ignore */ }
  }
  return out;
}
/**
 * `web/` 下前端资源的**最近改动时刻**（毫秒）。
 *
 * 前端文件是每次请求现读磁盘的，但**已经打开的页面**里跑的还是加载那一刻的 JS ——
 * 刷新才会换新。浏览器自己无从得知，所以由后端给出这个时间戳：页面拿它和「自己加载的时刻」
 * 比较，晚于自己就是「页面已过期，请刷新」（见 app.js 的 syncHealthBanners）。
 */
function latestWebMtime(dir, acc = 0) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { acc = latestWebMtime(full, acc); continue; }
    try { const st = fs.statSync(full); if (st.mtimeMs > acc) acc = st.mtimeMs; } catch { /* ignore */ }
  }
  return acc;
}

/** @type {Map<string, string>|null} 启动基线：路径 → `${mtimeMs}:${size}` */
let codeBaseline = null;
function captureCodeBaseline() {
  codeBaseline = new Map(scanBackendCode(paths.APP_DIR).map(([f, m, sz]) => [f, `${m}:${sz}`]));
}
/**
 * 与基线比对。结果缓存 3s（/api/health 被多个标签页按 15s 轮询，没必要每次都 stat 一遍）。
 * @returns {{changed:boolean, files:string[]}}
 */
let codeCheckCache = { at: 0, value: { changed: false, files: [], webChangedAt: 0 } };
function checkBackendCode() {
  if (Date.now() - codeCheckCache.at < 3000) return codeCheckCache.value;
  const changed = [];
  const now = new Map(scanBackendCode(paths.APP_DIR).map(([f, m, sz]) => [f, `${m}:${sz}`]));
  if (codeBaseline) {
    for (const [f, sig] of now) if (codeBaseline.get(f) !== sig) changed.push(path.relative(paths.APP_DIR, f));
    // 新增 / 删除的后端文件也算变化（例如新模块文件）
    for (const f of codeBaseline.keys()) if (!now.has(f)) changed.push(path.relative(paths.APP_DIR, f));
  }
  codeCheckCache = {
    at: Date.now(),
    // mtimeMs 是浮点（含亚毫秒），取整后回给前端 —— 前端拿它和 Date.now() 比较，整数更直观
    value: { changed: changed.length > 0, files: changed.slice(0, 8), webChangedAt: Math.floor(latestWebMtime(paths.WEB_DIR)) },
  };
  return codeCheckCache.value;
}

function waitForIdle(timeoutMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const tick = () => { if (!runner.isBusy() || Date.now() - start > timeoutMs) resolve(); else setTimeout(tick, 150); };
    tick();
  });
}

/** 优雅关闭时等待「当前任务自然结束」的上限（ms）。 */
const GRACEFUL_WAIT_MS = 6_000;

let shuttingDown = false;
/**
 * 优雅关闭：取消运行中任务 → 关 SSE → 关服务 → 退出 → 删 runtime.json。
 * @param {string} reason 触发原因（写日志用）
 * @param {number} [exitCode=0] 退出码（异常路径如未捕获异常传 1）
 */
async function gracefulShutdown(reason, exitCode = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`开始优雅关闭（${reason}）…`);
  await quiesce();
  finishExit(exitCode);
}

/**
 * 「静默」阶段：取消所有在执行的工作、回收子进程、关掉全部 SSE 连接。
 * gracefulShutdown（关闭服务）与 restartService（重启服务）共用同一套动作 ——
 * 重启就是「静默 → 拉起新进程 → 退出旧进程」，不能各自写一份而漂移。
 */
async function quiesce() {
  try {
    // 多 lane 并行：逐个取消所有 lane 上的当前任务（而非仅 default lane 的那一个）。
    const ids = runner.activeTaskIds();
    if (ids.length) {
      for (const id of ids) { try { runner.cancel(id); } catch { /* ignore */ } }
    }

    // ★ 音乐**搜索 / 歌单会话**不经 runner（session.js 直接用 exec.run 起 bridge.py，lane
    //   'music-search'），所以 activeTaskIds() / isBusy() 都看不见它。只凭 runner 状态决定
    //   是否补杀，会在「只有搜索在跑」时 ids.length === 0、整段回收被跳过 → Python 变孤儿。
    //   这里经 registry 动态取模块、用 ?. 调用：模块缺失 / 未加载时完全不影响退出。
    try {
      const music = registry.get('music');
      if (music && typeof music.shutdown === 'function') music.shutdown();
    } catch (err) { log('取消音乐搜索会话失败（继续退出）：', err && err.message); }

    if (ids.length) await waitForIdle(GRACEFUL_WAIT_MS);

    // 等满上限仍未空闲，**或**仍有任何存活子进程（含 runner 看不见的搜索会话）→ 整组 SIGKILL 补一刀。
    // 不能只依赖 exec 内部那个「SIGTERM→3s→SIGKILL」兜底定时器：它带 unref，
    // 而 process.exit 会直接把它连同其它未触发的定时器一起丢掉，忽略 SIGTERM 的子进程就变成孤儿。
    if (runner.isBusy() || hasLiveChildren()) {
      const n = runner.forceKill();
      log(`仍有子进程未结束，已强杀 ${n} 个`);
    }
  } catch (err) { log('关闭前回收任务失败（继续退出）：', err && err.message); }
  for (const res of sseClients) { try { res.end(); } catch { /* ignore */ } }
  sseClients.clear();
}

/** 退出阶段：关监听、删运行态、按退出码结束进程（gracefulShutdown 与重启共用）。 */
function finishExit(exitCode) {
  let exited = false;
  let fallback = null;
  const done = () => {
    if (exited) return; // server.close 回调与兜底定时器都可能触发，只允许退出一次
    exited = true;
    if (fallback) clearTimeout(fallback);
    removeRuntime();
    restarting = false;
    process.exit(exitCode);
  };
  if (server) {
    server.close(() => done());
    // 兜底定时器刻意**不 unref**：unref 过的定时器在事件循环空转时不会触发，
    // 进程会以默认码 0 自然退出，退出码就丢了（uncaughtException 想报 1）。
    // 它由 done() 清理，最长只多等 1.5s。
    fallback = setTimeout(done, 1500);
  } else done();
}

/**
 * 受控重启：静默当前进程 → 删掉自己的运行态 → 拉起一个 detached 的新服务 → 退出。
 *
 * ★ 顺序很关键：
 *   1) 先 quiesce（取消任务 / 关 SSE），再 `server.close()` 并**等它回调**：必须先把 18080 让出来，
 *      否则新进程 listen 会撞 EADDRINUSE 顺延到 18081，用户的地址/书签就全对不上了；
 *   2) 新进程经 exec.spawnDetached（不登记 LIVE_CHILDREN，否则会被我们随后的整组强杀带走）；
 *   3) 起不来时不静默退出：日志写清「请手动双击 app/MacKit.command」，并以非 0 码退出。
 */
async function restartService() {
  log('开始重启服务…');
  try { await quiesce(); } catch (err) { log('重启前静默失败（继续）：', err && err.message); }
  // 等监听套接字真正关闭（最多 3s；quiesce 已结束 SSE，正常情况几十毫秒内返回）
  await new Promise((resolve) => {
    if (!server) { resolve(); return; }
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(); } }, 3000);
    try {
      server.close(() => { if (!settled) { settled = true; clearTimeout(t); resolve(); } });
    } catch { if (!settled) { settled = true; clearTimeout(t); resolve(); } }
  });
  removeRuntime(); // 先删自己那份（新进程会写它自己的），避免旧 pid 残留把启动器引到已死进程

  const serverJs = path.join(paths.APP_DIR, 'server.js');
  // 续写启动器用的同一个日志文件（MacKit.command 里是 $MACKIT_DIR/server.out）
  const outFile = path.join(paths.MACKIT_DIR, 'server.out');
  let pid = 0;
  try {
    pid = spawnDetached('node', [serverJs], {
      cwd: paths.APP_DIR,
      outFile,
      // 让新进程知道自己是「接替旧进程」起的：端口被短暂占住时它会在同一端口上重试，
      // 而不是顺延到 18081（顺延会让用户手里的地址失效）。
      env: { MACKIT_RESTARTED: '1' },
    });
  } catch (err) {
    log('拉起新服务进程失败：', err && err.message);
  }
  if (!pid) {
    // ★ 此刻监听套接字已经关掉了（上面 server.close 过），继续跑等于「进程活着但界面永远连不上」。
    //   明确退出并给出人工恢复指令，好过静默挂死（2026-09-21 实测到的失败模式）。
    log('重启失败：未能启动新的服务进程。请手动双击 app/MacKit.command 重新打开 MacKit');
    process.exit(1);
  }
  log(`已启动新服务进程（pid ${pid}），当前进程退出以完成重启`);
  process.exit(0);
}

// ------------------------------ 启动 ------------------------------
async function main() {
  paths.ensureDirs();
  removeRuntime(); // 清理上一次可能残留的运行态
  captureCodeBaseline(); // 必须在 loadModules 之前：基线 = 即将被加载的那份磁盘代码
  await loadModules();
  // 音乐音频缓存：启动时按配置上限裁剪一次（best-effort，绝不影响服务启动）。
  try { await queryModule('music', 'pruneAudio', {}); } catch { /* 模块缺失 / 失败忽略 */ }
  server = http.createServer(handler);

  let port = paths.DEFAULT_PORT;
  const maxPort = paths.DEFAULT_PORT + 50;

  // 重启场景（MACKIT_RESTARTED=1）：旧进程刚释放端口，新进程可能抢跑几毫秒。
  // 此时**不能**顺延到 18081 —— 用户手里的地址/书签会全部失效，所以先在原端口重试几轮。
  let restartRetries = process.env.MACKIT_RESTARTED === '1' ? 20 : 0;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE' && restartRetries > 0) {
      restartRetries -= 1;
      log(`端口 ${port} 尚未释放（重启接管中），200ms 后重试（剩余 ${restartRetries} 次）`);
      setTimeout(() => server.listen(port, paths.LOOPBACK), 200);
      return;
    }
    if (err && err.code === 'EADDRINUSE' && port < maxPort) {
      port += 1;
      log(`端口被占用，顺延到 ${port}`);
      setTimeout(() => server.listen(port, paths.LOOPBACK), 50);
      return;
    }
    log('服务错误：', err && err.message);
    process.exit(1);
  });

  server.on('listening', () => {
    const addr = server.address();
    currentPort = typeof addr === 'object' && addr ? addr.port : port;
    writeRuntime(currentPort);
    log(`已在 http://${paths.LOOPBACK}:${currentPort} 启动（pid ${process.pid}）`
      + (currentPort !== paths.DEFAULT_PORT ? `  ⚠ ${paths.DEFAULT_PORT} 被占用，已顺延` : ''));
  });

  server.listen(port, paths.LOOPBACK);
}

process.on('SIGINT', () => { gracefulShutdown('SIGINT'); });
process.on('SIGTERM', () => { gracefulShutdown('SIGTERM'); });
process.on('exit', () => { removeRuntime(); });
// 未捕获异常后进程状态已不可信（可能已丢状态、句柄泄漏、半截写盘）。
// 只记日志继续跑 = 让服务带病运行，用户看到的是「时好时坏」而不是明确失败。
// 按 Node 官方建议收敛为「记录 + 回收子进程 + 以非 0 码退出」。
process.on('uncaughtException', (err) => {
  log('未捕获异常，服务即将退出：', err && err.stack ? err.stack : err);
  gracefulShutdown('uncaughtException', 1);
});
// 未处理的 Promise 拒绝仍只记日志：它不影响同步主流程，一个被遗忘的 promise
// 不该让正在跑的任务（可能已执行到第 8 步）半途而废。此处保留原语义，但显式写明。
process.on('unhandledRejection', (err) => { log('未处理的 Promise 拒绝：', err && err.stack ? err.stack : err); });

main().catch((err) => { log('启动失败：', err && err.stack ? err.stack : err); process.exit(1); });
