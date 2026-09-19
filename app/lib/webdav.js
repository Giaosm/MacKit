/**
 * MacKit · 零依赖 WebDAV 客户端
 *
 * 用 `node:http` / `node:https` 手写 WebDAV 客户端，
 * 覆盖 PROPFIND（列目录）/ PUT（上传）/ GET（下载）/ MKCOL（建目录）/ DELETE（删除），
 * 内部辅以一组**纯函数**负责 URL 归一化 / XML 解析 / 文件名与日期处理。
 *
 * 红线（本模块自行守住，调用方无需关心）：
 *   - 本模块是**纯网络模块**：只 import `node:http` / `node:https` 与 `./exec.js`（取错误载体）。
 *     绝不引入子进程相关模块、绝不 spawn、绝不出现 shell 相关字段。
 *   - 绝不打印任何内容（无 `console.*`）——请求头可能带 Basic 凭据。
 *   - 凭据只经请求头 `Authorization` 传递，绝不出现在 URL 中。
 *
 * 设计要点：
 *   - `request()`：通用封装，支持超时（`req.setTimeout`）与 AbortSignal 取消（`req.destroy`）。
 *   - 错误统一抛 {@link AppError}，code 见 {@link DAV_ERR}（复用 exec.ERR.NET_UNREACHABLE /
 *     TIMEOUT / CANCELLED）。
 *   - `parsePropfind()`：纯正则解析，兼容 `<D:response>` / `<d:response>` / `<ns0:response>` /
 *     `<response>` 四种命名空间写法；解析不到任何条目时返回 `[]`（不抛错）。
 */

import http from 'node:http';
import https from 'node:https';
import { AppError, ERR } from './exec.js';

// ---------------------------------------------------------------------------
// 错误码（server.js 同步补 statusForCode）
// ---------------------------------------------------------------------------
/** WebDAV 专属错误码。 */
export const DAV_ERR = Object.freeze({
  CONFIG: 'WEBDAV_CONFIG',           // 未配置 url
  AUTH: 'WEBDAV_AUTH',               // 401
  FORBIDDEN: 'WEBDAV_FORBIDDEN',     // 403
  NOT_FOUND: 'WEBDAV_NOT_FOUND',     // 404
  UNSUPPORTED: 'WEBDAV_UNSUPPORTED', // 405（服务器不支持 PROPFIND/MKCOL）
  CONFLICT: 'WEBDAV_CONFLICT',       // 409（父集合缺失）/ MKCOL 父级不存在
  NO_SPACE: 'WEBDAV_NO_SPACE',       // 507 Insufficient Storage
  TLS: 'WEBDAV_TLS',                 // 证书校验失败
  PARSE: 'WEBDAV_PARSE',             // 返回体非预期（登录页 HTML 等）
  NAME: 'WEBDAV_NAME',               // 文件名不合法（守卫拦截）
});

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
/** MacKit 在 WebDAV 根下的固定子集合名。 */
const REMOTE_FOLDER = 'MacKit';

/** 备份文件名精确正则（删除 / 恢复前必经守卫）。 */
const BACKUP_NAME_RE = /^mackit-backup-\d{8}-\d{6}\.json$/;

/** PROPFIND 请求体（只取需要的三个属性）。 */
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/>' +
  '</d:prop></d:propfind>';

/** 探测 / 轻量请求默认超时（ms）。 */
const DEFAULT_TIMEOUT = 20_000;
/** 传输类请求（PUT / GET）默认超时（ms）。 */
const TRANSFER_TIMEOUT = 120_000;
/** 响应体上限（8MB），避免异常响应撑爆内存。 */
const MAX_BODY = 8_000_000;

// ===========================================================================
// 纯函数
// ===========================================================================

/**
 * 构造 HTTP Basic 认证头（纯函数）。
 * @param {string} [username]
 * @param {string} [password]
 * @returns {string|null} 无凭据返回 null（匿名：不发 Authorization）
 */
function buildBasicAuth(username, password) {
  const u = username == null ? '' : String(username);
  const p = password == null ? '' : String(password);
  if (!u && !p) return null;
  return 'Basic ' + Buffer.from(`${u}:${p}`, 'utf8').toString('base64');
}

function pad2(n) { return String(n).padStart(2, '0'); }

