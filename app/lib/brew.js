/**
 * MacKit · M2 Homebrew 管家（后端模块）
 *
 * 依据《MacKit-架构设计.md》§3.7 / §3.12 与《MacKit-PRD.md》§3 M2 表，
 * 语义移植自原 `shell/brewgo.sh`（参考脚本已于 2026-09-16 从仓库移除，本文件为该功能的唯一事实源）。
 *
 * 契约：
 *   - 默认导出 ModuleDefinition { id:'brew', actions, queries }
 *   - actions[action] = { title, destructive?, steps(params, ctx), finalize? }
 *   - queries[name]   = (params) => Promise<data>   （只读；本文件直接用 lib/exec.js，不经 task signal）
 *
 * brew 7 容错：`brew tap` 空输出属正常（US-7）；所有 JSON 解析 try/catch 降级为空数组。
 * 只读命令统一注入 HOMEBREW_NO_AUTO_UPDATE=1，避免隐式自动更新导致的 index.lock 冲突与噪声。
 * 端口 / 镜像源读写一律走 store.readBrewgo() / store.writeBrewgo()。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';

const { ERR, AppError } = exec;

/** 只读/升级命令的通用环境（关闭隐式自动更新） */
const BREW_ENV = Object.freeze({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' });
/** 核心 Tap（卸载需加强警告，复刻 brewgo.sh:355） */
const CORE_TAPS = Object.freeze(['homebrew/core', 'homebrew/cask']);
/** 升级类超时 1800s */
const UPGRADE_TIMEOUT = 1_800_000;

// ------------------------------ 小工具 ------------------------------
function lineList(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/** 读取 MacKit 配置（默认通道 / 自动降级）。 */
function cfg() {
  try { return store.readMackit(); } catch { return { defaultChannel: 'auto', autoFallback: true }; }
}

/**
 * 按 autoFallback 开关决定「多通道尝试」还是「单通道」。
 * autoFallback=false 时只试首选通道并失败即终止（MK-M2-21）。
 */
async function runPolicy(ctx, policy, desc, args, opts = {}) {
  const c = cfg();
  const onAttempt = (ch, phase) => {
    const label = ch === 'proxy' ? '代理' : '直连';
    if (phase === 'try') ctx.log('info', `尝试${label}执行: ${desc} ...`);
    else if (phase === 'ok') ctx.log('ok', `${desc} 成功 (使用${label})`);
    else ctx.log('warn', `${desc} 失败，尝试另一种方式...`);
  };
  const common = {
    env: BREW_ENV,
    timeoutMs: UPGRADE_TIMEOUT,
    onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
    ...opts,
  };
  if (c.autoFallback === false) {
    const channel = policy === 'proxy_first' ? 'proxy' : 'direct';
    ctx.log('info', `尝试${channel === 'proxy' ? '代理' : '直连'}执行: ${desc} ...`);
    const res = await ctx.exec.run('brew', args, { ...common, channel });
    if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, `${desc}失败`, (res.stderr || '').trim().split('\n').slice(-3).join('\n'));
    ctx.setChannel(channel);
    ctx.log('ok', `${desc} 成功 (使用${channel === 'proxy' ? '代理' : '直连'})`);
    return { ...res, channel };
  }
  const res = await ctx.exec.runWithChannel(policy, desc, 'brew', args, { ...common, onAttempt });
  ctx.setChannel(res.channel);
  return res;
}

/**
 * 批量动作终态：只要不是「全部失败」，任务算 ok（复刻原脚本不中断语义）。
 * ★ 自动清理收尾步骤（id='autoclean'）的成败不计入「软件包成功数」：
 *   它既不影响任务终态判定，也不污染用户可读的成功/跳过/失败计数，
 *   其执行结果仅在日志中体现（避免用户误以为多升级了一个包）。
 */
function finalizeBatch(task, { log }) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  const counts = { ok: 0, fail: 0, skip: 0 };
  for (const s of steps) {
    if (s.id === 'autoclean') continue; // 收尾清理步骤不参与软件包计数
    if (s.status === 'ok') counts.ok += 1;
    else if (s.status === 'fail') counts.fail += 1;
    else if (s.status === 'skip' || s.status === 'cancelled') counts.skip += 1;
  }
  const autoCleanRan = steps.some((s) => s.id === 'autoclean' && s.status === 'ok');
  const { ok, fail, skip } = counts;
  task.counts = { ok, fail, skip }; // 回写修正后的计数（供 UI / 历史读取）

  // 取消优先：不得把已取消的任务改写为 ok
  if (task.status === 'cancelled') {
    log('info', `任务已取消：成功 ${ok} / 跳过 ${skip} / 失败 ${fail}`);
    return;
  }
  if (fail > 0 && ok === 0 && skip === 0) {
    task.status = 'fail';
  } else {
    task.status = 'ok';
    task.error = null;
  }
  log('info', `处理完成: 成功 ${ok} 个 / 跳过 ${skip} 个 / 失败 ${fail} 个${autoCleanRan ? '（另含 1 次自动清理缓存，不计入上述成功数）' : ''}`);
}

// ------------------------------ 只读查询 ------------------------------
/** 解析 `brew outdated --json=v2` 的单段。 */
function parseOutdatedJson(text, key) {
  try {
    const obj = JSON.parse(String(text || '{}'));
    const arr = Array.isArray(obj[key]) ? obj[key] : [];
    return arr.map((it) => ({
      name: it.name,
      current: Array.isArray(it.installed_versions) && it.installed_versions.length
        ? it.installed_versions.join(', ') : null,
      latest: typeof it.current_version === 'string' ? it.current_version : null,
    }));
  } catch { return null; }
}

async function queryOutdated() {
  const formulae = await querySection('formulae');
  const casks = await querySection('casks');
  const checkedAt = Date.now();
  try { store.writeMackit({ lastCheckedAt: checkedAt }); } catch { /* ignore */ }
  return { formulae, casks, counts: { formula: formulae.length, cask: casks.length }, checkedAt };
}

async function querySection(kind) {
  const isCask = kind === 'casks';
  const args = isCask
    ? ['outdated', '--json=v2', '--cask', '--greedy']
    : ['outdated', '--json=v2', '--formula'];
  const res = await safeRun('brew', args);
  const parsed = res.code === 0 ? parseOutdatedJson(res.stdout, kind) : null;
  if (parsed) return parsed;
  // 降级：名字列表（brew 7 --quiet 输出，MK-M2-10 数据源）
  const quietArgs = isCask
    ? ['outdated', '--cask', '--greedy', '--quiet']
    : ['outdated', '--formula', '--quiet'];
  const q = await safeRun('brew', quietArgs);
  return lineList(q.stdout).map((n) => ({ name: n, current: null, latest: null }));
}

async function queryInstalled() {
  const f = await safeRun('brew', ['list', '--formula']);
  const c = await safeRun('brew', ['list', '--cask']);
  const t = await safeRun('brew', ['tap']);
  return {
    formulae: lineList(f.stdout),
    casks: lineList(c.stdout),
    // brew 7 下 brew tap 输出为空属正常（US-7），必须返回空数组而非报错
    taps: lineList(t.stdout),
  };
}

async function queryInfo(params) {
  const kind = params.kind === 'formula' ? '--formula' : '--cask';
  const name = String(params.name || '');
  if (!name) return { lines: [] };
  const res = await safeRun('brew', ['info', kind, name]);
  // 复刻 uninstall_one_cask 的 `head -5 | sed 's/^/  /'`
  const out = lineList(res.stdout).slice(0, 5).map((l) => `  ${l}`);
  if (out.length === 0 && res.stderr.trim()) {
    out.push(...lineList(res.stderr).slice(0, 5).map((l) => `  ${l}`));
  }
  return { lines: out };
}

/** 直连执行并吞异常（只读查询用，无 task signal）。 */
async function safeRun(bin, args, opts = {}) {
  try {
    return await exec.run(bin, args, { env: BREW_ENV, timeoutMs: 120_000, ...opts });
  } catch (err) {
    return { code: -1, stdout: '', stderr: (err && err.message) || String(err) };
  }
}

// ------------------------------ Cask 搜索（2026-09-16 新增：Cask 下载页） ------------------------------
/** 搜索结果展示上限（超出时前端提示「显示前 N 个」）。 */
export const CASK_SEARCH_LIMIT = 30;
/** 合法 Cask token（防注入：名称最终会作为 spawn 参数，只放行 brew token 字符集）。 */
const CASK_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;

/**
 * 解析 `brew search --casks <q>` 的 token 列表（纯函数，可单测）。
 * 实测两种形态（2026-09-16，brew 4.x）：
 *   - TTY：`==> Casks` 段头 + 多列表格（一行多个 token，可带 ✔/✘、(disabled) 标记）
 *   - 非 TTY（服务端 spawn 即此形态）：无段头，每行一个 token
 * 所以：有段头时只取 Casks 段；全程无段头时把所有行都视为 cask token。
 */
export function parseCaskSearchTokens(text) {
  const out = [];
  const seen = new Set();
  const pushToken = (t) => {
    if (t && CASK_TOKEN_RE.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  };
  let inCasks = null; // null=尚未见到任何段头
  let sawHeader = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('==>')) {
      sawHeader = true;
      inCasks = /^==>\s*Casks/i.test(line);
      continue;
    }
    if (sawHeader && inCasks === false) continue; // 其他段（如 Formulae）
    for (const word of line.split(/\s+/)) {
      pushToken(word.replace(/[✔✘]+$/, ''));
    }
  }
  return out;
}

