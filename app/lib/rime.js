/**
 * MacKit · Rime 输入法管家（后端模块）
 *
 * 语义移植自原 `shell/rime_ice.sh`（参考脚本已于 2026-09-16 从仓库移除，本文件为该功能的唯一事实源）。
 *
 * 关键约束：
 *   - 不引入任何 YAML 库：`squirrel.yaml` 用「行式解析器」自研，只认
 *     顶层 `preset_color_schemes:`、2 空格缩进的方案键、4+ 空格缩进的字段；
 *     跳过注释行、剥离行内注释、剥离引号。
 *   - `normalizeColor` 是全项目唯一的色值解析函数；**8 位色值一律视为 AARRGGBB**
 *     （alpha 在前两位），6 位视为 RRGGBB（alpha=1）。
 *   - `native` 只有 `name` 没有色值 → colors=null（前端用中性色兜底，不报错）。
 *   - 兜底链：squirrel.yaml → build/squirrel.yaml → 降级（22 款名称 + 无色值），**不报错**。
 *   - 写 squirrel.custom.yaml 前不做自动备份（2026-09-16 起自动备份已移除，
 *     配置迁移走「备份中心」的 WebDAV 备份）。
 *   - `patch_yaml` 双语义：键已存在→原地替换该行；不存在→在 `patch:` 之后插入；
 *     无 `patch:`→先追加 `patch:` 再插入。
 *   - 皮肤 ID/名称的唯一事实源 = 本文件的 SKIN_IDS / SKIN_NAMES 常量表
 *     （两者顺序严格一一对应）。
 */

import fs from 'node:fs';
import * as paths from './paths.js';
import * as env from './env.js';
import * as exec from './exec.js';
import { resolvePolicy } from './netpolicy.js';
import { parseRimeAppearance } from './rime-appearance.js';

const { ERR, AppError } = exec;

/** 联网安装类超时（走代理） */
const NET_TIMEOUT = 1_800_000;
const PLUM_GIT_URL = 'https://github.com/rime/plum.git';

// ---------------------------------------------------------------------------
// 常量表（唯一事实源：本文件）
// ---------------------------------------------------------------------------

/** 8 个输入方案 id */
const SCHEME_IDS = Object.freeze([
  'rime_ice', 'double_pinyin', 'double_pinyin_flypy', 'double_pinyin_mspy',
  'double_pinyin_sogou', 'double_pinyin_abc', 'double_pinyin_jiajia',
  'double_pinyin_ziguang',
]);
/** 8 个输入方案名称（顺序与 id 一致） */
const SCHEME_NAMES = Object.freeze([
  '雾凇拼音（全拼）', '自然码双拼', '小鹤双拼', '微软双拼', '搜狗双拼',
  '智能ABC双拼', '拼音加加双拼', '紫光双拼',
]);

/** 22 款皮肤 id */
const SKIN_IDS = Object.freeze([
  'purity_of_form_custom', 'native', 'aqua', 'azure', 'luna',
  'ink', 'lost_temple', 'dark_temple', 'psionics', 'purity_of_form',
  'purity_of_essence', 'starcraft', 'google', 'solarized_rock',
  'clean_white', 'apathy', 'dust', 'mojave_dark', 'solarized_light',
  'solarized_dark', 'retro_green', 'retro_orange',
]);
/**
 * 22 款皮肤名称（顺序与 id 严格一一对应）。
 * 注：`星際我爭霸`（第 12 项）是历史遗留的错别字（应为"星際爭霸"），保留原样，
 * 以免与既有用户已见到的名称不一致。
 */
const SKIN_NAMES = Object.freeze([
  '純粹的形式／Purity of Form Custom', '系統配色', '碧水／Aqua', '青天／Azure',
  '明月／Luna', '墨池／Ink', '孤寺／Lost Temple', '暗堂／Dark Temple',
  '幽能／Psionics', '純粹的形式／Purity of Form', '純粹的本質／Purity of Essence',
  '星際我爭霸／StarCraft', '谷歌／Google', '曬經石／Solarized Rock',
  '简约白／Clean White', '冷漠／Apathy', '浮尘／Dust', '沙漠夜／Mojave Dark',
  '曬經・日／Solarized Light', '曬經・月／Solarized Dark', '綠色熒光屏', '琥珀色熒光屏',
]);

/** 4 种布局 */
const LAYOUTS = Object.freeze([
  { index: 1, layout: 'stacked', orientation: 'horizontal', label: '竖向候选 + 水平文字（默认）' },
  { index: 2, layout: 'linear', orientation: 'horizontal', label: '横向候选 + 水平文字' },
  { index: 3, layout: 'stacked', orientation: 'vertical', label: '竖向候选 + 垂直文字' },
  { index: 4, layout: 'linear', orientation: 'vertical', label: '横向候选 + 垂直文字' },
]);