/**
 * 生成本地时间戳备份文件名：`mackit-backup-YYYYMMDD-HHMMSS.json`（本地时间，
 * 与 `BACKUP_NAME_RE` / `parseBackupName` 互相约束）。
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
export function buildBackupName(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  const stamp = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`
    + `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `mackit-backup-${stamp}.json`;
}

/**
 * 是否为 MacKit 标准备份文件名（严格守卫：拒不合法名）。
 * @param {unknown} name
 * @returns {boolean}
 */
export function isAllowedBackupName(name) {
  return typeof name === 'string' && BACKUP_NAME_RE.test(name);
}

/**
 * 解析备份文件名内嵌的本地时间。
 * @param {unknown} name
 * @returns {{ts:number}|null} 非法名 → null
 */
function parseBackupName(name) {
  if (!isAllowedBackupName(name)) return null;
  const m = /^mackit-backup-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.json$/.exec(name);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const ts = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  return Number.isFinite(ts) ? { ts } : null;
}

/**
 * 保证字符串以 `/` 结尾。
 * @param {string} u
 * @returns {string}
 */
function ensureTrailingSlash(u) {
  const s = String(u == null ? '' : u);
  return s.endsWith('/') ? s : s + '/';
}

/**
 * URL 里是否内嵌了 userinfo（形如 `https://user:pass@host/`）。
 *
 * 这些凭据在本模块**不会被使用**（request() 只取 hostname / port / pathname，
 * 认证一律走 Authorization 头），但 backup.js 会把整个 url 打进任务日志、
 * publicWebdav() 还会把它回填到设置弹窗 —— 所以写入口要直接拒绝。
 * @param {unknown} raw
 * @returns {boolean}
 */
export function urlHasCredentials(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s.includes('@')) return false;
  try {
    const u = new URL(s);
    return !!(u.username || u.password);
  } catch { return false; }
}

/**
 * 把用户填写的 WebDAV 地址解析为绝对 URL（纯函数）。
 *
 * 为什么必须包一层：`new URL()` 对非法输入抛的是裸 `TypeError`（无 `code`），
 * 而 server.js 的 `statusForCode()` 只认已知错误码 → 会退化成 **500「服务器内部错误」**，
 * 用户看到的是「服务崩了」而不是「地址填错了」。这里统一转成 WEBDAV_CONFIG（→ 400）。
 *
 * @param {unknown} raw 用户填写的地址
 * @param {string} [label] 出错提示里的对象名
 * @returns {URL} 解析成功的绝对 URL
 * @throws {AppError} code = WEBDAV_CONFIG
 */
function parseDavUrl(raw, label = 'WebDAV 地址') {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) throw new AppError(DAV_ERR.CONFIG, `请先填写${label}`);
  let u;
  try {
    u = new URL(s);
  } catch (err) {
    throw new AppError(DAV_ERR.CONFIG, `${label}无效（需形如 https://主机/路径）`, String(err && err.message));
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError(DAV_ERR.CONFIG, `${label}仅支持 http / https`);
  }
  if (urlHasCredentials(s)) {
    throw new AppError(DAV_ERR.CONFIG, `${label}里不要写账号密码`,
      '请把它们填到「用户名」/「密码」栏：URL 里的 userinfo 不参与认证，还会被写进任务日志');
  }
  return u;
}

/**
 * 在 base 末尾拼接一个已百分号编码的路径段。
 * @param {string} base
 * @param {string} name
 * @returns {string}
 */
function joinUrl(base, name) {
  return ensureTrailingSlash(base) + encodeURIComponent(name);
}

/**
 * 把 PROPFIND 返回的 href 归一化为绝对 URL（纯函数）。
 * @param {string} href
 * @param {string} baseUrl
 * @returns {string|null}
 */