/**
 * 解析 `brew info --cask --json=v2 <tokens...>` 的结果为 token→详情映射（纯函数，可单测）。
 * 注意 JSON v2 里 cask 的 name 是数组；installed 可为版本字符串 / null / 缺失。
 */
export function parseCaskInfoJson(text) {
  const map = new Map();
  try {
    const obj = JSON.parse(String(text || '{}'));
    const arr = Array.isArray(obj.casks) ? obj.casks : [];
    for (const c of arr) {
      if (!c || typeof c.token !== 'string' || !CASK_TOKEN_RE.test(c.token)) continue;
      const name = Array.isArray(c.name) ? c.name.filter((n) => typeof n === 'string').join(' / ')
        : (typeof c.name === 'string' ? c.name : c.token);
      let installed = null;
      if (typeof c.installed === 'string' && c.installed) installed = c.installed;
      else if (c.installed && typeof c.installed === 'object' && typeof c.installed.version === 'string') installed = c.installed.version;
      map.set(c.token, {
        name: name || c.token,
        desc: typeof c.desc === 'string' ? c.desc : '',
        version: typeof c.version === 'string' ? c.version : null,
        installed,
      });
    }
  } catch { /* 降级为空映射：结果行回退为裸 token */ }
  return map;
}

/**
 * Cask 搜索：本地索引打分（支持中文名称，对标官网 Algolia）→ `brew info --json=v2` 批量补详情。
 * 索引不可用（下载失败且无缓存）时回退 `brew search --casks`（仅英文，兜底）。
 */
