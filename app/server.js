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
import { AppError, ERR, toErrObj, hasLiveChildren } from './lib/exec.js';
import { DAV_ERR, urlHasCredentials } from './lib/webdav.js';
import { parseReqUrl } from './lib/requrl.js';

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
    ok(res, { ok: true, port: currentPort, pid: process.pid, version: VERSION });
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
  if (method === 'GET' && pathname === '/api/music/config') { ok(res, await queryModule('music', 'config', {})); return; }
  if (method === 'PUT' && pathname === '/api/music/config') {
    const body = await readBody(req);
    store.writeMackit({
      musicDownloadDir: body.downloadDir,
      musicNameTemplate: body.nameTemplate,
      musicChannel: body.channel,
      musicSources: body.sources,
      musicSaveLyrics: body.saveLyrics,
      // R0 · 代理配置（v2）：透传三个新增字段；非法地址由 writeMackit 抛 PARSE_FAILED → 422 且不写盘
      musicProxySource: body.proxySource,
      musicProxyHttp: body.proxyHttp,
      musicProxySocks5: body.proxySocks5,
    });
    ok(res, await queryModule('music', 'config', {}));
    return;
  }
  // 选择下载目录：osascript 弹系统目录框（只读，不写配置；失败前端回落手输）
  if (method === 'GET' && pathname === '/api/music/chooseFolder') {
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
    const task = runner.getTask(id) || store.readHistory(id);
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
    ok(res, { ok: true });
    log('收到关闭请求，正在优雅退出…');
    setTimeout(() => { gracefulShutdown('api'); }, 100);
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

function writeRuntime(port) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(paths.RUNTIME_JSON, JSON.stringify({ port, pid: process.pid, startedAt: Date.now() }, null, 2), 'utf8');
  } catch (err) { log('写入 runtime.json 失败：', err && err.message); }
}
function removeRuntime() { try { fs.rmSync(paths.RUNTIME_JSON, { force: true }); } catch { /* ignore */ } }

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

  let exited = false;
  let fallback = null;
  const done = () => {
    if (exited) return; // server.close 回调与兜底定时器都可能触发，只允许退出一次
    exited = true;
    if (fallback) clearTimeout(fallback);
    removeRuntime();
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

// ------------------------------ 启动 ------------------------------
async function main() {
  paths.ensureDirs();
  removeRuntime(); // 清理上一次可能残留的运行态
  await loadModules();
  server = http.createServer(handler);

  let port = paths.DEFAULT_PORT;
  const maxPort = paths.DEFAULT_PORT + 50;

  server.on('error', (err) => {
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