function resolveHref(href, baseUrl) {
  const raw = String(href || '').trim();
  if (raw === '') return null;
  try {
    if (/^https?:\/\//i.test(raw)) return new URL(raw).href;          // 已是绝对 URL
    const base = new URL(baseUrl);
    if (raw.startsWith('/')) return new URL(raw, base.origin).href;   // 绝对路径 → 补 origin
    return new URL(raw, ensureTrailingSlash(baseUrl)).href;           // 相对 → 相对 base
  } catch { return null; }
}

/**
 * 解析 RFC1123 日期（WebDAV getlastmodified）。
 * @param {string} s
 * @returns {number|null} 毫秒时间戳 / null
 */
function parseDavHttpDate(s) {
  const t = new Date(String(s == null ? '' : s)).getTime();
  return Number.isFinite(t) ? t : null;
}

/** 去掉 XML 声明 / 注释 / BOM。 */
function preprocess(xml) {
  let s = String(xml == null ? '' : xml);
  s = s.replace(/^\uFEFF/, '');
  s = s.replace(/<\?xml[\s\S]*?\?>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  return s;
}

/** 解码 XML 常见实体（&amp; 必须最后处理）。 */
function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** 去掉 XML CDATA 包裹（无 CDATA 时返回 trim 后原文）。 */
function stripCdata(s) {
  const v = String(s == null ? '' : s).trim();
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(v);
  return m ? m[1] : v;
}

/**
 * 取块的某个子元素文本（局部名匹配 + 前缀反引用，兼容带/不带命名空间前缀）。
 * @param {string} block
 * @param {string} local 局部名（如 'href' / 'response'）
 * @returns {string|null} 有开闭标签 → 内文；自闭合 → 空串；不存在 → null
 */
function pick(block, local) {
  const m = new RegExp(
    `<((?:[\\w.-]+:)?)${local}\\b[^>]*>([\\s\\S]*?)<\\/\\1${local}\\s*>`, 'i').exec(block);
  if (m) return m[2];
  const selfClose = new RegExp(`<(?:[\\w.-]+:)?${local}\\b[^>]*/\\s*>`, 'i');
  return selfClose.test(block) ? '' : null;
}

function safePathname(url) {
  try { return new URL(url).pathname; } catch { return ''; }
}

function extractName(absUrl) {
  try {
    const segs = new URL(absUrl).pathname.split('/').filter(Boolean);
    const last = segs.pop();
    if (last == null || last === '') return null;
    try { return decodeURIComponent(last); } catch { return last; }
  } catch { return null; }
}

/** 判断某 response 块是否为集合（目录）。 */
function isCollection(block) {
  const rt = pick(block, 'resourcetype');
  if (rt == null) return false;
  return /<\S*collection\b/i.test(rt);
}

/**
 * 解析 PROPFIND 的 207 Multi-Status 响应体（纯正则，不引 XML 库）。
 *
 * 兼容 `<D:response>` / `<d:response>` / `<ns0:response>` / `<response>`；
 * 只保留 `mackit-backup-YYYYMMDD-HHMMSS.json` 形态的文件条目，按 lastModified 倒序；
 * XML 为空 / 不含任何 `<response>`（如 404 的 HTML 页面）→ 返回 `[]`（不抛错）。
 *
 * @param {string} xml
 * @param {string} baseUrl 请求目录的绝对 URL
 * @returns {Array<{name:string,url:string,lastModified:number|null,size:number|null}>}
 */
function parsePropfind(xml, baseUrl) {
  const body = preprocess(xml);
  const base = String(baseUrl == null ? '' : baseUrl);
  const basePath = safePathname(base);
  const baseNormalized = basePath ? basePath.replace(/\/+$/, '') : '';
  const out = [];

  const re = /<(?:[\w.-]+:)?response\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?response>/gi;
  let m;
  while ((m = re.exec(body)) !== null) {
    const block = m[1];

    let href = pick(block, 'href');
    if (href == null) continue;
    href = stripCdata(href).replace(/<[^>]*>/g, '');
    href = decodeEntities(href).trim();
    if (!href) continue;

    const url = resolveHref(href, base);
    if (!url) continue;

    const name = extractName(url);
    if (name == null) continue;

    // 只认自己的备份文件；目录与集合自身一律丢弃
    if (isCollection(block)) continue;
    if (!isAllowedBackupName(name)) continue;
    const entryPath = safePathname(url);
    if (entryPath && entryPath.replace(/\/+$/, '') === baseNormalized) continue;

    const lastRaw = pick(block, 'getlastmodified');
    let lastModified = lastRaw != null ? parseDavHttpDate(decodeEntities(stripCdata(lastRaw)).trim()) : null;

    const sizeRaw = pick(block, 'getcontentlength');
    const size = sizeRaw != null && /^\d+$/.test(sizeRaw.trim()) ? Number(sizeRaw.trim()) : null;

    // lastModified 缺失 → 回落到文件名内嵌时间
    if (lastModified == null) {
      const parsed = parseBackupName(name);
      lastModified = parsed ? parsed.ts : null;
    }

    out.push({ name, url, lastModified, size });
  }

  out.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
  return out;
}

// ===========================================================================
// 网络层
// ===========================================================================

/** 证书类错误码集合。 */
const TLS_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
]);