async function queryCaskSearch(params) {
  const q = String((params && params.q) || '').trim();
  if (!q) return { query: q, results: [], total: 0, limit: CASK_SEARCH_LIMIT, indexedAt: null };
  let tokens = null;
  let indexedAt = null;
  try {
    const idx = await ensureCaskIndex();
    const hits = searchCaskIndex(idx.casks, q, CASK_SEARCH_LIMIT);
    tokens = hits.items.map((c) => c.t);
    indexedAt = idx.builtAt;
  } catch (err) {
    if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    tokens = null; // 回退路径
  }
  if (tokens === null) {
    // 兜底：brew 自带搜索（不支持中文；中文查询会得到全量列表，仅在索引不可用时凑合）
    const res = await safeRun('brew', ['search', '--casks', q]);
    tokens = parseCaskSearchTokens(res.stdout);
    if (tokens.length === 0) {
      const errText = (res.stderr || '').trim();
      if (!(res.code === 0 || /no (available )?(formulae or casks|formula|cask)/i.test(errText) || errText === '')) {
        throw new AppError(ERR.CMD_FAILED, 'Cask 搜索失败', errText.split('\n').slice(-3).join('\n'));
      }
    }
  }
  const total = tokens.length;
  const shown = tokens.slice(0, CASK_SEARCH_LIMIT).filter((t) => CASK_TOKEN_RE.test(t));
  if (shown.length === 0) return { query: q, results: [], total: 0, limit: CASK_SEARCH_LIMIT, indexedAt };
  const info = await safeRun('brew', ['info', '--cask', '--json=v2', ...shown]);
  const map = parseCaskInfoJson(info.stdout);
  const results = shown.map((t) => ({ token: t, ...(map.get(t) || { name: t, desc: '', version: null, installed: null }) }));
  return { query: q, results, total, limit: CASK_SEARCH_LIMIT, indexedAt };
}

// ------------------------------ Cask 本地索引（对标 formulae.brew.sh 的 Algolia 搜索） ------------------------------
// 官网搜索（Algolia）索引了 token + 名称（含中文名）+ 描述；brew search 只匹配 token/英文描述，
// 且对中文查询会退化为全量结果。故下载一次全量 cask 元数据建本地索引，缓存 24h，搜索全程本地打分。

const CASK_INDEX_TTL_MS = 24 * 60 * 60 * 1000;
/** 索引合法下限：低于此条数视为下载内容异常（防止把错误页缓存下来）。 */
const CASK_INDEX_MIN = 100;

function caskIndexPath() { return path.join(paths.CACHE_DIR, 'cask-index.json'); }

/** 镜像源对应的 cask.json API 地址（与 exec.MIRROR_REMOTES 同一套映射）。 */
function caskApiUrl() {
  let mirror = 'official';
  try { mirror = store.readBrewgo().mirror || 'official'; } catch { /* ignore */ }
  const remote = exec.MIRROR_REMOTES[mirror];
  if (remote) return `${remote.replace(/\/brew\.git$/, '')}/homebrew-bottles/api/cask.json`;
  return 'https://formulae.brew.sh/api/cask.json';
}

/**
 * 全量 cask.json → 精简索引（纯函数，可单测）。
 * 条目：{ t:token, n:名称（数组以 ' / ' 连接，含中文名）, d:描述, v:版本 }。
 */
export function buildSlimCaskIndex(jsonText) {
  let obj;
  try { obj = JSON.parse(String(jsonText || '[]')); } catch { return []; }
  const arr = Array.isArray(obj) ? obj : [];
  const casks = [];
  for (const c of arr) {
    if (!c || typeof c.token !== 'string' || !CASK_TOKEN_RE.test(c.token)) continue;
    const name = Array.isArray(c.name) ? c.name.filter((n) => typeof n === 'string').join(' / ')
      : (typeof c.name === 'string' ? c.name : '');
    casks.push({
      t: c.token,
      n: name,
      d: typeof c.desc === 'string' ? c.desc : '',
      v: typeof c.version === 'string' ? c.version : '',
    });
  }
  return casks;
}

/**
 * 本地打分搜索（纯函数，可单测）。
 * 排序权重：token 完全匹配 > token 前缀 > token 包含 > 名称包含（支持中文）> 描述包含；
 * 同分按 token 字典序。返回 { items, total }（items 截取前 limit 条，total 为全部命中数）。
 */
