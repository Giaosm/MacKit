/**
 * MacKit · 版本号工具（唯一事实源，2026-09-25）
 *
 * 为什么单独成文件：版本比较在 Homebrew 管家（cask 版本 / 上游 release tag）与音乐模块
 * （musicdl 目标版本 / PyPI 上游版本）都要用，此前散落多份实现。这里保留**两种语义**并写明区别，
 * 调用方按需取，避免「统一的时候悄悄改了行为」：
 *   · {@link compare}     —— 通用比较：去 `v` 前缀，`,` `-` `_` `+` 都当分隔符，缺段视为更小，
 *                            非数字段按字典序。**解析不出来也不会返回「相等」**。
 *   · {@link parseStrict} —— 严格 `MAJOR.MINOR.PATCH`，失败返回 null。音乐模块的历史语义依赖它
 *                            （解析失败时调用方按「相等」处理，避免把不认识的版本串误报成「有更新」）。
 *
 * ★ 不接管 `brew.js` 的 `stripBrewRevision`：它处理的是 Homebrew 特有的 revision 后缀（`1.5.7_1`），
 *   属 brew 领域知识，留在 brew.js。
 */

/**
 * 版本串 → 逐段数组（去前导 `v`；`,` `-` `_` `+` 都当分隔符）。
 * @param {unknown} v
 * @returns {string[]}
 */
export function segments(v) {
  return String(v == null ? '' : v).replace(/^v/i, '').split(/[.,\-_+]/).filter((s) => s !== '');
}

/**
 * 通用版本比较（逐段：数字段按数值、其余按字典序；缺段视为更小）。
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} a>b → 1；a<b → -1；相等 → 0
 */
export function compare(a, b) {
  const A = segments(a);
  const B = segments(b);
  for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d > 0 ? 1 : -1;
    } else if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * a 是否「就是」b —— 用于「应用真实版本 vs cask 版本」这类比较：cask 常在版本后追加
 * build / commit（应用 `4.12.1` vs cask `4.12.1.39217423,757a5b2f`），所以按**前缀**判定，
 * 不能用大小比较（那样会得出「cask 更新」而误触发 brew 升级）。
 * @param {unknown} a 较短一侧（应用版本）
 * @param {unknown} b 较长一侧（cask 版本）
 * @returns {boolean}
 */
export function samePrefix(a, b) {
  const A = segments(a);
  const B = segments(b);
  if (A.length === 0 || B.length === 0 || A.length > B.length) return false;
  return A.every((seg, i) => seg === B[i]);
}

/**
 * 严格解析 `MAJOR.MINOR.PATCH`（只取前三段，允许后面还有段）。
 * @param {unknown} v
 * @returns {[number,number,number]|null} 失败 → null
 */
export function parseStrict(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v == null ? '' : v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
