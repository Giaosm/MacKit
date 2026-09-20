/**
 * MacKit · 音乐模块 · 在线播放上游抓取与响应头构造（设计 B3）
 *
 * 职责（**纯网络/纯函数**，不含路由与业务查询）：
 *   · 直连（channel!=='proxy'）：`node:https` / `node:http` 手写 GET（**照抄 webdav.js request() 的写法与风格**），
 *     透传 `Range`、固定 `Accept-Encoding: identity`、**自动跟随 3xx 重定向（≤5 跳，仅 http/https）**；
 *   · 代理（channel==='proxy'）：spawn **白名单内** curl（`curl -sS --no-buffer -D - -L --max-redirs 5 …`），
 *     先缓冲至**最终响应头块**结束（重定向时 curl 会输出多块头），解析出 status / Content-Type / Content-Range /
 *     Content-Length，再把剩余字节经 PassThrough pipe 给调用方；
 *   · 纯函数：扩展名 → Content-Type、解析 curl `-D -` 响应头块、构造我方响应头、解析请求 `Range`。
 *
 * ★ SSRF 口径：本模块**只**接受调用方从「快照内 uid 解析结果」得到的 url，且仅放行 http / https；
 *   绝不接受任何外部 url 入参（由上层路由保证）。
 */

import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';

import * as paths from '../paths.js';
import { AppError, ERR } from '../exec.js';

/** 上游抓取默认超时（连接/整体各 30s 级） */
const DEFAULT_UPSTREAM_TIMEOUT_MS = 30_000;

/** 跟随重定向的最大跳数（防重定向环）。 */
const MAX_REDIRECTS = 5;

/** 判定重定向状态码（3xx 且有 Location 才跟随）。 */
function isRedirectStatus(status) {
  return status >= 300 && status < 400;
}

/**
 * 解析重定向目标为绝对 URL，并校验协议白名单（仅 http/https）。
 * @param {string} location 原始 Location 头（可能为相对路径）
 * @param {string} baseUrl 当前 URL（用于补全相对 Location）
 * @returns {URL|null} 合法返回 URL；非法 / 非 http(s) 返回 null
 */