export function searchCaskIndex(casks, q, limit = CASK_SEARCH_LIMIT) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { items: [], total: 0 };
  const scored = [];
  for (const c of casks) {
    const token = c.t.toLowerCase();
    const name = (c.n || '').toLowerCase();
    const desc = (c.d || '').toLowerCase();
    let score = 0;
    if (token === query) score = 100;
    else if (token.startsWith(query)) score = 80;
    else if (token.includes(query)) score = 60;
    else if (name.includes(query)) score = 50;
    else if (desc.includes(query)) score = 20;
    if (score > 0) scored.push({ score, c });
  }
  scored.sort((a, b) => b.score - a.score || a.c.t.localeCompare(b.c.t));
  return { items: scored.slice(0, limit).map((x) => x.c), total: scored.length };
}

/** 读磁盘索引缓存（损坏/缺失返回 null）。 */
function readIndexCache() {
  try {
    const obj = JSON.parse(fs.readFileSync(caskIndexPath(), 'utf8'));
    if (obj && typeof obj.builtAt === 'number' && Array.isArray(obj.casks)) return obj;
  } catch { /* ignore */ }
  return null;
}

function writeIndexCache(casks) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(caskIndexPath(), JSON.stringify({ builtAt: Date.now(), casks }), 'utf8');
  } catch { /* 缓存写失败不影响本次搜索 */ }
}

/**
 * 直连优先（失败换代理）下载全量 cask.json。
 * ★ 必须用 `curl -o 临时文件` 落盘再读：exec 层 stdout 捕获上限 4MB，
 *   而 cask.json 约 18MB，走 stdout 会被静默截断导致 JSON 解析失败（2026-09-16 实测踩坑）。
 */
