/**
 * MacKit · 音乐模块 · NDJSON 协议解析（设计文档 §3.2）
 *
 * 桥接脚本 bridge.py 的 stdout 只应出现 NDJSON（每行一个 JSON 事件）；本文件负责：
 *   - parseLine(line)  : 逐行解析 + schema 兜底。**非法行一律返回 null、绝不抛错**，
 *                        用于吃掉任何漏网的噪声（rich 进度条、第三方 print 等）。
 *   - toAppError(ev)   : 把桥接层的 `error` 事件映射为统一的 AppError（错误码归一）。
 *
 * 错误码映射表（bridge → exec.ERR），**不新增错误码**，确保 server.js 的 statusForCode 能处理：
 *   ENV_MISSING → ENV_MISSING(409) · PARSE_FAILED → PARSE_FAILED(422) ·
 *   NET_UNREACHABLE → NET_UNREACHABLE(503) · CANCELLED → CANCELLED(409) ·
 *   DL_FAILED → CMD_FAILED(502) · 其它/未知 → CMD_FAILED(502)
 */

import { AppError, ERR } from '../exec.js';

/** 协议允许的事件类型（§3.2 事件表；source_start = 串行搜索「开始搜某源」进度事件）。 */
export const EVENTS = Object.freeze(new Set(['start', 'source_start', 'source', 'song', 'progress', 'result', 'done', 'error']));

/** bridge `error.code` → exec.ERR 映射（§3.2 表）。 */
const CODE_MAP = Object.freeze({
  ENV_MISSING: ERR.ENV_MISSING,
  PARSE_FAILED: ERR.PARSE_FAILED,
  NET_UNREACHABLE: ERR.NET_UNREACHABLE,
  CANCELLED: ERR.CANCELLED,
  DL_FAILED: ERR.CMD_FAILED,
  TIMEOUT: ERR.TIMEOUT,
  NOT_FOUND: ERR.NOT_FOUND,
  IO_ERROR: ERR.IO_ERROR,
});

/**
 * 解析桥接层的一行 stdout。
 *
 * 防御性设计：stdout 理论上只有 NDJSON，但 rich 进度条、第三方库的 print 仍可能漏进来；
 * 解析失败或结构不符一律静默丢弃（返回 null），避免一条噪声行打断整个会话。
 *
 * @param {string} line
 * @returns {object|null} 合法事件对象，否则 null
 */
export function parseLine(line) {
  const s = String(line == null ? '' : line).trim();
  if (s.length === 0) return null;
  // 快速排除：合法 NDJSON 必然以 '{' 开头（rich 进度条多为不可见控制符 / 普通文本）
  if (s[0] !== '{') return null;
  let obj;
  try { obj = JSON.parse(s); } catch { return null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  if (typeof obj.ev !== 'string' || !EVENTS.has(obj.ev)) return null;
  return obj;
}

/**
 * 把桥接层的致命 `error` 事件转成统一的 AppError。
 *
 * @param {object} ev parseLine 返回的 error 事件
 * @returns {AppError}
 */
export function toAppError(ev) {
  const raw = ev && typeof ev.code === 'string' ? ev.code : '';
  const code = CODE_MAP[raw] || ERR.CMD_FAILED;
  const message = ev && typeof ev.message === 'string' && ev.message ? ev.message : '音乐模块执行失败';
  const detail = ev && typeof ev.detail === 'string' && ev.detail ? ev.detail : undefined;
  return new AppError(code, message, detail);
}