function resolveRedirectUrl(location, baseUrl) {
  const loc = String(location == null ? '' : location).trim();
  if (!loc) return null;
  let u;
  try { u = new URL(loc, baseUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  return u;
}

/**
 * 直连抓取（node:http/https）。resolve 时响应头已到达，body 以 Readable 返回。
 *
 * ★ Bug1：**自动跟随 3xx 重定向**（≤{@link MAX_REDIRECTS} 跳、仅 http/https）。
 *   代理出的部分直链（如 `api.qijieya.cn/meting`）先 302 再跳 CDN，不跟随就会把 302 当上游异常。
 *   跨跳**透传 Range 与其他请求头**（含 Accept-Encoding: identity），最终响应才 resolve。
 */
function openUpstreamDirect({ url, headers, range, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const baseHeaders = { ...(headers || {}) };
    if (range) baseHeaders.Range = String(range);
    baseHeaders['Accept-Encoding'] = 'identity';

    let currentUrl = String(url || '');
    let redirects = 0;

    const doRequest = () => {
      let u;
      try { u = new URL(currentUrl); } catch (err) { reject(new AppError(ERR.CMD_FAILED, '播放直链无效', String(err && err.message))); return; }
      const isHttps = u.protocol === 'https:';
      if (!isHttps && u.protocol !== 'http:') {
        reject(new AppError(ERR.CMD_FAILED, '仅支持 http/https 直链'));
        return;
      }
      const mod = isHttps ? https : http;

      let settled = false;
      let req = null;
      const settle = (fn) => { if (settled) return; settled = true; fn(); };

      try {
        req = mod.request({
          method: 'GET',
          hostname: u.hostname,
          port: u.port || (isHttps ? 443 : 80),
          path: u.pathname + u.search,
          headers: baseHeaders,
          rejectUnauthorized: true,
        }, (res) => {
          const status = res.statusCode || 0;
          const location = res.headers && res.headers.location;
          if (isRedirectStatus(status) && location) {
            // 先排干当前响应体，再对目标重发（GET 语义不变，方法无需切换）
            try { res.resume(); } catch { /* ignore */ }
            if (redirects >= MAX_REDIRECTS) {
              settle(() => reject(new AppError(ERR.CMD_FAILED, `上游重定向次数过多（>${MAX_REDIRECTS}）`)));
              return;
            }
            const next = resolveRedirectUrl(location, currentUrl);
            if (!next) {
              settle(() => reject(new AppError(ERR.CMD_FAILED, '上游重定向目标无效')));
              return;
            }
            redirects += 1;
            currentUrl = next.toString();
            settle(() => { try { req.destroy(); } catch { /* ignore */ } doRequest(); });
            return;
          }
          if (isRedirectStatus(status) && !location) {
            // 3xx 无 Location：上游异常，交由上层按 502 处理
            settle(() => reject(new AppError(ERR.CMD_FAILED, `上游重定向缺少 Location（${status}）`)));
            return;
          }
          settle(() => resolve({
            status,
            headers: res.headers || {},
            stream: res,
            abort: () => { try { res.destroy(); } catch { /* ignore */ } try { req.destroy(); } catch { /* ignore */ } },
          }));
        });
      } catch (err) {
        settle(() => reject(classifyNetError(err)));
        return;
      }

      req.setTimeout(timeoutMs, () => {
        try { req.destroy(new AppError(ERR.NET_UNREACHABLE, `上游响应超时（>${Math.round(timeoutMs / 1000)}s）`)); } catch { /* ignore */ }
      });
      req.on('error', (err) => settle(() => reject(classifyNetError(err))));
      req.end();
    };

    doRequest();
  });
}

/** 扩展名 → Content-Type（对齐设计 B3）。 */
const EXT_MIME = Object.freeze({
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
});

/**
 * 扩展名 → 响应 Content-Type（mp3→audio/mpeg、flac→audio/flac、m4a→audio/mp4、
 * ogg|opus→audio/ogg、wav→audio/wav，其余 application/octet-stream）。
 * @param {string} ext 允许带前导点 / 大小写混写
 * @returns {string}
 */
export function contentTypeForExt(ext) {
  const e = String(ext == null ? '' : ext).replace(/^\./, '').trim().toLowerCase();
  return EXT_MIME[e] || 'application/octet-stream';
}

/**
 * 解析请求方 `Range` 头（仅支持单段 `bytes=…`）。
 *
 * 用途：判断是否「整段播放」（start===0 且无明确 end）→ 决定是否边听边存。
 * 多段（含逗号）/ 非法 / 缺失一律返回 null（= 整段）。
 * @param {string} value
 * @returns {{start:number, end:number|null, isFull:boolean}|null}
 */
export function parseRangeHeader(value) {
  const s = String(value == null ? '' : value).trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(s);
  if (!m) return null;
  const startRaw = m[1];
  const endRaw = m[2];
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    // 后缀范围 bytes=-N（最后 N 字节）——非整段
    const n = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(n)) return null;
    return { start: 0, end: n, isFull: false };
  }
  const start = Number.parseInt(startRaw, 10);
  if (!Number.isFinite(start)) return null;
  const end = endRaw === '' ? null : Number.parseInt(endRaw, 10);
  if (end !== null && !Number.isFinite(end)) return null;
  return { start, end, isFull: start === 0 && end === null };
}

/**
 * 解析 curl `-D -` 打出的响应头块文本（latin1）→ { status, headers }。
 *
 * 若存在多个头块（重定向 / 100-continue），取**最后一个**块（真正承载 body 的那个）。
 * headers 的键统一小写、值已 trim。
 * @param {string} block
 * @returns {{status:number, headers:Record<string,string>}}
 */
export function parseUpstreamHeadBlock(block) {
  const lines = String(block == null ? '' : block).split(/\r?\n/);
  let status = 0;
  let headers = {};
  let sawStatus = false;
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    const sm = /^HTTP\/\d(?:\.\d)?\s+(\d{3})/.exec(line);
    if (sm) {
      // 新块开始：重置累积（最后一个块胜出）
      status = Number(sm[1]);
      headers = {};
      sawStatus = true;
      continue;
    }
    if (!sawStatus) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const val = line.slice(idx + 1).trim();
    if (key) headers[key] = val;
  }
  return { status, headers };
}

