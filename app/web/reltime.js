/**
 * 相对时间格式化（纯函数，无 DOM 依赖，可在浏览器与 Node 中直接 import）。
 * 规则：<1 分钟「刚刚」；<1 小时「N 分钟前」；同一自然日「N 小时前」；
 *      昨天「昨天 HH:MM」；前天「前天 HH:MM」；3–6 天「N 天前」；
 *      同年更早「MM-DD」；跨年「YYYY-MM-DD」。
 * @param {number} ms  目标时间戳（毫秒）
 * @param {number} [now] 基准时刻，默认 Date.now()（显式传入可复现同一输出）
 * @returns {string} 无法解析时返回 ''
 */
export function fmtRel(ms, now = Date.now()) {
  // 非法输入（含 0 / null / undefined / NaN / 非数字）→ 空串，交由调用方决定占位
  if (!Number.isFinite(ms) || ms <= 0) return '';

  const diff = now - ms;

  // <1 分钟（含未来时间：diff 为负也算「刚刚」）
  if (diff < 60_000) return '刚刚';
  // <1 小时 → 「N 分钟前」（向下取整）
  if (diff < 3_600_000) return `${Math.floor(diff / 60000)} 分钟前`;

  // ≥1 小时：按「自然日」比较（不可用 diff / 86400000 粗略相除，否则跨零点会算错）
  const target = new Date(ms);
  const ref = new Date(now);
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  const startOfToday = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate()).getTime();
  const dayDiff = Math.round((startOfToday - startOfTarget) / 86400000);

  const hh = String(target.getHours()).padStart(2, '0');
  const mm = String(target.getMinutes()).padStart(2, '0');

  // 同一自然日：diff 可能因为时钟偏差 / 跨机器历史而略为负 → 夹到 0（否则会显示「-2 小时前」）
  if (dayDiff <= 0) return `${Math.max(0, Math.floor(diff / 3600000))} 小时前`;
  if (dayDiff === 1) return `昨天 ${hh}:${mm}`;
  if (dayDiff === 2) return `前天 ${hh}:${mm}`;
  if (dayDiff >= 3 && dayDiff <= 6) return `${dayDiff} 天前`;

  const MM = String(target.getMonth() + 1).padStart(2, '0');
  const DD = String(target.getDate()).padStart(2, '0');
  if (target.getFullYear() === ref.getFullYear()) return `${MM}-${DD}`;
  return `${target.getFullYear()}-${MM}-${DD}`;
}