/**
 * 把底层网络异常分类为带语义错误码的 AppError。
 * @param {unknown} err
 * @returns {import('./exec.js').AppError}
 */
function classifyError(err) {
  if (err instanceof AppError) return err;
  const code = err && err.code ? String(err.code) : '';
  const name = err && err.name ? String(err.name) : '';
  if (code === 'ABORT_ERR' || name === 'AbortError') {
    return new AppError(ERR.CANCELLED, '已取消');
  }
  if (code.startsWith('ERR_SSL') || TLS_CODES.has(code)) {
    return new AppError(
      DAV_ERR.TLS,
      '证书校验失败（自建 NAS 使用自签名证书时，可在「WebDAV 设置」中开启「允许自签名证书」）',
      code,
    );
  }
  if (code === 'ECONNREFUSED') {
    return new AppError(ERR.NET_UNREACHABLE, '无法连接服务器（连接被拒绝），请检查地址与端口', code);
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new AppError(ERR.NET_UNREACHABLE, '无法解析服务器域名，请检查网络与地址', code);
  }
  if (code === 'ETIMEDOUT') {
    return new AppError(ERR.TIMEOUT, '连接超时，请检查网络后重试', code);
  }
  const msg = err && err.message ? String(err.message) : String(err);
  return new AppError(ERR.NET_UNREACHABLE, `网络请求失败：${msg}`, code || undefined);
}

/**
 * 把 HTTP 非成功状态映射为带语义错误码的 AppError。
 * @param {number} status
 * @param {{body?:Buffer}} res
 * @returns {import('./exec.js').AppError}
 */
function httpError(status, res) {
  const detail = res && res.body ? res.body.toString('utf8').slice(0, 300).trim() : '';
  switch (status) {
    case 401: return new AppError(DAV_ERR.AUTH, '认证失败：用户名或密码不正确', detail);
    case 403: return new AppError(DAV_ERR.FORBIDDEN, '无权限访问该目录', detail);
    case 404: return new AppError(DAV_ERR.NOT_FOUND, '路径不存在', detail);
    case 405: return new AppError(DAV_ERR.UNSUPPORTED, '服务器不支持该操作（请确认地址指向 WebDAV 目录）', detail);
    case 409: return new AppError(DAV_ERR.CONFLICT, '目标目录不存在且无法创建', detail);
    case 507: return new AppError(DAV_ERR.NO_SPACE, '服务器存储空间不足', detail);
    default: return new AppError(DAV_ERR.PARSE, `服务器返回异常状态 ${status}（请确认地址指向 WebDAV 目录）`, detail);
  }
}

/** 断言响应状态命中期望集合，否则抛对应错误码。 */
function assertOk(res, okCodes) {
  if (okCodes.includes(res.status)) return;
  throw httpError(res.status, res);
}

/**
 * 通用 HTTP(S) 请求封装（PROPFIND / PUT / GET / MKCOL / DELETE 共用）。
 *
 * @param {string} url 已归一化的绝对 URL
 * @param {{method?:string, headers?:Record<string,string>, body?:string|Buffer,
 *          signal?:AbortSignal, timeoutMs?:number,
 *          username?:string, password?:string, allowInsecureTLS?:boolean}} [opts]
 * @returns {Promise<{status:number, headers:object, body:Buffer}>}
 */