/**
 * 「裸二进制」响应头公共基座：Content-Type + Cache-Control，并在上游给出时透传 Content-Length。
 * @param {Record<string,string>} upstreamHeaders
 * @param {{contentType:string, cacheControl:string}} spec
 * @returns {Record<string,string>}
 */
function baseBinaryHeaders(upstreamHeaders, { contentType, cacheControl }) {
  const up = upstreamHeaders || {};
  const out = {
    'Content-Type': contentType,
    'Cache-Control': cacheControl,
  };
  if (up['content-length']) out['Content-Length'] = String(up['content-length']);
  return out;
}

/**
 * 构造「裸二进制音频流」响应头（成功一律绕开 {ok,data} 包络）。
 *
 * · 上游 206 → 我方 206（带 Content-Range）；上游忽略 Range → 200。
 * · 响应头：Content-Type（按扩展名）、Accept-Ranges: bytes、
 *   Content-Length（上游给出时才带）、206 时的 Content-Range、Cache-Control: no-store。
 * @param {{status:number, upstreamHeaders:Record<string,string>, ext:string}} p
 * @returns {{status:number, headers:Record<string,string>}}
 */
export function buildStreamResponseHeaders({ status, upstreamHeaders, ext }) {
  const up = upstreamHeaders || {};
  const out = baseBinaryHeaders(up, { contentType: contentTypeForExt(ext), cacheControl: 'no-store' });
  out['Accept-Ranges'] = 'bytes';
  const clientStatus = status === 206 ? 206 : 200;
  if (clientStatus === 206 && up['content-range']) out['Content-Range'] = String(up['content-range']);
  return { status: clientStatus, headers: out };
}

/**
 * 构造封面响应头（成功=图片字节；Content-Type 透传上游，缺失回落 image/jpeg）。
 * @param {Record<string,string>} upstreamHeaders
 * @returns {Record<string,string>}
 */
export function buildCoverResponseHeaders(upstreamHeaders) {
  const up = upstreamHeaders || {};
  const contentType = up['content-type'] && /^image\//i.test(up['content-type']) ? String(up['content-type']) : 'image/jpeg';
  return baseBinaryHeaders(up, { contentType, cacheControl: 'public, max-age=86400' });
}

/** 网络异常 → 统一 AppError（超时 → 503 NET_UNREACHABLE；其余连接失败 → 502 CMD_FAILED）。 */
function classifyNetError(err, detail) {
  if (err instanceof AppError) return err;
  const code = err && err.code;
  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'ERR_SOCKET_CONNECTION_TIMEOUT') {
    return new AppError(ERR.NET_UNREACHABLE, '上游响应超时', detail || String(err && err.message));
  }
  return new AppError(ERR.CMD_FAILED, '上游连接失败', detail || String(err && err.message));
}

/** 头块结束标记。 */
const CRLFCRLF = Buffer.from('\r\n\r\n');
/** 响应头块起始（重定向跟随下 curl 会连续输出多块）。 */
const HTTP_STATUS_PREFIX = Buffer.from('HTTP/');

/**
 * 定位「最后一个响应头块」结束、正文起始的偏移（proxy 分支专用）。
 *
 * curl `-L -D -` 会把**每一跳**的响应头块依次打到 stdout（块间以 `\r\n\r\n` 分隔），
 * 其后才是最终响应的正文。故不能简单取**首个** `\r\n\r\n`：若其后紧跟下一个 `HTTP/`
 * 状态行，说明那是重定向的中间块，须继续向后找。返回正文起始偏移；尚无法判定时返回 -1。
 * @param {Buffer} buf
 * @returns {number}
 */
function findHeaderBodyBoundary(buf) {
  let from = 0;
  for (;;) {
    const idx = buf.indexOf(CRLFCRLF, from);
    if (idx < 0) return -1;
    const after = idx + 4;
    if (after >= buf.length) return -1; // 需至少 1 字节判断后继是头块还是正文
    const remain = buf.length - after;
    if (remain >= HTTP_STATUS_PREFIX.length) {
      if (buf.subarray(after, after + HTTP_STATUS_PREFIX.length).equals(HTTP_STATUS_PREFIX)) {
        from = after; // 重定向中间块：继续向后
        continue;
      }
      return after; // 正文起点
    }
    // 剩余不足 5 字节：若恰为 'HTTP/' 前缀则等待更多数据，否则判为正文
    if (HTTP_STATUS_PREFIX.subarray(0, remain).equals(buf.subarray(after))) return -1;
    return after;
  }
}

