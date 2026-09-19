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
 */

/** 三个外观字段的提取正则（与 patchYaml 写入的键一一对应）。 */
const SKIN_RE = /style\/color_scheme\b["']?\s*:\s*["']?([\w-]+)/;
const LAYOUT_RE = /style\/candidate_list_layout["']?\s*:\s*["']?([\w-]+)/;
const ORIENTATION_RE = /style\/text_orientation["']?\s*:\s*["']?([\w-]+)/;

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
    skin: get(SKIN_RE),
    layout: get(LAYOUT_RE),
    orientation: get(ORIENTATION_RE),
  };
}