function request(url, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(new AppError(DAV_ERR.CONFIG, 'WebDAV 地址无效', String(err && err.message)));
      return;
    }

    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const method = opts.method || 'GET';
    const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
      ? opts.timeoutMs : DEFAULT_TIMEOUT;

    const headers = { ...(opts.headers || {}) };
    const auth = buildBasicAuth(opts.username, opts.password);
    if (auth) headers.Authorization = auth; // ★ 凭据只经请求头，绝不拼进 URL

    if (opts.signal && opts.signal.aborted) {
      reject(new AppError(ERR.CANCELLED, '已取消'));
      return;
    }

    let settled = false;
    let req = null;

    // 超时由下面 req.setTimeout 的 socket 级超时承担；这里此前还有一个从未被赋值的
    // `timer` 与 clearTimeout 分支，属死代码，2026-09-19 删除。
    const cleanup = () => {
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
    };
    const settle = (fn) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => {
      if (req) {
        try { req.destroy(new AppError(ERR.CANCELLED, '已取消')); } catch { /* ignore */ }
      }
    };

    try {
      req = mod.request({
        method,
        hostname: u.hostname,
        port: u.port || (isHttps ? 443 : 80),
        path: u.pathname + u.search,
        headers,
        rejectUnauthorized: opts.allowInsecureTLS ? false : true, // 仅 https 生效
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            settle(() => reject(new AppError(DAV_ERR.PARSE, '服务器返回内容过大')));
            try { res.destroy(); } catch { /* ignore */ }
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          settle(() => resolve({
            status: res.statusCode || 0,
            headers: res.headers || {},
            body: Buffer.concat(chunks),
          }));
        });
        res.on('error', (err) => settle(() => reject(classifyError(err))));
      });
    } catch (err) {
      settle(() => reject(classifyError(err)));
      return;
    }

    req.setTimeout(timeoutMs, () => {
      try {
        req.destroy(new AppError(ERR.TIMEOUT, `请求超时（>${Math.round(timeoutMs / 1000)}s）`));
      } catch { /* ignore */ }
    });
    req.on('error', (err) => settle(() => reject(classifyError(err))));

    if (opts.signal) opts.signal.addEventListener('abort', onAbort, { once: true });

    if (opts.body !== undefined && opts.body !== null) {
      try { req.write(opts.body); } catch (err) { settle(() => reject(classifyError(err))); return; }
    }
    req.end();
  });
}

/** 从配置构造请求公共参数（凭据 + 自签名开关 + 取消信号）。 */
function cfgAuth(cfg, opts) {
  return {
    username: cfg ? cfg.username : undefined,
    password: cfg ? cfg.password : undefined,
    allowInsecureTLS: !!(cfg && cfg.allowInsecureTLS),
    signal: opts && opts.signal,
  };
}

/**
 * 计算远程集合的绝对 URL：`ensureTrailingSlash(url) + 'MacKit/'`。
 * @param {{url?:string}} cfg
 * @returns {string}
 */
export function remoteDirUrl(cfg) {
  const base = String(cfg && cfg.url ? cfg.url : '').trim();
  if (!base) throw new AppError(DAV_ERR.CONFIG, '请先在「WebDAV 设置」中填写服务器地址');
  return ensureTrailingSlash(base) + REMOTE_FOLDER + '/';
}

/**
 * 对同一目录发一次 PROPFIND（`depth` 为 '0' 探连接 / '1' 列目录）。
 * 两处此前是逐字重复的请求块（只差 Depth 一行），2026-09-19 收敛到这里。
 */
function propfind(dirUrl, depth, cfg, opts = {}) {
  return request(dirUrl, {
    method: 'PROPFIND',
    headers: {
      Depth: String(depth),
      'Content-Type': 'application/xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(PROPFIND_BODY),
    },
    body: PROPFIND_BODY,
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    ...cfgAuth(cfg, opts),
  });
}

/**
 * 探测远程目录是否可访问（PROPFIND Depth:0）。
 * @param {{url?:string}} cfg
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{ok:true}>}
 */
export async function testConnection(cfg, opts = {}) {
  const dirUrl = remoteDirUrl(cfg);
  const res = await propfind(dirUrl, '0', cfg, opts);
  assertOk(res, [200, 207]);
  return { ok: true };
}

/**
 * 列出远程备份记录。
 * @param {{url?:string}} cfg
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{count:number, items:Array<object>}>}
 */
export async function listBackups(cfg, opts = {}) {
  const dirUrl = remoteDirUrl(cfg);
  const res = await propfind(dirUrl, '1', cfg, opts);
  assertOk(res, [200, 207]);
  const items = parsePropfind(res.body.toString('utf8'), dirUrl);
  return { count: items.length, items };
}