/** 代理抓取：spawn 白名单内 curl（`-L` 跟随重定向），解析最终响应头块后再把 body 交给调用方。 */
function openUpstreamProxy({ url, headers, range, proxies, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sS', '--no-buffer', '-D', '-',
      '-L', '--max-redirs', String(MAX_REDIRECTS),
      '--connect-timeout', '10', '--max-time', String(Math.max(1, Math.round(timeoutMs / 1000))),
    ];
    for (const [k, v] of Object.entries(headers || {})) {
      if (v !== undefined && v !== null) args.push('-H', `${k}: ${v}`);
    }
    if (range) args.push('-r', String(range));
    args.push(url);

    const env = buildCurlEnv(proxies);
    let child;
    try {
      child = spawn(paths.CURL_BIN, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new AppError(ERR.CMD_FAILED, '无法启动 curl', String(err && err.message)));
      return;
    }

    let settled = false;
    let buf = Buffer.alloc(0);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr += d; });

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(err);
    };

    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const boundary = findHeaderBodyBoundary(buf);
      if (boundary < 0) {
        if (buf.length > 256 * 1024) fail(new AppError(ERR.CMD_FAILED, '上游响应头异常'));
        return;
      }
      child.stdout.off('data', onData);
      const parsed = parseUpstreamHeadBlock(buf.subarray(0, boundary).toString('latin1'));
      const rest = buf.subarray(boundary);
      settled = true;
      const stream = new PassThrough();
      if (rest.length) stream.write(rest);
      child.stdout.pipe(stream);
      resolve({
        status: parsed.status,
        headers: parsed.headers,
        stream,
        abort: () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } },
      });
    };

    child.stdout.on('data', onData);
    child.on('error', (err) => fail(new AppError(ERR.CMD_FAILED, 'curl 启动失败', String(err && err.message))));
    child.on('close', (code) => {
      if (settled) return;
      const msg = stderr.trim();
      if (code === 47 || /maximum.*redirects?|too many redirects/i.test(msg)) {
        fail(new AppError(ERR.CMD_FAILED, '上游重定向次数过多', msg || 'curl exit 47'));
        return;
      }
      const isTimeout = /timed out|timeout/i.test(msg);
      fail(new AppError(
        isTimeout ? ERR.NET_UNREACHABLE : ERR.CMD_FAILED,
        isTimeout ? '上游响应超时' : '上游连接失败',
        msg || `curl exit ${code}`,
      ));
    });
  });
}

/** 代理模式下 curl 的运行环境（仅注入必要变量，绝不继承宿主 PATH）。 */
function buildCurlEnv(proxies) {
  const env = { PATH: paths.EXEC_PATH.join(':'), HOME: paths.HOME };
  if (process.env.LANG) env.LANG = process.env.LANG;
  if (proxies && typeof proxies === 'object') {
    if (proxies.http) { env.http_proxy = proxies.http; env.HTTP_PROXY = proxies.http; }
    if (proxies.https) { env.https_proxy = proxies.https; env.HTTPS_PROXY = proxies.https; }
  }
  return env;
}

/**
 * 打开上游（自动按通道选择直连 / curl）。
 *
 * @param {{url:string, headers?:Record<string,string>, range?:string,
 *          channel?:'direct'|'proxy', proxies?:object|null, timeoutMs?:number}} opts
 * @returns {Promise<{status:number, headers:Record<string,string>,
 *                    stream:import('node:stream').Readable, abort:() => void}>}
 */
export function openUpstream(opts) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
    ? opts.timeoutMs : DEFAULT_UPSTREAM_TIMEOUT_MS;
  const req = {
    url: String(opts.url || ''),
    headers: opts.headers && typeof opts.headers === 'object' ? opts.headers : {},
    range: opts.range,
    proxies: opts.proxies && typeof opts.proxies === 'object' ? opts.proxies : null,
    timeoutMs,
  };
  if (opts.channel === 'proxy') return openUpstreamProxy(req);
  return openUpstreamDirect(req);
}