async function downloadCaskIndex() {
  const url = caskApiUrl();
  const tmpFile = `${caskIndexPath()}.download`;
  try {
    await exec.runWithChannel('direct_first', '下载 Cask 索引', 'curl',
      ['-fsSL', '--max-time', '180', '-o', tmpFile, url],
      { timeoutMs: 200_000, env: { HOMEBREW_NO_ENV_HINTS: '1' } });
    const raw = fs.readFileSync(tmpFile, 'utf8');
    const casks = buildSlimCaskIndex(raw);
    if (casks.length < CASK_INDEX_MIN) {
      throw new AppError(ERR.PARSE_FAILED, 'Cask 索引内容异常', `仅解析到 ${casks.length} 条`);
    }
    return casks;
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}

/** 内存态（含单飞去重）：并发搜索只触发一次下载。 */
let caskIndexState = { at: 0, casks: null, loading: null };

/**
 * 确保索引可用：内存 → 24h 内磁盘缓存 → 下载；下载失败时回退旧磁盘缓存。
 * 返回 { casks, builtAt, source }，source ∈ memory|cache|downloaded|stale；全不可用则 throw。
 */
async function ensureCaskIndex() {
  if (caskIndexState.casks && Date.now() - caskIndexState.at < CASK_INDEX_TTL_MS) {
    return { casks: caskIndexState.casks, builtAt: caskIndexState.at, source: 'memory' };
  }
  const cached = readIndexCache();
  if (cached && Date.now() - cached.builtAt < CASK_INDEX_TTL_MS) {
    caskIndexState = { at: cached.builtAt, casks: cached.casks, loading: null };
    return { casks: cached.casks, builtAt: cached.builtAt, source: 'cache' };
  }
  if (!caskIndexState.loading) {
    caskIndexState.loading = downloadCaskIndex()
      .then((casks) => {
        const at = Date.now();
        caskIndexState = { at, casks, loading: null };
        writeIndexCache(casks);
        return { casks, builtAt: at, source: 'downloaded' };
      })
      .catch((err) => {
        caskIndexState.loading = null;
        throw err;
      });
  }
  try {
    return await caskIndexState.loading;
  } catch (err) {
    if (cached) return { casks: cached.casks, builtAt: cached.builtAt, source: 'stale' };
    if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    throw new AppError(ERR.NET_UNREACHABLE, 'Cask 索引下载失败（且无本地缓存）', (err && err.message) || String(err));
  }
}

// ------------------------------ Homebrew 一键安装 / 环境配置（2026-09-16 新增） ------------------------------
// 官方安装脚本：https://brew.sh 使用的 install.sh（raw.githubusercontent.com）。
// 中国网络下 raw 常不可达，追加 jsDelivr CDN 镜像作为备用地址。
const INSTALL_SCRIPT_URLS = Object.freeze([
  'https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh',
  'https://cdn.jsdelivr.net/gh/Homebrew/install@HEAD/install.sh',
]);
/** 脚本健全性下限（官方脚本约 33KB；明显偏小说明下到了错误页）。 */
const INSTALL_SCRIPT_MIN_BYTES = 5_000;

/**
 * 官方推荐写入 shell 配置的那一行（显式指定 shell）。
 * 官方 install.sh 的 `Next steps` 提示为 `eval "$(<prefix>/bin/brew shellenv zsh)"`。
 */
export function buildShellenvLine(prefix, shell = 'zsh') {
  return `eval "$(${prefix}/bin/brew shellenv ${shell})"`;
}

/**
 * 生成「追加到 rc 文件」的完整新内容（纯函数，可单测）。
 *
 * 等效官方给出的前两条命令：
 *   ① `echo >> <rc>`          —— 补一个换行（原文末尾无换行时，直接追加会把新配置
 *                                粘到最后一行命令尾部，导致配置失效）
 *   ② `echo '<line>' >> <rc>` —— 追加配置行
 * 因此：原文非空且末尾无换行 → 补一个 \n；已有换行 → 多出一个空行（与官方一致）。
 * 注意绝不 trim 原文，保留用户文件原有结尾内容。
 */
export function buildShellenvBlock(existingText, line) {
  const text = String(existingText || '');
  const head = text === '' ? '' : `${text}\n`;
  return `${head}# Added by MacKit (Homebrew)\n${line}\n`;
}

/** 判断 rc 文件内容是否已包含 brew shellenv 配置（纯函数，可单测）。 */
export function isShellenvConfigured(text) {
  return /brew\s+shellenv/.test(String(text || ''));
}

/**
 * 临时 sudo 密码助手：Homebrew 官方脚本在 macOS 上强制要求管理员权限，
 * 非交互运行时通过 SUDO_ASKPASS 索取密码。密码由 osascript 直接交给 sudo，
 * MacKit 不读取、不记录、不留存；安装结束后助手脚本立即删除。
 */
const ASKPASS_SCRIPT = `#!/bin/bash
# MacKit 临时 sudo 密码助手（安装结束即删除；密码仅交给 sudo，不经过 MacKit）
/usr/bin/osascript -e 'set r to display dialog "MacKit 正在安装 Homebrew，需要管理员权限。\\n\\n请输入你的登录密码（仅本次授权使用，不会被记录或保存）：" default answer "" with hidden answer with title "MacKit · 安装 Homebrew" buttons {"取消", "继续"} default button "继续" with icon caution' -e 'text returned of r'
`;

/** 选择 shellenv 写入目标：zsh → ~/.zprofile，bash → ~/.bash_profile（判定在 paths.js）。 */
function shellenvTarget() {
  return { rcFile: paths.SHELL_RC, kind: paths.SHELL_KIND };
}

// 统一实现见 lib/paths.js（2026-09-16 收敛 6 份重复）
const readTextSafe = paths.readTextSafe;

/**
 * 「写入 shellenv 到 rc 文件」步骤（安装后自动执行；也供 setup_shellenv 单独调用）。
 * 幂等：已含 brew shellenv 则跳过，绝不重复追加。
 */
function shellenvStep() {
  return {
    id: 'shellenv', title: '配置 shell 环境变量',
    run: async (ctx) => {
      const { rcFile, kind } = shellenvTarget();
      const line = buildShellenvLine(paths.BREW_PREFIX, kind);
      const text = readTextSafe(rcFile) || '';
      if (isShellenvConfigured(text)) {
        ctx.log('ok', `${rcFile} 已包含 brew shellenv 配置，无需重复写入`);
      } else {
        // 等效官方 Next steps 的前两条命令（echo >> rc；echo '<line>' >> rc）
        const block = buildShellenvBlock(text, line);
        try {
          fs.writeFileSync(rcFile, block, 'utf8');
        } catch (err) {
          throw new AppError(ERR.IO_ERROR, `写入 ${rcFile} 失败`, String(err && err.message));
        }
        ctx.log('ok', `已向 ${rcFile}（${kind}）追加环境配置`);
        if (text !== '') ctx.log('info', `  补空行分隔（等效官方 echo >> ${rcFile}）`);
        ctx.log('info', '  # Added by MacKit (Homebrew)');
        ctx.log('info', `  ${line}`);
      }
      // 输出 brew shellenv 的实际内容，便于用户对照（不逐行回显，避免与下面的缩进输出重复）
      let shellenvOut = '';
      try {
        const r = await ctx.exec.run('brew', ['shellenv', kind], { env: BREW_ENV, timeoutMs: 30_000 });
        shellenvOut = r.stdout;
      } catch (err) {
        if (err && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
      }
      for (const l of lineList(shellenvOut)) ctx.log('info', `  ${l}`);
      // 官方 Next steps 的第 3 条命令：只让「当前终端」立即生效，不写入任何文件
      ctx.log('info', `如需当前终端立即生效（官方第 3 条命令）：${line}`);
      ctx.log('info', `或执行：source ${rcFile}（新开终端会自动生效）`);
    },
  };
}

/** 下载官方安装脚本到缓存目录（代理优先），返回脚本路径。 */
async function downloadInstallScript(ctx) {
  const target = path.join(paths.CACHE_DIR, 'homebrew-install.sh');
  let lastErr = null;
  for (const url of INSTALL_SCRIPT_URLS) {
    try {
      ctx.log('info', `下载官方安装脚本：${url}`);
      await ctx.exec.run('curl', ['-fsSL', '--max-time', '120', '-o', target, url], {
        timeoutMs: 150_000, channel: 'proxy',
        onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
      });
      const text = readTextSafe(target) || '';
      if (text.includes('#!/bin/bash') && text.length >= INSTALL_SCRIPT_MIN_BYTES) {
        ctx.log('ok', `脚本已就绪（${text.length} 字节）`);
        return target;
      }
      lastErr = new AppError(ERR.PARSE_FAILED, '安装脚本内容异常', `仅 ${text.length} 字节，疑似未取到官方脚本`);
    } catch (err) {
      lastErr = err;
      ctx.log('warn', `该地址下载失败，尝试下一个…`);
    }
  }
  throw lastErr instanceof AppError ? lastErr
    : new AppError(ERR.NET_UNREACHABLE, '安装脚本下载失败（代理与直连均不可用）', String(lastErr && lastErr.message));
}

/** 「一键安装 Homebrew」步骤：下载 → 官方脚本安装（代理优先）→ 写环境配置。 */
function homebrewInstallSteps() {
  return [
    {
      id: 'download', title: '下载官方安装脚本', channelPolicy: 'proxy_first', timeoutMs: 200_000,
      run: async (ctx) => { await downloadInstallScript(ctx); },
    },
    {
      id: 'install', title: '安装 Homebrew（官方脚本）', channelPolicy: 'proxy_first', timeoutMs: UPGRADE_TIMEOUT,
      run: async (ctx) => {
        const scriptPath = path.join(paths.CACHE_DIR, 'homebrew-install.sh');
        if (!fs.existsSync(scriptPath)) throw new AppError(ERR.NOT_FOUND, '安装脚本不存在，请重试');
        const askpass = path.join(paths.CACHE_DIR, 'sudo-askpass.sh');
        try {
          fs.writeFileSync(askpass, ASKPASS_SCRIPT, { mode: 0o700 });
        } catch (err) {
          throw new AppError(ERR.IO_ERROR, '无法创建授权助手脚本', String(err && err.message));
        }
        ctx.log('warn', '官方脚本在 macOS 上需要管理员权限：若弹出密码框，请输入你的登录密码（MacKit 不读取、不保存密码）');
        const common = {
          env: { NONINTERACTIVE: '1', SUDO_ASKPASS: askpass, HOMEBREW_NO_ENV_HINTS: '1' },
          timeoutMs: UPGRADE_TIMEOUT,
          onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
        };
        let res;
        try {
          if (cfg().autoFallback === false) {
            ctx.log('info', '尝试代理执行: Homebrew 安装 ...');
            res = await ctx.exec.run(paths.BASH_BIN, [scriptPath], { ...common, channel: 'proxy' });
            ctx.setChannel('proxy');
          } else {
            const onAttempt = (ch, phase) => {
              const label = ch === 'proxy' ? '代理' : '直连';
              if (phase === 'try') ctx.log('info', `尝试${label}执行: Homebrew 安装 ...`);
              else if (phase === 'ok') ctx.log('ok', `Homebrew 安装 成功 (使用${label})`);
              else ctx.log('warn', `Homebrew 安装 失败，尝试另一种方式...`);
            };
            res = await ctx.exec.runWithChannel('proxy_first', 'Homebrew 安装', paths.BASH_BIN, [scriptPath], { ...common, onAttempt });
            ctx.setChannel(res.channel);
          }
        } finally {
          try { fs.rmSync(askpass, { force: true }); } catch { /* ignore */ }
        }
        const errText = `${res.stderr || ''}\n${res.stdout || ''}`;
        if (res.code !== 0 && /Need sudo access|sudo access on macOS|password is required|-A .*failed/i.test(errText)) {
          throw new AppError(ERR.AUTH_CANCELLED, '管理员授权未完成（密码框被取消或未获得授权），Homebrew 未安装');
        }
        if (!paths.exists(paths.BREW_BIN)) {
          throw new AppError(ERR.CMD_FAILED, '安装脚本已结束但未检测到 brew',
            (res.stderr || '').trim().split('\n').slice(-3).join('\n'));
        }
        ctx.log('ok', `Homebrew 安装完成：${paths.BREW_BIN}`);
        const ver = await safeCtx(ctx, ['--version']);
        for (const l of lineList(ver.stdout).slice(0, 1)) ctx.log('info', `  ${l}`);
      },
    },
    shellenvStep(),
  ];
}

/** 为 install_casks 生成「每目标一步」的安装步骤（mode: proxy|direct）。 */
function caskInstallSteps(items) {
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({ name: String((it && it.name) || '').trim(), mode: it && it.mode === 'proxy' ? 'proxy' : 'direct' }))
    .filter((it) => it.name && CASK_TOKEN_RE.test(it.name));
  if (list.length === 0) {
    return [{ id: 'noop', title: '无可安装项', run: async (ctx) => { ctx.log('warn', '未指定要安装的 Cask 应用'); } }];
  }
  const plans = list.map((it, i) => ({
    id: `install_${i}`, title: `安装 ${it.name}`,
    channelPolicy: it.mode === 'proxy' ? 'proxy_first' : 'direct_first',
    timeoutMs: UPGRADE_TIMEOUT,
    run: async (ctx) => {
      const label = `${it.name} ${it.mode === 'proxy' ? '代理' : '直连'}安装`;
      const args = ['install', '--cask', it.name];
      const c = cfg();
      if (c.autoFallback === false) {
        ctx.log('info', `尝试${it.mode === 'proxy' ? '代理' : '直连'}执行: ${label} ...`);
        const res = await ctx.exec.run('brew', args, {
          env: BREW_ENV, timeoutMs: UPGRADE_TIMEOUT, channel: it.mode,
          onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
        });
        ctx.setChannel(it.mode);
        if (res.code !== 0) { ctx.log('error', `${label} 失败`); throw new AppError(ERR.CMD_FAILED, `${label} 失败`); }
        ctx.log('ok', `${label} 成功`);
        return;
      }
      await runPolicy(ctx, it.mode === 'proxy' ? 'proxy_first' : 'direct_first', label, args);
    },
  }));
  // 与逐项升级一致：开启「自动清理」时，安装结束后追加一次缓存清理（不计入成功数）
  if (cfg().autoCleanup === true) plans.push(autoCleanupStep());
  return plans;
}

// ------------------------------ 动作定义 ------------------------------
const actions = {

  /** brew 本体更新（proxy_first，复刻 MK-M2-03） */
  brew_update: {
    title: '更新 Homebrew 本体',
    channelPolicy: 'proxy_first',
    steps: () => [{
      id: 'brew_update', title: '更新 Homebrew 本体', channelPolicy: 'proxy_first', timeoutMs: UPGRADE_TIMEOUT,
      run: async (ctx) => { await runPolicy(ctx, 'proxy_first', 'Homebrew 更新', ['update']); },
    }],
  },
  /** 逐项选择通道升级（A6：由 params.items 动态生成步骤，非 stdin） */
  upgrade_one_by_one: {
    title: '逐项选择通道升级',
    steps: (params) => {
      const items = Array.isArray(params.items) ? params.items : [];
      if (items.length === 0) {
        return [{ id: 'noop', title: '无可升级项', run: async (ctx) => { ctx.log('warn', '无任何可更新的项，无需逐项选择'); } }];
      }
      const plans = items.map((it, i) => {
        const kind = it.kind === 'cask' ? 'cask' : 'formula';
        const mode = it.mode === 'proxy' ? 'proxy' : (it.mode === 'direct' ? 'direct' : 'skip');
        return {
          id: `item_${i}`, title: `${it.name}`,
          channelPolicy: mode === 'proxy' ? 'proxy_first' : (mode === 'direct' ? 'direct_first' : null),
          timeoutMs: UPGRADE_TIMEOUT,
          run: async (ctx) => {
            if (mode === 'skip') {
              ctx.log('warn', `已跳过 ${it.name}`);
              throw Object.assign(new AppError('SKIP', `已跳过 ${it.name}`), { code: 'SKIP' });
            }
            const args = ['upgrade'];
            if (kind === 'cask') args.push('--cask');
            args.push(it.name);
            const label = `${it.name} ${mode === 'proxy' ? '代理' : '直连'}更新`;
            const c = cfg();
            if (c.autoFallback === false) {
              ctx.log('info', `尝试${mode === 'proxy' ? '代理' : '直连'}执行: ${label} ...`);
              const res = await ctx.exec.run('brew', args, {
                env: BREW_ENV, timeoutMs: UPGRADE_TIMEOUT, channel: mode,
                onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
              });
              ctx.setChannel(mode);
              if (res.code !== 0) { ctx.log('error', `${label} 失败`); throw new AppError(ERR.CMD_FAILED, `${label} 失败`); }
              ctx.log('ok', `${label} 成功`);
              return;
            }
            await runPolicy(ctx, mode === 'proxy' ? 'proxy_first' : 'direct_first', label, args);
          },
        };
      });
      // 升级完成后按设置自动清理缓存（默认开）；「无项」路径已在上面提前返回，不会追加清理。
      if (cfg().autoCleanup === true) plans.push(autoCleanupStep());
      return plans;
    },
    finalize: finalizeBatch,
  },

  /** 清理缓存（Q5：不加确认；失败不阻断） */
  cleanup: {
    title: '清理缓存',
    destructive: false,
    steps: () => [{
      id: 'cleanup', title: '清理 Homebrew 缓存',
      run: async (ctx) => {
        ctx.log('warn', '将清理全部缓存（brew cleanup --prune=all），此操作不可逆');
        const res = await safeCtx(ctx, ['cleanup', '--prune=all']);
        if (res.code === 0) ctx.log('ok', '清理完成');
        else ctx.log('warn', '清理遇到问题，继续执行');
      },
    }],
  },

  /**
   * 一键安装 Homebrew（官方 brew.sh 的 install.sh，代理优先）。
   * destructive=true：系统级安装 + 写 shell 配置，须走前端二次确认。
   * 已安装时退化为 noop（不重复安装）。
   */
  install_homebrew: {
    title: '安装 Homebrew',
    destructive: true,
    steps: () => {
      if (paths.exists(paths.BREW_BIN)) {
        return [{
          id: 'noop', title: 'Homebrew 已安装',
          run: async (ctx) => { ctx.log('ok', `已检测到 Homebrew（${paths.BREW_BIN}），无需重复安装`); },
        }];
      }
      return homebrewInstallSteps();
    },
  },

  /** 单独配置 Homebrew 环境变量（写 shellenv 到 ~/.zprofile 或 ~/.bash_profile） */
  setup_shellenv: {
    title: '配置 Homebrew 环境变量',
    destructive: true,
    steps: () => [shellenvStep()],
  },

  /** Cask 安装（Cask 下载页：搜索后逐项指定代理/直连；非 destructive，新增不删改） */
  install_casks: {
    title: 'Cask 安装',
    destructive: false,
    steps: (params) => caskInstallSteps(params.items),
    finalize: finalizeBatch,
  },

  /** 卸载 Cask 应用（危险操作，复刻 uninstall_one_cask + uninstall_multi） */
  uninstall_casks: {
    title: '卸载 Cask 应用',
    destructive: true,
    steps: (params) => batchUninstallSteps(params.names, 'cask'),
    finalize: finalizeBatch,
  },

  /** 卸载 Tap 软件源（危险操作，复刻 uninstall_one_tap） */
  uninstall_taps: {
    title: '卸载 Tap 软件源',
    destructive: true,
    steps: (params) => batchUninstallSteps(params.names, 'tap'),
    finalize: finalizeBatch,
  },
};
/** 为一个批量卸载动作生成「每目标一步」的步骤（失败不中断其余目标）。 */
function batchUninstallSteps(names, kind) {
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && n) : [];
  if (list.length === 0) {
    return [{ id: 'noop', title: '无可卸载项', run: async (ctx) => { ctx.log('warn', `未选择任何${kind === 'tap' ? '软件源' : 'Cask 应用'}`); } }];
  }
  return list.map((name, i) => ({
    id: `uninstall_${i}`, title: `${kind === 'tap' ? '卸载软件源' : '卸载'} ${name}`,
    run: async (ctx) => {
      if (kind === 'tap') {
        if (CORE_TAPS.includes(name)) {
          ctx.log('warn', `注意: ${name} 为 Homebrew 核心软件源，卸载后需通过 brew tap 重新安装`);
        }
        const check = await safeCtx(ctx, ['tap']);
        if (!lineList(check.stdout).includes(name)) {
          ctx.log('error', `${name} 未安装`);
          throw new AppError(ERR.NOT_FOUND, `${name} 未安装`);
        }
        ctx.log('warn', `正在卸载软件源 ${name} ...`);
        const res = await safeCtx(ctx, ['untap', name]);
        if (res.code !== 0) { ctx.log('error', `${name} 卸载失败`); throw new AppError(ERR.CMD_FAILED, `${name} 卸载失败`, res.stderr.trim()); }
        ctx.log('ok', `${name} 卸载成功`);
        return;
      }
      const check = await safeCtx(ctx, ['list', '--cask']);
      if (!lineList(check.stdout).includes(name)) {
        ctx.log('error', `${name} 未安装`);
        throw new AppError(ERR.NOT_FOUND, `${name} 未安装`);
      }
      const info = await safeCtx(ctx, ['info', '--cask', name]);
      for (const l of lineList(info.stdout).slice(0, 5)) ctx.log('info', `  ${l}`);
      ctx.log('error', '警告: 卸载将删除应用及其数据');
      ctx.log('warn', `正在卸载 ${name} ...`);
      const res = await safeCtx(ctx, ['uninstall', '--cask', name]);
      if (res.code !== 0) { ctx.log('error', `${name} 卸载失败`); throw new AppError(ERR.CMD_FAILED, `${name} 卸载失败`, res.stderr.trim()); }
      ctx.log('ok', `${name} 卸载成功`);
    },
  }));
}