/**
 * 幂等创建远程集合（MKCOL，从浅到深逐段）。
 * 201（已建）/ 200 / 204（已存在）/ 405（服务器不支持 MKCOL，视为已存在）均视为成功。
 * @param {{url?:string}} cfg
 * @param {string} dirUrl 目标集合的绝对 URL
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<void>}
 */
export async function ensureCollection(cfg, dirUrl, opts = {}) {
  // 两个地址都源自用户输入 → 统一走 parseDavUrl：非法时给 WEBDAV_CONFIG(400)，
  // 而不是让 new URL 的裸 TypeError 冒到 statusForCode 变成 500。
  const base = parseDavUrl(cfg && cfg.url, 'WebDAV 服务器地址');
  const target = parseDavUrl(dirUrl, 'WebDAV 目录地址');
  const baseSegs = base.pathname.split('/').filter(Boolean);
  const targetSegs = target.pathname.split('/').filter(Boolean);

  const isPrefix = baseSegs.every((s, i) => targetSegs[i] === s);
  const relSegs = isPrefix
    ? targetSegs.slice(baseSegs.length)
    : [targetSegs[targetSegs.length - 1]].filter(Boolean);

  let cur = base.origin + ensureTrailingSlash(base.pathname);
  for (const seg of relSegs) {
    const segUrl = cur + encodeURIComponent(seg) + '/';
    const res = await request(segUrl, {
      method: 'MKCOL',
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
      ...cfgAuth(cfg, opts),
    });
    // 405 = 服务器不支持 MKCOL（目录已存在）→ 视为成功
    if (res.status === 201 || res.status === 200 || res.status === 204 || res.status === 405) {
      cur = segUrl;
      continue;
    }
    throw httpError(res.status, res);
  }
}

/**
 * 上传备份文本（PUT）。遇 409 触发 MKCOL 兜底后重试一次。
 * @param {{url?:string}} cfg
 * @param {string} name 备份文件名（须过 isAllowedBackupName）
 * @param {string} text 备份信封（JSON 文本）
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<{url:string}>}
 */
export async function uploadBackup(cfg, name, text, opts = {}) {
  if (!isAllowedBackupName(name)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
  const dirUrl = remoteDirUrl(cfg);
  const fileUrl = joinUrl(dirUrl, name);
  const body = String(text);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body, 'utf8'),
  };
  const timeoutMs = opts.timeoutMs ?? TRANSFER_TIMEOUT;

  let res = await request(fileUrl, { method: 'PUT', headers, body, timeoutMs, ...cfgAuth(cfg, opts) });
  if (res.status === 409) {
    // 父集合缺失 → MKCOL 兜底 → 重试 PUT 一次
    await ensureCollection(cfg, dirUrl, opts);
    res = await request(fileUrl, { method: 'PUT', headers, body, timeoutMs, ...cfgAuth(cfg, opts) });
  }
  assertOk(res, [200, 201, 204]);
  return { url: fileUrl };
}

/**
 * 下载备份文本（GET）。
 * @param {{url?:string}} cfg
 * @param {string} name
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<string>}
 */
export async function downloadBackup(cfg, name, opts = {}) {
  if (!isAllowedBackupName(name)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
  const fileUrl = joinUrl(remoteDirUrl(cfg), name);
  const res = await request(fileUrl, {
    method: 'GET',
    timeoutMs: opts.timeoutMs ?? TRANSFER_TIMEOUT,
    ...cfgAuth(cfg, opts),
  });
  assertOk(res, [200]);
  return res.body.toString('utf8');
}

/**
 * 删除远程备份（DELETE）。404 视为「已不存在」，不抛错。
 * @param {{url?:string}} cfg
 * @param {string} name
 * @param {{signal?:AbortSignal, timeoutMs?:number}} [opts]
 * @returns {Promise<void>}
 */
export async function deleteBackup(cfg, name, opts = {}) {
  if (!isAllowedBackupName(name)) throw new AppError(DAV_ERR.NAME, '备份文件名不合法');
  const fileUrl = joinUrl(remoteDirUrl(cfg), name);
  const res = await request(fileUrl, {
    method: 'DELETE',
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT,
    ...cfgAuth(cfg, opts),
  });
  if (res.status === 404) return; // 已不存在 = 达成目标
  assertOk(res, [200, 204]);
}
