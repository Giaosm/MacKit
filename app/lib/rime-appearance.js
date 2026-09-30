/**
 * MacKit · Rime 外观解析（纯函数，零依赖、无副作用）
 *
 * env.js 的体检快照与 rime.js 的 queryAppearance 原先各有一份「当前皮肤 / 布局 / 方向」
 * 读取实现；两处正则一旦漂移，diff 预览的「旧值」就会与状态卡不一致，故收敛到本文件
 * 供两处 import。
 *
 * 统一**跳过注释行**：补丁写入（patchYaml）只改非注释行，所以
 * `# style/color_scheme: x` 这种注释不应该被当成「当前值」，否则预览会显示一个
 * 实际不会被更新的旧值。
 *
 * ★ 同时认**两种写法**（2026-09-25 修）：扁平的 `style/color_scheme: x` 与嵌套的
 *   `style:` → `color_scheme: x`。patchYaml 两种都会就地更新；读取侧只认扁平的话，
 *   用嵌套写法写的用户会看到「当前皮肤」为空 —— 而配置其实一直是生效的。
 */

/** 三个外观字段的扁平写法提取正则（与 patchYaml 写入的键一一对应）。 */
const SKIN_RE = /style\/color_scheme\b["']?\s*:\s*["']?([\w-]+)/;
const LAYOUT_RE = /style\/candidate_list_layout["']?\s*:\s*["']?([\w-]+)/;
const ORIENTATION_RE = /style\/text_orientation["']?\s*:\s*["']?([\w-]+)/;

/**
 * 在嵌套写法（`style:` 块下的同名子键）里取值。
 * @param {string} body 已剔除注释行的正文
 * @param {string} child 子键名（如 color_scheme）
 * @returns {string|null}
 */
function getNested(body, child) {
  const lines = body.split('\n');
  const parentRe = /^(\s*)style\s*:/;
  const childRe = new RegExp(`^\\s*${child}\\s*:\\s*["']?([\\w-]+)`);
  for (let i = 0; i < lines.length; i += 1) {
    const pm = parentRe.exec(lines[i]);
    if (!pm) continue;
    const baseLen = pm[1].length;
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = /^\s*/.exec(line)[0];
      if (ind.length <= baseLen) break;               // 块结束
      const cm = childRe.exec(line);
      if (cm) return cm[1];
    }
  }
  return null;
}

/**
 * 解析当前外观。
 * @param {string|null} text squirrel.custom.yaml 全文（读不到时传 null）
 * @returns {{skin:string|null, layout:string|null, orientation:string|null}}
 */
export function parseRimeAppearance(text) {
  const body = String(text == null ? '' : text)
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  const get = (re) => {
    const m = re.exec(body);
    return m ? m[1] : null;
  };
  return {
    skin: get(SKIN_RE) || getNested(body, 'color_scheme'),
    layout: get(LAYOUT_RE) || getNested(body, 'candidate_list_layout'),
    orientation: get(ORIENTATION_RE) || getNested(body, 'text_orientation'),
  };
}