/** 在 step 内直连执行（继承 task signal，取消可中断）。 */
async function safeCtx(ctx, args) {
  try {
    return await ctx.exec.run('brew', args, {
      env: BREW_ENV, timeoutMs: 300_000,
      onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
    });
  } catch (err) {
    if (err && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    return { code: (err && err.code) || -1, stdout: '', stderr: (err && err.message) || String(err) };
  }
}

/**
 * 「升级完成后自动清理缓存」收尾步骤（受 mackit.autoCleanup 控制，默认开）。
 * 语义复刻原脚本 `brew cleanup --prune=all && log_ok || log_warn`：
 * 失败只记 warn，绝不 throw、不阻断、不改任务终态；finalizeBatch 亦不计入成功数。
 */
function autoCleanupStep() {
  return {
    id: 'autoclean', title: '自动清理缓存',
    run: async (ctx) => {
      ctx.log('info', '升级完成，按设置自动清理缓存（brew cleanup --prune=all）…');
      let res;
      try {
        res = await safeCtx(ctx, ['cleanup', '--prune=all']);
      } catch (err) {
        if (err && err.code === ERR.CANCELLED) throw err; // 用户取消仍需能中断
        ctx.log('warn', `自动清理遇到问题，已忽略：${(err && err.message) || err}`);
        return;
      }
      if (res.code === 0) ctx.log('ok', '自动清理完成');
      else ctx.log('warn', '自动清理遇到问题，已忽略（不影响升级结果）');
    },
  };
}

export default {
  id: 'brew',
  actions,
  queries: {
    outdated: queryOutdated,
    installed: queryInstalled,
    info: queryInfo,
    caskSearch: queryCaskSearch,
  },
};