/** 关心的颜色字段 → SkinColors 键 */
const COLOR_FIELDS = Object.freeze({
  text_color: 'text',
  candidate_text_color: 'text',
  back_color: 'back',
  candidate_back_color: 'back',
  hilited_text_color: 'hilitedText',
  hilited_candidate_text_color: 'hilitedText',
  hilited_back_color: 'hilitedBack',
  hilited_candidate_back_color: 'hilitedBack',
  comment_text_color: 'comment',
  hilited_comment_text_color: 'comment',
  border_color: 'border',
});
/** 归一化优先级：每个 SkinColors 键的字段候选顺序（先命中者胜） */
const RESOLVE_ORDER = Object.freeze([
  ['text', ['text_color', 'candidate_text_color']],
  ['back', ['back_color', 'candidate_back_color']],
  ['hilitedText', ['hilited_text_color', 'hilited_candidate_text_color']],
  ['hilitedBack', ['hilited_back_color', 'hilited_candidate_back_color']],
  ['comment', ['comment_text_color', 'hilited_comment_text_color']],
  ['border', ['border_color']],
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
const readTextSafe = paths.readTextSafe;
const writeTextSafe = paths.writeText;
function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 读取一个「即将被整份覆盖」的配置文件。
 *
 * ★ 为什么不能写成 `readTextSafe(p) || ''`（2026-09-25 修，P0）：readTextSafe 对
 *   ENOENT / EACCES / EMFILE **一律**返回 null，把它当「空文件」继续覆盖，就会在
 *   「读不到但可写」的情形下（ACL 拒读允许写 / 只写模式 / 瞬时 EMFILE）把用户的
 *   Rime 配置整份替换成几行补丁 —— 而本模块明确**不做自动备份**，属于不可逆的数据破坏。
 *   sysinit.js 与 brew.js 的同类写入点早有 `text === null` 护栏，这里补齐。
 * @param {string} p
 * @returns {string} 真不存在 → ''（新建）；存在且可读 → 原文；存在但读不到 → 抛 IO_ERROR
 */
function readBeforeOverwrite(p) {
  const text = readTextSafe(p);
  if (text !== null) return text;
  if (!paths.exists(p)) return '';
  throw new AppError(ERR.IO_ERROR, `无法读取 ${p}，已中止以免覆盖你的配置`,
    '请检查该文件权限或属主（例如是否被 root 创建），或改用「保留原样」手动添加');
}

/** 剥离值两侧引号并 trim。 */
function unquote(s) {
  let v = String(s == null ? '' : s).trim();
  if (v.length >= 2 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
    v = v.slice(1, -1);
  }
  return v.trim();
}

/**
 * 剥离行内注释：只删除「行内空白 + #」起的尾部注释，保留作为颜色字面量前缀的 `#`。
 * 覆盖「按 # 截断取值」的意图，同时对 `#RRGGBB` 形式更安全。
 */
function stripInlineComment(v) {
  return String(v == null ? '' : v).replace(/\s#.*$/, '').trim();
}

// ---------------------------------------------------------------------------
// 色值解析（★ 全项目唯一）
// ---------------------------------------------------------------------------

/**
 * 归一化一个颜色字面量。
 *   - 6 位（`0x606060` / `#606060` / `606060`）→ `{hex:'#606060', alpha:1, valid:true}`
 *   - 8 位（`0xeeeceeee` / `#eeeceeee`）→ **AARRGGBB**：alpha=AA/255, hex=RRGGBB
 *   - 无法识别 → `{hex:'#CCCCCC', alpha:1, valid:false}`
 * @param {string} raw
 * @returns {{hex:string, alpha:number, valid:boolean}}
 */
function normalizeColor(raw) {
  const INVALID = { hex: '#CCCCCC', alpha: 1, valid: false };
  if (raw === null || raw === undefined) return { ...INVALID };
  const s = unquote(stripInlineComment(raw));
  if (!s) return { ...INVALID };
  let digits = null;
  let m = /^0x([0-9a-fA-F]+)$/.exec(s);
  if (m) digits = m[1];
  if (digits === null) { m = /^#([0-9a-fA-F]+)$/.exec(s); if (m) digits = m[1]; }
  if (digits === null) { m = /^([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.exec(s); if (m) digits = m[1]; }
  if (digits === null) return { ...INVALID };

  if (digits.length === 6) return { hex: `#${digits.toUpperCase()}`, alpha: 1, valid: true };
  if (digits.length === 8) {
    const alpha = Math.round((Number.parseInt(digits.slice(0, 2), 16) / 255) * 1000) / 1000;
    return { hex: `#${digits.slice(2).toUpperCase()}`, alpha, valid: true };
  }
  return { ...INVALID };
}

// ---------------------------------------------------------------------------
// squirrel.yaml 行式解析器（★ 高风险，必须精确）
// ---------------------------------------------------------------------------

/**
 * 解析 squirrel.yaml 的 `preset_color_schemes:` 段，得到 id → { colors }。
 * ★ name 不再解析：唯一调用方 readSkins 一律用 SKIN_NAMES（本文件头注明的唯一事实源），
 *   解析出来的 name 是死数据（2026-09-19 删）。
 * @param {string} text
 * @returns {Map<string, {colors:(Object|null)}>}
 */
function parseSquirrelSchemes(text) {
  const map = new Map();
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  let inSchemes = false;
  let cur = null;

  const flush = () => {
    if (!cur) return;
    map.set(cur.id, { colors: resolveColors(cur.raw) });
    cur = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!inSchemes) {
      // 放宽到「可带前导空白 / 行尾注释」（2026-09-25 修）：原正则要求顶格且冒号后直接换行，
      // 一旦写法略有不同就整段认不出来 → 静默走兜底链降级成「22 个名字 + 无色值」，
      // 界面上没有任何提示，极难排查。
      if (/^\s*preset_color_schemes\s*:/.test(line)) inSchemes = true;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (/^\s*#/.test(line)) continue;                 // 跳过整行注释（如 `  # 对 purity...`）
    if (!/^\s/.test(line)) { flush(); break; }        // 回到顶层 → 段落结束

    const mField = /^ {4,}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (mField) { if (cur) applyField(cur, mField[1], mField[2]); continue; }
    const mScheme = /^ {2}([A-Za-z0-9_]+):/.exec(line);
    if (mScheme) { flush(); cur = { id: mScheme[1], raw: {} }; continue; }
  }
  flush();
  return map;
}

/** 把一个颜色字段写入当前方案（name 不解析，见 parseSquirrelSchemes 注释）。 */
function applyField(cur, key, rawValue) {
  const value = stripInlineComment(rawValue);
  if (Object.prototype.hasOwnProperty.call(COLOR_FIELDS, key)) cur.raw[key] = value;
}

/** 由原始字段字典解析出 SkinColors（无色值则返回 null）。 */
function resolveColors(raw) {
  const out = {};
  let any = false;
  for (const [field, keys] of RESOLVE_ORDER) {
    for (const k of keys) {
      if (raw[k] !== undefined && raw[k] !== '') { out[field] = normalizeColor(raw[k]); any = true; break; }
    }
  }
  return any ? out : null;
}

/**
 * 读取 22 款皮肤（兜底链：squirrel.yaml → build/squirrel.yaml → 降级），**永不抛错**。
 * @returns {{schemes:Array<{id:string,name:string,colors:Object|null,hasColors:boolean}>, source:'squirrel'|'build'|'degraded'}}
 */
function readSkins() {
  const tryParse = (file) => {
    const text = readTextSafe(file);
    if (text === null) return null;
    const m = parseSquirrelSchemes(text);
    return m.size > 0 ? m : null;
  };
  let parsed = tryParse(paths.RIME_SQUIRREL);
  let source = 'squirrel';
  if (!parsed) { parsed = tryParse(paths.RIME_BUILD_SQUIRREL); source = 'build'; }
  if (!parsed) { parsed = new Map(); source = 'degraded'; }
  const schemes = SKIN_IDS.map((id, i) => {
    const hit = parsed.get(id);
    const colors = hit && hit.colors ? hit.colors : null;
    return { id, name: SKIN_NAMES[i], colors, hasColors: !!colors };
  });
  return { schemes, source };
}

// ---------------------------------------------------------------------------
// squirrel.custom.yaml 写入（patch_yaml 双语义）
// ---------------------------------------------------------------------------

/**
 * 在 `parent:` **嵌套块**里落地 `parent/child` 键：
 *   · 块里已有 `child:` → 就地改值（保留行尾注释）；
 *   · 块在、但 `child:` 缺失 → 插进该块（按块内最后一个子键的缩进），**不**另插扁平键；
 *   · 没有该 parent 块 → 返回 null（调用方回落扁平插入）。
 * @param {string[]} lines
 * @param {string} key 形如 `style/color_scheme`
 * @param {string} value
 * @returns {string[]|null}
 */
function patchYamlNested(lines, key, value) {
  const segs = String(key).split('/');
  if (segs.length !== 2) return null;
  const [parent, child] = segs;
  const parentRe = new RegExp(`^(\\s*)${escapeRe(parent)}\\s*:`);
  const childRe = new RegExp(`^(\\s*)${escapeRe(child)}\\s*:`);
  for (let i = 0; i < lines.length; i += 1) {
    const pm = parentRe.exec(lines[i]);
    if (!pm) continue;
    const baseLen = pm[1].length;
    let insertAt = -1;
    let insertIndent = ' '.repeat(baseLen + 2);
    for (let j = i + 1; j < lines.length; j += 1) {
      const line = lines[j];
      if (line.trim() === '') continue;
      const ind = /^\s*/.exec(line)[0];
      if (ind.length <= baseLen) break;                 // 回到同级 / 更浅 → 该块结束
      const cm = childRe.exec(line);
      if (cm) {
        lines[j] = `${cm[1]}${child}: ${value}${trailingYamlComment(line)}`;
        return lines;
      }
      insertAt = j + 1;                                  // 记住块内最后一个子键之后
      insertIndent = ind;
    }
    lines.splice(insertAt >= 0 ? insertAt : i + 1, 0, `${insertIndent}${child}: ${value}`);
    return lines;
  }
  return null;
}

/**
 * patch_yaml：命中 `^\s*<key>:` 则原地替换该行值（保留行尾注释），
 * 否则就地更新嵌套写法（`style:` 下的 `color_scheme:`），
 * 再否则在顶层 `patch:` 行之后插入；无 `patch:` 行则先追加 `patch:`。
 * @param {string} text
 * @param {string} key
 * @param {string} value
 * @returns {string}
 */
function patchYaml(text, key, value) {
  let lines = String(text == null ? '' : text).split('\n');
  if (lines.length === 1 && lines[0] === '') lines = []; // 空文件：不留前导空行
  const re = new RegExp(`^(\\s*)${escapeRe(key)}:`);
  for (let i = 0; i < lines.length; i += 1) {
    if (!re.test(lines[i])) continue;
    // 原地替换 + **保留行尾注释**（此前整行重写会把 `style/color_scheme: ink # 我喜欢的` 的注释吞掉）
    lines[i] = `${re.exec(lines[i])[1]}${key}: ${value}${trailingYamlComment(lines[i])}`;
    return lines.join('\n');
  }
  // ★ 嵌套写法兜底（2026-09-25 修）：用户写的是
  //     patch:
  //       style:
  //         color_scheme: ink
  //   时，只认扁平键就会**再插入一份扁平表示**，同一配置路径出现两种写法，而读取侧
  //   （rime-appearance.js 与「当前皮肤」状态卡）只认扁平 → 界面显示为空、点了「应用外观」
  //   也说不清最终以哪个为准。这里优先就地改嵌套块里的同名子键。
  const nested = patchYamlNested(lines, key, value);
  if (nested) return nested.join('\n');
  const patchIdx = findPatchLine(lines);   // 与 mergeGrammarPatch 共用同一套「什么算 patch 行」的判定
  if (patchIdx < 0) { lines.push('patch:', `  ${key}: ${value}`); return lines.join('\n'); }
  lines.splice(patchIdx + 1, 0, `  ${key}: ${value}`);
  return lines.join('\n');
}

/** 读取当前外观（skin / layout / orientation）。 */
function readCurrentAppearance() {
  // 与 /api/rime/status 的状态卡同源（lib/rime-appearance.js，跳过注释行）
  return parseRimeAppearance(readTextSafe(paths.RIME_CUSTOM));
}

/**
 * 从 YAML 文本中解析第一个 `- schema: X` 列表项（纯函数）。
 * 用于 schema_list：build/default.yaml 是部署后的编译结果（真实生效），
 * default.custom.yaml 是 patch 源（兼容 `patch:` 与 `__patch:`/Rx 两种格式）。
 * @param {string} text
 * @returns {string|null}
 */
function parseFirstSchema(text) {
  const m = /^[ \t]*-[ \t]*schema:[ \t]*["']?([\w-]+)/m.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

/** 当前生效的输入方案：build/default.yaml 优先 → default.custom.yaml → 回退 rime_ice。 */
function readCurrentSchema() {
  return parseFirstSchema(readTextSafe(paths.RIME_BUILD_DEFAULT))
      || parseFirstSchema(readTextSafe(paths.RIME_DEFAULT_CUSTOM))
      || 'rime_ice';
}

/**
 * 扫描 Rime 目录下已安装的语法模型（*.gram），按文件名排序。
 * rime-ice 官方配方安装的即「万象」模型（wanxiang-lts-zh-hans.gram，来自 amzxyz/RIME-LMDG）。
 * @returns {Array<{name:string, size:number}>}
 */
function readGrammarModels() {
  try {
    return fs.readdirSync(paths.RIME_DIR)
      .filter((f) => f.endsWith('.gram'))
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(paths.RIME_DIR + '/' + f).size; } catch { /* 文件刚被删等，忽略 */ }
        return { name: f, size };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

/**
 * 解析 rime_ice.dict.yaml 里的 `version: "YYYY-MM-DD"`（纯函数）。
 * 上游（iDvel/rime-ice）在每次词库更新时同步该版本号，可直接对比判断「词库是否有新版本」。
 * @param {string} text
 * @returns {string|null}
 */
function parseDictVersion(text) {
  const m = /^[ \t]*version:[ \t]*["']?(\d{4}-\d{2}-\d{2})["']?[ \t]*(?:#.*)?$/m.exec(String(text == null ? '' : text));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// 动作辅助
// ---------------------------------------------------------------------------

/**
 * 本次联网的通道策略（2026-09-22：改为「模块档位 + 按主机自动」）。
 *   · params.channel 显式给 proxy / direct → 按其执行（显式优先，与 Homebrew 逐项按钮同口径）
 *   · 否则交给模块档位（Rime 页顶部的下拉）；auto 档的自动策略是「代理优先」——Rime 的联网目标
 *     （plum / 语法模型 / 皮肤）基本都在 GitHub。
 */
const netPolicy = (p) => {
  const explicit = { direct: 'direct_first', proxy: 'proxy_first' }[String((p && p.channel) || '')];
  return explicit || resolvePolicy('rime', 'proxy_first');
};
/** 走网络通道执行（通道由 netPolicy 决定；失败自动降级另一条）。 */
async function runNet(ctx, desc, bin, args, extra = {}) {
  const res = await ctx.exec.runWithChannel(netPolicy(ctx.params), desc, bin, args, {
    timeoutMs: NET_TIMEOUT,
    onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
    ...extra,
  });
  ctx.setChannel(res.channel);
  return res;
}

/** 检查 git 可用。 */
async function requireGit(ctx) {
  const res = await ctx.exec.run('git', ['--version'], { noMirror: true, timeoutMs: 15_000 });
  if (res.code !== 0) throw new AppError(ERR.ENV_MISSING, '未找到 git，请先安装 git');
  ctx.log('ok', `Git: ${res.stdout.trim()}`);
}

/** ensure_plum：已存在则 pull，否则 clone。 */
async function ensurePlum(ctx) {
  if (paths.exists(paths.PLUM_DIR)) {
    ctx.log('info', 'plum 已存在，正在更新...');
    await runNet(ctx, 'plum 更新', 'git', ['-C', paths.PLUM_DIR, 'pull']);
  } else {
    ctx.log('warn', 'plum 未安装，正在克隆...');
    await runNet(ctx, '克隆 plum', 'git', ['clone', PLUM_GIT_URL, paths.PLUM_DIR]);
  }
  ctx.log('ok', 'plum 就绪');
}

/** 调用 plum 的 rime-install（等价 `cd $PLUM_DIR; rime_dir=$RIME_DIR bash rime-install <recipe>`）。 */
async function runRimeInstall(ctx, recipe) {
  ctx.log('info', `rime-install ${recipe}`);
  const res = await ctx.exec.runWithChannel(netPolicy(ctx.params), 'rime-install', `${paths.PLUM_DIR}/rime-install`, [recipe], {
    cwd: paths.PLUM_DIR,
    env: { rime_dir: paths.RIME_DIR },
    timeoutMs: NET_TIMEOUT,
    onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
  });
  ctx.setChannel(res.channel);
  return res;
}

/** deploy_rime：存在可执行则 `Squirrel --reload`，否则提示手动重新部署。 */
async function deployRime(ctx) {
  if (!paths.exists(paths.SQUIRREL_BIN)) {
    ctx.log('warn', '未找到 Squirrel 可执行文件，请手动重新部署（点击菜单栏「重新部署」）');
    return;
  }
  const res = await ctx.exec.run(paths.SQUIRREL_BIN, ['--reload'], { noMirror: true, timeoutMs: 60_000 });
  if (res.code === 0) ctx.log('ok', '重新部署完成');
  else ctx.log('warn', `重新部署命令返回码 ${res.code}，如未生效请手动重新部署`);
}

/** 校验输入方案；invalid 时按策略回落 rime_ice 或抛错。 */
function resolveScheme(raw, fallbackDefault) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return 'rime_ice';
  if (SCHEME_IDS.includes(s)) return s;
  // 回落分支只放行 rime_ice / double_pinyin_* 这类变体名。**必须排除路径分隔符与 `.`**：
  // 该值会被 grammarCustomPath 拼成 `${schema}.custom.yaml`，若放任 `double_pinyin/../../x`
  // 通过，就会读写 ~/Library/Rime 之外的路径。
  if (/^(rime_ice|double_pinyin[A-Za-z0-9_-]*)$/.test(s)) return s;
  if (fallbackDefault) return 'rime_ice';
  throw new AppError(ERR.PARSE_FAILED, `无效方案名：${s}`);
}

/** 从 params 解析外观选择（skin 为空串=跳过；layout 非 1-4=跳过）。 */
function pickAppearance(params) {
  const skin = String(params.skin == null ? '' : params.skin).trim();
  // skin 会被 patchYaml 直接拼进 YAML 的**值位**（`style/color_scheme: <skin>`），
  // 带换行即可注入任意配置行 → 必须对照 SKIN_IDS 白名单，不能只 trim。
  if (skin && !SKIN_IDS.includes(skin)) throw new AppError(ERR.PARSE_FAILED, `无效皮肤名：${skin}`);
  const layoutDef = LAYOUTS.find((l) => l.index === Number.parseInt(String(params.layout == null ? '' : params.layout), 10)) || null;
  return { skin, layoutDef };
}

/**
 * 写入外观配置（patch → 落盘），apply_appearance 专用。
 */
function writeAppearanceConfig(ctx, skin, layoutDef) {
  if (!paths.exists(paths.RIME_DIR)) throw new AppError(ERR.NOT_FOUND, `Rime 目录不存在：${paths.RIME_DIR}`);
  // ★ 读失败必须中止（不能回落空串）：否则会在「读不到但可写」时把整份外观配置覆盖掉
  let text = readBeforeOverwrite(paths.RIME_CUSTOM);
  if (skin) {
    text = patchYaml(text, 'style/color_scheme', skin);
    text = patchYaml(text, 'style/color_scheme_dark', skin);
    ctx.log('info', `皮肤 → ${skin}（含暗色保持一致）`);
  }
  if (layoutDef) {
    text = patchYaml(text, 'style/candidate_list_layout', layoutDef.layout);
    text = patchYaml(text, 'style/text_orientation', layoutDef.orientation);
    ctx.log('info', `布局 → ${layoutDef.layout} / ${layoutDef.orientation}（${layoutDef.label}）`);
  }
  writeTextSafe(paths.RIME_CUSTOM, text);
  ctx.log('ok', '外观配置已更新');
}

/** 安装基座三连（git → plum → 主方案），install_or_update 专用。
 *  installed=true 表示本地已有主方案（走「更新词库」语义，步骤标题/日志随之变化）。 */
function installBaseSteps(installed) {
  return [
    { id: 'git', title: '检查 Git', run: async (ctx) => { await requireGit(ctx); } },
    { id: 'plum', title: '准备 plum', run: async (ctx) => { await ensurePlum(ctx); } },
    {
      id: 'vocab', title: installed ? '更新雾凇拼音词库' : '安装雾凇拼音主方案（默认配置）',
      timeoutMs: NET_TIMEOUT,
      run: async (ctx) => {
        // 官方推荐（iDvel/rime-ice README）：安装与更新是同一条命令
        // `rime-install iDvel/rime-ice`；默认即全拼雾凇拼音，无需任何额外参数。
        await runRimeInstall(ctx, 'iDvel/rime-ice');
        ctx.log('ok', installed ? '词库更新完成' : '主方案安装完成（默认配置）');
      },
    },
  ];
}

// —— 万象语法模型：下载（install_grammar）与应用/移除（apply_grammar / remove_grammar）分离 ——
// 模型是独立共享文件（下载一次全方案可用）；方案通过 ${schema}.custom.yaml 的 grammar 补丁决定是否启用。
const GRAMMAR_MODEL_NAME = 'wanxiang-lts-zh-hans.gram';
const GRAMMAR_MODEL_URL = `https://github.com/amzxyz/RIME-LMDG/releases/download/LTS/${GRAMMAR_MODEL_NAME}`;
/** 与雾凇官方 grammar 配方 patch/+/grammar 完全等价的 plain patch 格式 */
const GRAMMAR_PATCH_TEXT = `patch:
  grammar:
    language: wanxiang-lts-zh-hans
    collocation_max_length: 6
    collocation_min_length: 3
    collocation_penalty: -14
    non_collocation_penalty: -6
    weak_collocation_penalty: -100
    rear_penalty: -20
  translator/contextual_suggestions: false
  translator/max_homophones: 8
`;
function grammarCustomPath(schema) { return paths.RIME_DIR + '/' + schema + '.custom.yaml'; }
function grammarModelPath() { return paths.RIME_DIR + '/' + GRAMMAR_MODEL_NAME; }

/** 前置校验：万象模型文件已下载。 */
function requireGrammarModel(ctx) {
  if (!paths.exists(grammarModelPath())) {
    throw new AppError(ERR.NOT_FOUND, `未检测到万象模型（${GRAMMAR_MODEL_NAME}），请先执行「安装 / 更新万象模型」`, grammarModelPath());
  }
  ctx.log('ok', `万象模型已就位：${grammarModelPath()}`);
}

/** 各方案当前是否已应用语法补丁（按行判定 grammar:，注释里的不算）。 */
function readGrammarApplied() {
  return SCHEME_IDS.filter((s) => {
    const text = readTextSafe(grammarCustomPath(s));
    if (text === null) return false;
    return text.split(/\r?\n/).some((line) => {
      const t = line.trim();
      return t !== '' && !t.startsWith('#') && /^grammar\s*:/.test(t);
    });
  });
}

/** 语法补丁里由 MacKit 管理的键（合并 / 移除时用来定位）。 */
const GRAMMAR_KEYS = ['grammar', 'translator/contextual_suggestions', 'translator/max_homophones'];

/** 语法补丁正文：去掉 `patch:` 头行，并把缩进**归一化到 0 基准**（便于按容器缩进重新缩进）。 */
const GRAMMAR_BLOCK_LINES = Object.freeze(
  GRAMMAR_PATCH_TEXT.split('\n')
    .slice(1)                          // 第 0 行是 `patch:` 头
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() !== '')
    .map((l) => l.replace(/^ {2}/, ''))
);

/** 取行尾注释（`key: v # 注释` → ` # 注释`）；引号内的 `#` 不算。无注释返回 ''。 */
function trailingYamlComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && i > 0 && /\s/.test(line[i - 1])) return line.slice(i - 1);
  }
  return '';
}

/** 定位顶层 `patch:` 行（允许行尾注释）；`__patch:` 不算 —— 那是另一种机制，见 findRxPatchBody。 */
function findPatchLine(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^patch\s*:/.test(lines[i])) return i;
  }
  return -1;
}

/**
 * 定位 plum Rx 写法里的补丁体：`  - patch/+:` 这一行，体在它**之下**（缩进更深）。
 * 官方 grammar 配方生成的就是这种形态（本机 ~/Library/Rime/rime_ice.custom.yaml 即如此）。
 * @param {string[]} lines
 * @returns {{header:number, baseIndent:string}|null}
 */
function findRxPatchBody(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*-\s*patch\/\+:\s*(#.*)?$/.test(lines[i])) continue;
    const headerIndent = /^\s*/.exec(lines[i])[0];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (lines[j].trim() === '') continue;
      const ind = /^\s*/.exec(lines[j])[0];
      if (ind.length <= headerIndent.length) break;
      return { header: i, baseIndent: ind };
    }
    // 体为空：按「键列 + 2」缩进（`- key:` 的键列 = 破折号缩进 + 2）
    return { header: i, baseIndent: ' '.repeat(headerIndent.length + 4) };
  }
  return null;
}

/**
 * 把一个 grammar 补丁块合并进**已经取出的 patch 体**，返回新的体行。
 * @param {string[]} body 体行（保留原有缩进）
 * @param {string} baseIndent 体行的基准缩进
 * @returns {string[]}
 */
function mergeIntoPatchBody(body, baseIndent) {
  const baseLen = baseIndent.length;
  const out = [];
  let inGrammar = false;
  for (const line of body) {
    if (inGrammar) {
      // grammar 的子行比基准更深 → 一并摘掉
      if (line.trim() === '' || /^\s*/.exec(line)[0].length > baseLen) continue;
      inGrammar = false;
    }
    const m = /^\s*([A-Za-z_][\w/-]*)\s*:/.exec(line);
    if (m && GRAMMAR_KEYS.includes(m[1])) {
      if (m[1] === 'grammar') inGrammar = true;
      continue;
    }
    out.push(line);
  }
  return [...GRAMMAR_BLOCK_LINES.map((l) => baseIndent + l), ...out];
}

/**
 * 把语法补丁**合并**进已有的 ${schema}.custom.yaml —— 绝不覆盖用户自己的 patch。
 *
 * 语义：其它键原样保留；只把 MacKit 管的那几个键替换成最新值；没有 patch 容器就补一个。
 * 幂等：重复执行结果一致。
 *
 * ★ 2026-09-25 修（此前会**毁掉**官方 Rx 块）：本函数过去只认顶层 `patch:` 行，而 plum 的
 *   grammar 配方生成的是 `__patch:` + `  - patch/+:` 形态 —— 于是它既找不到容器（另起一个
 *   顶层 `patch:`，同一文件出现两套 patch 机制），又会把 `- patch/+:` 下的 `grammar:` 当
 *   「旧块」摘掉，把官方块掏空成 `- patch/+:`（值为 null）。现在两种写法都识别，并且只在
 *   **对应的容器体内部**做替换。
 * @param {string} text 现有文件内容
 * @returns {string} 合并后的内容
 */
function mergeGrammarPatch(text) {
  const lines = String(text == null ? '' : text).split('\n');
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();

  // ① plum Rx：`- patch/+:` 形态
  const rx = findRxPatchBody(lines);
  const container = rx || { header: findPatchLine(lines), baseIndent: '  ' };

  if (container.header < 0) {
    // 两种容器都没有 → 新建扁平 `patch:`
    return `${[...lines, 'patch:', ...GRAMMAR_BLOCK_LINES.map((l) => `  ${l}`)].join('\n')}\n`;
  }

  const headerIndent = /^\s*/.exec(lines[container.header])[0];
  // 容器体的范围：头行之后、缩进仍深于头行的行（尾部空行不算入）
  let start = container.header + 1;
  let end = start;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (/^\s*/.exec(line)[0].length <= headerIndent.length) break;
    end = i + 1;
  }
  while (end > start && lines[end - 1].trim() === '') end -= 1;

  const merged = mergeIntoPatchBody(lines.slice(start, end), container.baseIndent);
  return `${[...lines.slice(0, start), ...merged, ...lines.slice(end)].join('\n')}\n`;
}

/**
 * 为方案启用万象语法模型。
 * ★ 必须合并写入：${schema}.custom.yaml（尤其 rime_ice.custom.yaml）是用户最常放
 *   自定义补丁的文件，整文件覆盖会把用户补丁一并抹掉。
 */
function applyGrammarPatch(ctx, schema) {
  const p = grammarCustomPath(schema);
  // ★ 读失败必须中止（不能当成「文件为空」直接覆盖）—— 见 readBeforeOverwrite 的注释。
  const existing = readBeforeOverwrite(p);
  if (existing.trim() === '') {
    paths.writeText(p, GRAMMAR_PATCH_TEXT);
    ctx.log('ok', `已为 ${schema} 启用万象语法模型`);
    return;
  }
  const merged = mergeGrammarPatch(existing);
  if (merged === existing) { ctx.log('ok', `${schema} 的语法模型配置已是最新，无需改动`); return; }
  paths.writeText(p, merged);
  ctx.log('ok', `已把语法补丁合并进 ${schema}.custom.yaml（你原有的 patch 内容已保留）`);
  ctx.log('info', `  ${p}`);
}

/** removeGrammarPatch 的安全护栏：文件除语法补丁外不得含其他配置（注释行忽略）。 */
const GRAMMAR_PATCH_LINES = new Set([
  '__patch:', '- patch/+:', 'patch:', 'grammar:', 'language: wanxiang-lts-zh-hans',
  'collocation_max_length: 6', 'collocation_min_length: 3', 'collocation_penalty: -14',
  'non_collocation_penalty: -6', 'weak_collocation_penalty: -100', 'rear_penalty: -20',
  'translator/contextual_suggestions: false', 'translator/max_homophones: 8',
]);

/** 为方案停用万象：删除仅承载语法补丁的 ${schema}.custom.yaml；含其他配置则拒绝并提示手动处理。 */
function removeGrammarPatch(ctx, schema) {
  const p = grammarCustomPath(schema);
  if (!paths.exists(p)) { ctx.log('info', `${schema} 未启用语法模型，无需移除`); return; }
  // ★ 读失败不能报「未启用」（那是静默失败：用户以为移除成功）：存在却读不到 → 明确抛错。
  const text = readBeforeOverwrite(p);
  if (text.trim() === '') {
    // 空文件：没有任何补丁可移除，但仍按存在处理（下面会删掉这个空文件）
    ctx.log('info', `${schema}.custom.yaml 为空，直接删除`);
  }
  const foreign = text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !GRAMMAR_PATCH_LINES.has(l));
  if (foreign.length) {
    // ★ 错误码语义（2026-09-25 修）：这是「拒绝自动执行、需要人工判断」，不是 IO 故障；
    //   原先用 IO_ERROR → HTTP 500，把可处理的用户情形报成了服务端异常。
    throw new AppError(ERR.FORBIDDEN, `${schema}.custom.yaml 含语法补丁之外的配置，为避免误删请手动处理：${p}`, foreign.slice(0, 3).join(' | '));
  }
  try { fs.unlinkSync(p); }
  catch (err) { throw new AppError(ERR.IO_ERROR, `删除 ${p} 失败`, String(err && err.message)); }
  ctx.log('ok', `已移除 ${schema} 的万象语法模型补丁（重新部署后生效）`);
}

/** 安装 / 更新万象模型步骤：直接从 RIME-LMDG 官方 release 下载（与 plum 配方的 download_files 同源同 URL），不碰任何方案配置。 */
function grammarDownloadStep() {
  return {
    id: 'download', title: `下载万象模型（${GRAMMAR_MODEL_NAME}，约 400MB）`, timeoutMs: NET_TIMEOUT,
    run: async (ctx) => {
      const target = grammarModelPath();
      const tmp = target + '.download';
      // ★ 2026-09-21 修复：清理 tmp 必须覆盖「抛异常」路径。以前只在 curl 返回非零码时
      //   删 .download；而用户取消 / 超时 / 代理失败都会让 runNet **抛 AppError**，
      //   流程直接跳走，那个约 400MB 的半成品文件就永久留在磁盘上没人回收。
      //   这里用 moved 标记 + finally：任何失败（抛异常或非零码）都清掉 tmp，
      //   只有成功 rename 到 target 后才保留（EPERM → copyFileSync + unlink 同属成功）。
      let moved = false;
      try {
        ctx.log('info', `开始下载：${GRAMMAR_MODEL_URL}`);
        const res = await runNet(ctx, '下载万象模型', 'curl',
          ['-fsSL', '--retry', '2', '--max-time', '1700', '-o', tmp, GRAMMAR_MODEL_URL],
          { timeoutMs: NET_TIMEOUT });
        if (res.code !== 0) {
          throw new AppError(ERR.NET_UNREACHABLE, `模型下载失败（curl 退出码 ${res.code}），可稍后重试`);
        }
        // 常驻进程 rename 可能被 macOS 拒（EPERM，见 store.js writeJsonSafe 同款注释）→ 降级复制
        try {
          fs.renameSync(tmp, target);
        } catch (err) {
          if (err && err.code === 'EPERM') { fs.copyFileSync(tmp, target); fs.unlinkSync(tmp); }
          else { throw err; }
        }
        moved = true;
        ctx.log('ok', `模型已就位：${target}`);
      } finally {
        // 失败路径（含 runNet 抛出的取消 / 超时 / 代理错误，以及非 EPERM 的 rename 失败）统一回收半成品
        if (!moved) { try { fs.unlinkSync(tmp); } catch { /* 文件可能本就没生成，忽略 */ } }
      }
    },
  };
}

const DEPLOY_STEP = { id: 'deploy', title: '重新部署', run: async (ctx) => { await deployRime(ctx); } };

// ---------------------------------------------------------------------------
// 动作定义
// ---------------------------------------------------------------------------
const actions = {
  /** 安装 / 更新词库：先判断本地是否已安装——
   *  未安装 → 按默认配置完整安装一次；已安装 → 仅更新词库（同一条官方命令）。 */
  install_or_update: {
    title: '安装/更新词库',
    destructive: false,
    steps: () => {
      const installed = paths.exists(paths.RIME_MAIN_SCHEMA);
      return [
        {
          id: 'check', title: '检查本地安装状态',
          run: async (ctx) => {
            if (installed) ctx.log('info', `已检测到主方案（${paths.RIME_MAIN_SCHEMA}），本次执行词库更新`);
            else ctx.log('info', '未检测到本地安装，本次将按默认配置完整安装雾凇拼音');
          },
        },
        ...installBaseSteps(installed),
        DEPLOY_STEP,
      ];
    },
  },

  /** 安装 / 更新万象模型：仅下载模型文件（已存在则覆盖更新），不改任何方案配置。
   *  与「应用到方案」分离——首次使用可先只下载，之后再选方案应用。 */
  install_grammar: {
    title: '安装/更新万象模型',
    destructive: false,
    steps: () => [grammarDownloadStep()],
  },

  /** 应用万象模型到指定方案：写 ${schema}.custom.yaml 语法补丁 + 重新部署（confirm）。
   *  前置：模型文件已下载（不要求主方案——补丁本身独立于主方案安装状态）。 */
  apply_grammar: {
    title: '应用语法模型到方案',
    destructive: true,
    steps: (params) => {
      const schema = resolveScheme(params.schema, true);
      return [
        { id: 'check', title: '检查万象模型', run: async (ctx) => { requireGrammarModel(ctx); } },
        { id: 'write', title: `为 ${schema} 启用万象`, run: async (ctx) => { applyGrammarPatch(ctx, schema); } },
        DEPLOY_STEP,
      ];
    },
  },

  /** 从指定方案移除万象模型补丁：删除仅承载补丁的 ${schema}.custom.yaml + 重新部署（confirm）。 */
  remove_grammar: {
    title: '从方案移除语法模型',
    destructive: true,
    steps: (params) => {
      const schema = resolveScheme(params.schema, true);
      return [
        { id: 'remove', title: `移除 ${schema} 的语法补丁`, run: async (ctx) => { removeGrammarPatch(ctx, schema); } },
        DEPLOY_STEP,
      ];
    },
  },

  /** 应用外观（皮肤 / 布局）——危险操作：写 squirrel.custom.yaml（confirm:true） */
  apply_appearance: {
    title: '应用外观（皮肤/布局）',
    destructive: true,
    steps: (params) => {
      const { skin, layoutDef } = pickAppearance(params);
      return [{
        id: 'appearance', title: '写入外观配置',
        run: async (ctx) => {
          if (!skin && !layoutDef) { ctx.log('warn', '未选择皮肤或布局，未做任何更改'); return; }
          writeAppearanceConfig(ctx, skin, layoutDef);
          await deployRime(ctx);
        },
      }];
    },
  },

};

// ---------------------------------------------------------------------------
// 只读查询
// ---------------------------------------------------------------------------

/** GET /api/rime/skins → SkinResult */
async function querySkins() { return readSkins(); }

const RIME_ICE_DICT_RAW = 'https://raw.githubusercontent.com/iDvel/rime-ice/main/rime_ice.dict.yaml';
/** 词库分片目录的提交 Atom 源（非 GitHub REST API：无认证限流问题）。
 *  上游日常词库更新（加词/修词）改的是 cn_dicts/*.yaml（中文）与 en_dicts/*.yaml（英文），
 *  主文件 rime_ice.dict.yaml 及其 version 字段可能长期不动（实测 2026-09-14 的 3 次 dict
 *  提交均在 en_dicts，主文件停在 2026-01-26），因此「有没有新版本」以两个分片目录的
 *  最新提交时间为准，version 仅作参考展示。 */
const RIME_ICE_DICT_ATOMS = [
  'https://github.com/iDvel/rime-ice/commits/main/cn_dicts.atom',
  'https://github.com/iDvel/rime-ice/commits/main/en_dicts.atom',
];

/**
 * 解析 Atom feed 第一条 <entry> 的 updated/title（纯函数）。
 * 注意：① <feed> 根节点自身也有 <updated>，必须锚定 <entry> 内的；
 *      ② GitHub 的 entry 里 <title> 在 <updated> **之前**，不能假设顺序——
 *         先截取整块 <entry>…</entry> 再在块内分别提取。
 * @param {string} xml
 * @returns {{date: string, title: string}|null}
 */
function parseAtomLatest(xml) {
  const entry = /<entry>([\s\S]*?)<\/entry>/.exec(String(xml == null ? '' : xml));
  if (!entry) return null;
  const d = /<updated>([^<]+)<\/updated>/.exec(entry[1]);
  const t = /<title>([\s\S]*?)<\/title>/.exec(entry[1]);
  if (!d || !t) return null;
  return { date: d[1].trim(), title: t[1].replace(/\s+/g, ' ').trim().slice(0, 120) };
}

/** 本地词库最近同步时间：主 dict + cn_dicts/ + en_dicts/ 下 yaml 的最大 mtime（ms；无文件时 null）。 */
function localDictMtime() {
  let latest = 0;
  const dirs = [null, paths.RIME_CN_DICTS, paths.RIME_EN_DICTS];
  const files = [paths.RIME_MAIN_DICT];
  for (const d of dirs) {
    if (!d) continue;
    try {
      for (const f of fs.readdirSync(d)) {
        if (f.endsWith('.yaml')) files.push(d + '/' + f);
      }
    } catch { /* 目录不存在（旧版安装），忽略 */ }
  }
  for (const p of files) {
    try { latest = Math.max(latest, fs.statSync(p).mtimeMs); } catch { /* 忽略 */ }
  }
  return latest || null;
}

/**
 * GET /api/rime/upstream → 上游词库更新检测（代理优先）。
 * 判定逻辑：本地词库文件（主 dict + cn_dicts/ + en_dicts/）的最大 mtime 对比上游
 * cn_dicts / en_dicts 两个分片目录的最近一次提交时间（取较新者）——mtime 即 plum
 * 上次安装/更新写文件的时间，晚于上游最新提交 ⇒ 已是最新。
 * 直接比较毫秒（宁报「有更新」也不漏报：同日早于提交的边界会提示再更新一次，无害）。
 */
async function queryUpstream() {
  const localVersion = parseDictVersion(readTextSafe(paths.RIME_MAIN_DICT));
  const localSyncedAt = localDictMtime();
  const results = await Promise.all(RIME_ICE_DICT_ATOMS.map(async (url) => {
    try {
      const res = await exec.runWithChannel(netPolicy({}), '拉取上游词库提交记录', 'curl',
        ['-fsSL', '--max-time', '30', url], { timeoutMs: 45_000 });
      if (res.code === 0) return parseAtomLatest(res.stdout);
      return null;
    } catch { return null; }
  }));
  const found = results.filter(Boolean).sort((a, b) => Date.parse(b.date) - Date.parse(a.date));
  const upstreamLatest = found[0] || null;
  const remoteError = upstreamLatest ? null : '上游提交记录拉取失败（两个词库目录均未成功）';
  const commitMs = upstreamLatest ? Date.parse(upstreamLatest.date) : NaN;
  const upToDate = (localSyncedAt && Number.isFinite(commitMs)) ? localSyncedAt >= commitMs : null;
  return {
    localVersion,
    localSyncedAt,
    upstreamLatest,
    upToDate,
    remoteError,
    dictUrl: RIME_ICE_DICT_RAW,
    checkedAt: Date.now(),
  };
}

/**
 * 外观总览（供前端渲染当前值 + 可选项）：当前皮肤/布局/方向 + 8 方案 + 4 布局 + 皮肤来源。
 * 注：REST 表中 `/api/rime/status` 直接取 env.snapshot().rime；本查询为模块扩展点。
 */
async function queryAppearance() {
  const snap = await env.snapshot();
  return {
    status: snap.rime,
    current: readCurrentAppearance(),
    currentSchema: readCurrentSchema(),
    schemes: SCHEME_IDS.map((id, i) => ({ id, name: SCHEME_NAMES[i] })),
    layouts: LAYOUTS.map((l) => ({ ...l })),
    grammarModels: readGrammarModels(),
    grammarApplied: readGrammarApplied(),
  };
}

export default {
  id: 'rime',
  actions,
  queries: {
    skins: querySkins,
    appearance: queryAppearance,
    upstream: queryUpstream,
  },
};
