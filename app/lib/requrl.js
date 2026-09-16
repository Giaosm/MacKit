/**
 * MacKit · HTTP 请求行 URL 解析（纯函数，零依赖、无副作用）
 *
 * 为什么单独成模块：`server.js` 顶层会调用 `main()` 启动服务，无法被单测直接
 * `import`（会真起进程）。把这段解析逻辑抽出来，才能对畸形请求行做精确、稳定的单测；
 * `server.js` 是它唯一的调用方。
 *
 * 背景（2026-09-16 bug）：`new URL('//', base)` / `new URL('///', base)` 会把开头的
 * `//` 当成 **protocol-relative 的权威段**（`//foo` → host 变成 `foo`）而抛 `Invalid URL`。
 * 若该异常发生在 handler 的 try/catch 之外，连接会**永不返回（挂死）**。故解析前必须
 * 把开头的连续斜杠折叠为单个 `/`。
 */

/**
 * 把 HTTP 请求行里的 request-target 解析为绝对 URL。
 *
 * 归一化规则（目标：任何输入都不会让调用方挂死）：
 *   - 非字符串 / 空串 → 视作 `/`；
 *   - 去掉首尾空白；
 *   - 开头的连续斜杠（`//`、`///`、`//foo`）折叠为单个 `/`；
 *   - 其余交给 `new URL()`；仍无法解析（如 `http://[` 这类非法输入）时**抛出**异常，
 *     由调用方（server.js 的 handler try/catch）兜底为正常错误响应。
 *
 * @param {string|undefined} raw `req.url` 原始值
 * @param {string} base 解析基址，形如 `http://127.0.0.1`
 * @returns {URL}
 */
export function parseReqUrl(raw, base) {
  let s = typeof raw === 'string' ? raw.trim() : '';
  if (s === '') s = '/';
  s = s.replace(/^\/+/, '/');
  return new URL(s, base);
}

export default { parseReqUrl };
