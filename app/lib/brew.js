/**
 * MacKit · Homebrew 管家（后端模块）
 *
 * 语义移植自原 `shell/brewgo.sh`（参考脚本已于 2026-09-16 从仓库移除，本文件为该功能的唯一事实源）。
 *
 * 契约：
 *   - 默认导出 ModuleDefinition { id:'brew', actions, queries }
 *   - actions[action] = { title, destructive?, steps(params, ctx), finalize? }
 *   - queries[name]   = (params) => Promise<data>   （只读；本文件直接用 lib/exec.js，不经 task signal）
 *
 * brew 7 容错：`brew tap` 空输出属正常；所有 JSON 解析 try/catch 降级为空数组。
 * 只读命令统一注入 HOMEBREW_NO_AUTO_UPDATE=1，避免隐式自动更新导致的 index.lock 冲突与噪声。
 * 端口 / 镜像源读写一律走 store.readBrewgo() / store.writeBrewgo()。
 *
 * 软件包类别（2026-09-18）：搜索 / 索引 / 安装对 cask 与 formula 完全共用，
 * 差异集中在 KIND_SPEC 一张表里（API 文件、缓存文件、brew 开关、条数下限）。
 *   - queries.packageSearch({ kind:'cask'|'formula', q })  本地全量索引打分 + brew info 补详情
 *   - actions.install_casks / install_formulae             逐项指定「代理 / 直连」安装
 *   - actions.uninstall_casks / uninstall_formulae         批量卸载（destructive，需二次确认）
 */

import fs from 'node:fs';
import path from 'node:path';

import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';
import { countSteps } from './runner.js';

const { ERR, AppError } = exec;

/** 只读/升级命令的通用环境（关闭隐式自动更新） */
const BREW_ENV = Object.freeze({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' });
/** 核心 Tap（卸载需加强警告） */
const CORE_TAPS = Object.freeze(['homebrew/core', 'homebrew/cask']);
const UPGRADE_TIMEOUT = 1_800_000;

// ------------------------------ 小工具 ------------------------------
const lineList = paths.lines;

function cfg() {
  try { return store.readMackit(); } catch { return { defaultChannel: 'auto', autoFallback: true }; }
}

/**
 * 按 autoFallback 开关决定「多通道尝试」还是「单通道」。
 * autoFallback=false 时只试首选通道并失败即终止。
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
    if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, `${desc}失败`, paths.tailLines(res.stderr));
    ctx.setChannel(channel);
    ctx.log('ok', `${desc} 成功 (使用${channel === 'proxy' ? '代理' : '直连'})`);
    return { ...res, channel };
  }
  const res = await ctx.exec.runWithChannel(policy, desc, 'brew', args, { ...common, onAttempt });
  ctx.setChannel(res.channel);
  return res;
}

// ------------------------------ brew 仓库 git 锁自愈（Task A） ------------------------------

/** git 锁视为「陈旧」的阈值：活着的 git 操作绝不修复（10 分钟内不动）。 */
export const STALE_LOCK_MAX_AGE_MS = 10 * 60 * 1000;
/** 扫描 `*.lock` 的最大目录深度（相对 `.git`）：`refs/remotes/origin/main.lock` 恰好落在第 4 层。 */
const LOCK_SCAN_MAX_DEPTH = 4;
/** 未完成的 rebase 现场目录名。 */
const REBASE_DIRS = ['rebase-merge', 'rebase-apply'];

/**
 * 判定一次 brew update 失败是否是「上次更新被中断留下的 git 锁 / rebase 现场」。
 *
 * 纯函数（只看文本），便于单测。命中任一形态即视为疑似可自愈：
 *   · could not lock config file
 *   · cannot lock ref
 *   · Another git process seems to be running
 *   · already a rebase-merge directory
 *   · index.lock + File exists（两段需同时出现）
 * @param {{message?:string, detail?:string}} err
 * @returns {boolean}
 */
export function looksLikeStaleGitLock(err) {
  const text = `${(err && err.message) || ''}\n${(err && err.detail) || ''}`;
  if (!text.trim()) return false;
  const simple = [
    'could not lock config file',
    'cannot lock ref',
    'Another git process seems to be running',
    'already a rebase-merge directory',
  ];
  if (simple.some((s) => text.includes(s))) return true;
  return text.includes('index.lock') && text.includes('File exists');
}

/**
 * 扫描 brew 仓库 `.git` 里的 `*.lock` 与未完成的 rebase 现场。
 *
 * 锁只有在 **mtime 距今超过 10 分钟** 才算陈旧 —— 活着的 git 操作必须被保留。
 * 默认目录取 `paths.BREW_PREFIX/.git`（不硬编码路径）；测试可传 `opts.gitDir` 指向临时目录，
 * 绝不触碰真实 `/opt/homebrew`。
 * @param {{gitDir?:string, now?:number, maxAgeMs?:number, maxDepth?:number}} [opts]
 * @returns {{stale:Array<{path:string,mtimeMs:number,ageMs:number}>, freshLocks:Array<{path:string,mtimeMs:number,ageMs:number}>, rebaseDir:string|null}}
 */
export function detectStaleGitLocks(opts = {}) {
  const gitDir = opts.gitDir || path.join(paths.BREW_PREFIX, '.git');
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAgeMs = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : STALE_LOCK_MAX_AGE_MS;
  const maxDepth = Number.isFinite(opts.maxDepth) ? opts.maxDepth : LOCK_SCAN_MAX_DEPTH;
  const stale = [];
  const freshLocks = [];
  let rebaseDir = null;

  const walk = (dir, rel, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const relPath = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        // rebase 现场整体作为一个单元处理（repair 会整目录移走），不在锁扫描里重复展开
        if (REBASE_DIRS.includes(e.name)) continue;
        walk(full, relPath, depth + 1);
        continue;
      }
      if (!e.name.endsWith('.lock')) continue;
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      const item = { path: full, mtimeMs: st.mtimeMs, ageMs: now - st.mtimeMs };
      if (item.ageMs > maxAgeMs) stale.push(item);
      else freshLocks.push(item);
    }
  };
  walk(gitDir, '', 1);

  for (const name of REBASE_DIRS) {
    const full = path.join(gitDir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) { rebaseDir = full; break; }
  }
  return { stale, freshLocks, rebaseDir };
}

/**
 * 把检测到的陈旧锁 / rebase 现场移进恢复备份目录，并清掉未完成的 rebase。
 *
 * ★ 只 **move**（`fs.renameSync`），绝不 `rm` —— 完全可回滚。rename 受限（跨卷 / EPERM）时
 *   退化为 `fs.cpSync` + 删原件（仍可回滚，只是非原子），并记日志说明。
 * @param {{log:(level:string,text:string)=>void, exec:{run:Function}}} ctx
 * @param {{gitDir?:string, repoDir?:string, report?:{stale:Array<{path:string,mtimeMs:number,ageMs:number}>, rebaseDir:string|null}, timeoutMs?:number}} [opts]
 * @returns {{backupDir:string, moved:string[], rebaseAction:string|null, verified:boolean}}
 */
export async function repairStaleGitState(ctx, opts = {}) {
  const gitDir = opts.gitDir || path.join(paths.BREW_PREFIX, '.git');
  const repoDir = opts.repoDir || paths.BREW_PREFIX;
  const report = opts.report || detectStaleGitLocks({ gitDir });
  // ★ 首轮只移「锁」：rebase 目录必须**先**留给 git 自己收尾（`rebase --abort` 需要它还在）
  const targets = report.stale.map((s) => s.path);
  if (targets.length === 0 && !report.rebaseDir) {
    return { backupDir: '', moved: [], rebaseAction: null, verified: true };
  }

  // 恢复备份目录不做自动清理：单次只有几个 KB 且极少发生，保留现场便于排查 / 回滚。
  const backupDir = path.join(paths.CACHE_DIR, 'brew-git-recovery', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backupDir, { recursive: true });

  /** move 一项进备份目录；返回实际使用的方式（rename / cp+rm）。 */
  const moveTo = (src, dst) => {
    try { fs.renameSync(src, dst); return 'rename'; }
    catch (err) {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return `cp+rm（rename 失败：${err && err.code || err && err.message}）`;
    }
  };
  const moved = [];
  for (const src of targets) {
    const dst = path.join(backupDir, path.relative(gitDir, src).replace(/\//g, '__'));
    try {
      const how = moveTo(src, dst);
      moved.push(src);
      ctx.log('info', `已移走陈旧锁 ${src} → ${dst}（${how}）`);
    } catch (err) {
      ctx.log('warn', `移走陈旧锁失败（保留原状）：${src} — ${err && err.message}`);
    }
  }

  // rebase 现场优先交给 git 自己收尾（目录还在 → abort 才可能成功）；每次尝试各自如实记日志
  let rebaseAction = null;
  if (report.rebaseDir) {
    const timeoutMs = opts.timeoutMs || 30_000;
    const abort = await ctx.exec.run('git', ['-C', repoDir, 'rebase', '--abort'], { timeoutMs });
    ctx.log('info', `git -C ${repoDir} rebase --abort → 退出码 ${abort.code}`);
    if (abort.code === 0) {
      rebaseAction = 'rebase --abort';
    } else {
      const quit = await ctx.exec.run('git', ['-C', repoDir, 'rebase', '--quit'], { timeoutMs });
      ctx.log('info', `git -C ${repoDir} rebase --quit → 退出码 ${quit.code}`);
      rebaseAction = `rebase --quit（退出码 ${quit.code}；--abort 退出码 ${abort.code}）`;
    }
  }

  // abort / quit 没能清掉 rebase 目录时（极端损坏），整体移进备份
  let cur = detectStaleGitLocks({ gitDir });
  if (cur.rebaseDir) {
    const dst = path.join(backupDir, path.relative(gitDir, cur.rebaseDir).replace(/\//g, '__'));
    try {
      const how = moveTo(cur.rebaseDir, dst);
      moved.push(cur.rebaseDir);
      ctx.log('info', `已移走 rebase 现场 ${cur.rebaseDir} → ${dst}（${how}）`);
    } catch (err) {
      ctx.log('warn', `移走 rebase 现场失败：${cur.rebaseDir} — ${err && err.message}`);
    }
    cur = detectStaleGitLocks({ gitDir });
  }

  // ★ 验证不通过就不重试：把剩余路径原样报给用户，让用户手动 rebase --abort
  if (cur.stale.length > 0 || cur.rebaseDir) {
    const remain = [...cur.stale.map((s) => s.path), cur.rebaseDir].filter(Boolean);
    throw new AppError(ERR.CMD_FAILED, 'Homebrew 仓库的陈旧 git 锁未能自动清除',
      `残留：\n  ${remain.join('\n  ')}\n请手动执行：git -C ${repoDir} rebase --abort 后重试`);
  }
  return { backupDir, moved, rebaseAction, verified: true };
}

/**
 * brew_update 专用：识别「中断残留的 git 锁」→ 安全修复 → 重试一次。
 * 只服务 brew_update（upgrade / install 带 HOMEBREW_NO_AUTO_UPDATE=1，不触碰仓库）。
 * @param {{log:(level:string,text:string)=>void, exec:{run:Function}}} ctx
 */
async function runPolicyWithSelfHeal(ctx) {
  const args = ['update'];
  try {
    await runPolicy(ctx, 'proxy_first', 'Homebrew 更新', args);
  } catch (err) {
    if (!looksLikeStaleGitLock(err)) throw err;
    const report = detectStaleGitLocks();
    if (report.stale.length === 0 && !report.rebaseDir) throw err;
    const names = [...report.stale.map((s) => s.path), report.rebaseDir].filter(Boolean).map((p) => path.basename(p));
    ctx.log('warn', `上次更新被中断，留下了 git 锁（${names.join('、')}）—— 自动修复后重试`);
    await repairStaleGitState(ctx, { report });
    try {
      await runPolicy(ctx, 'proxy_first', 'Homebrew 更新', args);
      ctx.log('ok', '已自动修复 Homebrew 仓库的陈旧锁并完成更新');
    } catch (retryErr) {
      // 重试仍失败：若依旧是锁问题（或现场又出现），给出可操作的手动命令；否则原样上抛
      const again = detectStaleGitLocks();
      if (looksLikeStaleGitLock(retryErr) || again.stale.length > 0 || again.rebaseDir) {
        const remain = [...again.stale.map((s) => s.path), again.rebaseDir].filter(Boolean);
        throw new AppError(ERR.CMD_FAILED, `Homebrew 更新失败（自动修复后仍有陈旧 git 锁：${remain.length ? remain.join('、') : '锁问题未消除'}）`,
          `请手动执行：git -C ${paths.BREW_PREFIX} rebase --abort 后重试\n${retryErr.detail || retryErr.message}`);
      }
      throw retryErr;
    }
  }
}

/**
 * 批量动作终态：只要不是「全部失败」，任务算 ok（批量操作不中断语义）。
 * ★ 自动清理收尾步骤（id='autoclean'）的成败不计入「软件包成功数」：
 *   它既不影响任务终态判定，也不污染用户可读的成功/跳过/失败计数，
 *   其执行结果仅在日志中体现（避免用户误以为多升级了一个包）。
 */
function finalizeBatch(task, { log }) {
  const steps = Array.isArray(task.steps) ? task.steps : [];
  // 收尾清理步骤（id='autoclean'）不参与软件包计数；计数口径见 runner.countSteps（唯一实现）
  // autoclean 是收尾清理、noop 是「没选中任何项」的占位步骤，都不计入成功数
  const counts = countSteps(steps.filter((s) => s.id !== 'autoclean' && s.id !== 'noop'));
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
  // 降级：名字列表（brew 7 --quiet 输出）
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
    // brew 7 下 brew tap 输出为空属正常，必须返回空数组而非报错
    taps: lineList(t.stdout),
  };
}

async function queryInfo(params) {
  const kind = params.kind === 'formula' ? '--formula' : '--cask';
  const name = String(params.name || '');
  if (!name) return { lines: [] };
  const res = await safeRun('brew', ['info', kind, name]);
  // 只取 info 前 5 行，并统一缩进两格
  const out = lineList(res.stdout).slice(0, 5).map((l) => `  ${l}`);
  if (out.length === 0 && res.stderr.trim()) {
    out.push(...lineList(res.stderr).slice(0, 5).map((l) => `  ${l}`));
  }
  return { lines: out };
}

/** 直连执行并吞异常（只读查询用，无 task signal）。 */
function safeRun(bin, args, opts = {}) {
  return exec.runSafe(bin, args, { env: BREW_ENV, timeoutMs: 120_000, ...opts });
}

// ------------------------------ 软件包搜索（Cask / Formula 共用） ------------------------------
/**
 * 两类软件包的差异表 —— 除这张表以外，搜索 / 索引 / 安装逻辑全部共用同一套代码。
 *   brewFlag   —— brew install / info 的类别开关
 *   searchFlag —— brew search 的类别开关
 *   jsonKey    —— `brew info --json=v2` 中对应的顶层数组键
 *   apiFile    —— formulae.brew.sh 的全量元数据文件名（国内镜像同路径）
 *   cacheFile  —— 本地索引缓存文件名（~/.mackit/cache/）
 *   minCount   —— 索引条数下限，低于此值视为下载到了错误内容
 *   label      —— 面向用户的类别名
 */
const KIND_SPEC = Object.freeze({
  cask: { kind: 'cask', brewFlag: '--cask', searchFlag: '--casks', jsonKey: 'casks', apiFile: 'cask.json', cacheFile: 'cask-index.json', minCount: 100, label: 'Cask 应用' },
  formula: { kind: 'formula', brewFlag: '--formula', searchFlag: '--formulae', jsonKey: 'formulae', apiFile: 'formula.json', cacheFile: 'formula-index.json', minCount: 1_000, label: 'Formula' },
});

/** 归一化类别名：非 formula 一律按 cask 处理。 */
function normKind(kind) { return kind === 'formula' ? 'formula' : 'cask'; }

/** 搜索结果展示上限（超出时前端提示「显示前 N 个」）。 */
const SEARCH_LIMIT = 30;
/** 合法 Cask token（防注入：名称最终会作为 spawn 参数，只放行 brew token 字符集）。 */
const CASK_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._@/-]*$/;
/** 合法 Formula 名：比 cask 多一个 `+`（如 libc++）。 */
const FORMULA_TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._@/+-]*$/;
/** 合法 Tap 名（owner/repo 或自定义源，防注入；untap 用）。 */
const TAP_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
function tokenRe(kind) { return kind === 'formula' ? FORMULA_TOKEN_RE : CASK_TOKEN_RE; }

/**
 * 解析 `brew search --casks|--formulae <q>` 的名称列表（纯函数）。
 * 实测两种形态（2026-09-16，brew 4.x；2026-09-18 补充 formula）：
 *   - TTY：`==> Casks` / `==> Formulae` 段头 + 多列表格（一行多个名称，可带 ✔/✘、(disabled) 标记）
 *   - 非 TTY（服务端 spawn 即此形态）：无段头，每行一个名称
 * 所以：有段头时只取本类别的段；全程无段头时把所有行都视为本类别的名称。
 */
function parseSearchTokens(text, kind = 'cask') {
  const k = normKind(kind);
  const re = tokenRe(k);
  const sectionRe = k === 'formula' ? /^==>\s*Formulae/i : /^==>\s*Casks/i;
  const out = [];
  const seen = new Set();
  const pushToken = (t) => {
    if (t && re.test(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  };
  let inSection = null; // null=尚未见到任何段头
  let sawHeader = false;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('==>')) {
      sawHeader = true;
      inSection = sectionRe.test(line);
      continue;
    }
    if (sawHeader && inSection === false) continue; // 其他段（如另一个类别）
    for (const word of line.split(/\s+/)) {
      pushToken(word.replace(/[✔✘]+$/, ''));
    }
  }
  return out;
}

/**
 * 从 JSON v2 条目里取「已安装版本」展示串（纯函数）。
 * formula 是 `[{version,…}]` 数组，cask 是版本字符串 / {version} / null。
 */
function parseInstalled(item, kind) {
  if (kind === 'formula') {
    const arr = Array.isArray(item.installed) ? item.installed : [];
    const versions = arr
      .map((x) => (typeof x === 'string' ? x : (x && typeof x.version === 'string' ? x.version : null)))
      .filter(Boolean);
    return versions.length ? versions.join(', ') : null;
  }
  if (typeof item.installed === 'string' && item.installed) return item.installed;
  if (item.installed && typeof item.installed === 'object' && typeof item.installed.version === 'string') return item.installed.version;
  return null;
}

/**
 * 解析 `brew info <类别> --json=v2 <名称...>` 的结果为「名称→详情」映射（纯函数）。
 * 注意 JSON v2 中：cask 用 token（name 是数组），formula 用 name；两者 installed 结构也不同。
 */
function parseInfoJson(text, kind = 'cask') {
  const k = normKind(kind);
  const re = tokenRe(k);
  const spec = KIND_SPEC[k];
  const map = new Map();
  try {
    const obj = JSON.parse(String(text || '{}'));
    const arr = Array.isArray(obj[spec.jsonKey]) ? obj[spec.jsonKey] : [];
    for (const it of arr) {
      if (!it) continue;
      const token = k === 'formula' ? it.name : it.token;
      if (typeof token !== 'string' || !re.test(token)) continue;
      let name;
      if (k === 'formula') name = token; // formula 没有独立展示名
      else if (Array.isArray(it.name)) name = it.name.filter((n) => typeof n === 'string').join(' / ');
      else name = typeof it.name === 'string' ? it.name : token;
      map.set(token, {
        name: name || token,
        desc: typeof it.desc === 'string' ? it.desc : '',
        version: k === 'formula'
          ? (it.versions && typeof it.versions.stable === 'string' ? it.versions.stable : null)
          : (typeof it.version === 'string' ? it.version : null),
        installed: parseInstalled(it, k),
      });
    }
  } catch { /* 降级为空映射：结果行回退为裸名称 */ }
  return map;
}

/**
 * 软件包搜索（Cask / Formula 共用）：
 * 本地全量索引打分（cask 可命中中文名，对标官网 Algolia）→ `brew info --json=v2` 批量补详情。
 * 索引不可用（下载失败且无缓存）时回退 `brew search`（仅英文，兜底）。
 */
async function queryPackageSearch(params) {
  const kind = normKind((params && params.kind) || 'cask');
  const spec = KIND_SPEC[kind];
  const re = tokenRe(kind);
  const q = String((params && params.q) || '').trim();
  if (!q) return { kind, query: q, results: [], total: 0, limit: SEARCH_LIMIT, indexedAt: null };
  let tokens = null;
  let indexedAt = null;
  let indexTotal = null;   // 索引路径下的「全部命中数」（searchIndex 的 items 已被截到 limit）
  try {
    const idx = await ensureIndex(kind);
    const hits = searchIndex(idx.items, q, SEARCH_LIMIT);
    tokens = hits.items.map((c) => c.t);
    indexTotal = hits.total;
    indexedAt = idx.builtAt;
  } catch (err) {
    if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    tokens = null; // 回退路径
  }
  if (tokens === null) {
    // 兜底：brew 自带搜索（cask 不支持中文；中文查询会得到全量列表，仅在索引不可用时凑合）
    const res = await safeRun('brew', ['search', spec.searchFlag, q]);
    tokens = parseSearchTokens(res.stdout, kind);
    if (tokens.length === 0) {
      const errText = (res.stderr || '').trim();
      if (!(res.code === 0 || /no (available )?(formulae or casks|formula|cask)/i.test(errText) || errText === '')) {
        throw new AppError(ERR.CMD_FAILED, `${spec.label} 搜索失败`, paths.tailLines(errText));
      }
    }
  }
  // ★ total 必须是「全部命中数」：searchIndex 已把 items 截到 limit，若用 tokens.length
  //   则 total 恒 ≤30，前端「共 N 个匹配，显示前 30 个」永远不会出现（2026-09-19 修）。
  const total = indexTotal === null ? tokens.length : indexTotal;
  const shown = tokens.slice(0, SEARCH_LIMIT).filter((t) => re.test(t));
  if (shown.length === 0) return { kind, query: q, results: [], total: 0, limit: SEARCH_LIMIT, indexedAt };
  const info = await safeRun('brew', ['info', spec.brewFlag, '--json=v2', ...shown]);
  const map = parseInfoJson(info.stdout, kind);
  const results = shown.map((t) => ({ token: t, ...(map.get(t) || { name: t, desc: '', version: null, installed: null }) }));
  return { kind, query: q, results, total, limit: SEARCH_LIMIT, indexedAt };
}

// ------------------------------ 本地全量索引（对标 formulae.brew.sh 的 Algolia 搜索） ------------------------------
// 官网搜索（Algolia）索引了名称 + 描述（cask 还含中文名）；brew search 只匹配名称/英文描述，
// 且 cask 对中文查询会退化为全量结果。故下载一次全量元数据建本地索引，缓存 24h，搜索全程本地打分。
// cask 与 formula 共用这套机制，差异仅在 API 文件 / 缓存文件 / 条数下限（见 KIND_SPEC，2026-09-18 扩展 formula）。

const INDEX_TTL_MS = 24 * 60 * 60 * 1000;

function indexPath(kind) { return path.join(paths.CACHE_DIR, KIND_SPEC[normKind(kind)].cacheFile); }

/** 某类别在「当前镜像源」下的全量元数据 API 地址（与 exec.MIRROR_REMOTES 同一套映射）。 */
function indexApiUrl(kind) {
  const spec = KIND_SPEC[normKind(kind)];
  let mirror = 'official';
  try { mirror = store.readBrewgo().mirror || 'official'; } catch { /* ignore */ }
  // ★ 用显式的 API 域名表：从 brew.git 远端「剥掉 /brew.git 再拼 /homebrew-bottles/api」
  //   对 ustc/aliyun 恰好成立，但 tuna/tencent 的远端多一层 /git/homebrew → 实测 404。
  const api = exec.mirrorApiDomain(mirror);
  if (api) return `${api}/${spec.apiFile}`;
  return `https://formulae.brew.sh/api/${spec.apiFile}`;
}

/**
 * 全量元数据（cask.json / formula.json）→ 精简索引（纯函数）。
 * 条目：{ t:安装用名称（cask 为 token，formula 为 name）, n:展示名（cask 数组以 ' / ' 连接，含中文名）, d:描述, v:版本 }。
 */
function buildSlimIndex(jsonText, kind = 'cask') {
  const k = normKind(kind);
  const re = tokenRe(k);
  let obj;
  try { obj = JSON.parse(String(jsonText || '[]')); } catch { return []; }
  const arr = Array.isArray(obj) ? obj : [];
  const items = [];
  for (const c of arr) {
    if (!c) continue;
    const token = k === 'formula' ? c.name : c.token;
    if (typeof token !== 'string' || !re.test(token)) continue;
    const name = k === 'formula' ? token
      : (Array.isArray(c.name) ? c.name.filter((n) => typeof n === 'string').join(' / ')
        : (typeof c.name === 'string' ? c.name : ''));
    const version = k === 'formula'
      ? (c.versions && typeof c.versions.stable === 'string' ? c.versions.stable : '')
      : (typeof c.version === 'string' ? c.version : '');
    items.push({
      t: token,
      n: name,
      d: typeof c.desc === 'string' ? c.desc : '',
      v: version,
    });
  }
  return items;
}

/**
 * 本地打分搜索（纯函数）。
 * 排序权重：名称完全匹配 > 名称前缀 > 名称包含 > 展示名包含（cask 可命中中文）> 描述包含；
 * 同分按名称字典序。返回 { items, total }（items 截取前 limit 条，total 为全部命中数）。
 */
function searchIndex(items, q, limit = SEARCH_LIMIT) {
  const query = String(q || '').trim().toLowerCase();
  if (!query) return { items: [], total: 0 };
  const scored = [];
  for (const c of items) {
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
function readIndexCache(kind) {
  try {
    const obj = JSON.parse(fs.readFileSync(indexPath(kind), 'utf8'));
    if (obj && typeof obj.builtAt === 'number' && Array.isArray(obj.items)) return obj;
  } catch { /* ignore */ }
  return null;
}

function writeIndexCache(kind, items) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(indexPath(kind), JSON.stringify({ builtAt: Date.now(), items }), 'utf8');
  } catch { /* 缓存写失败不影响本次搜索 */ }
}

/**
 * 直连优先（失败换代理）下载全量元数据。
 * ★ 必须用 `curl -o 临时文件` 落盘再读：exec 层 stdout 捕获上限 4MB，
 *   而 cask.json 约 18MB、formula.json 约 32MB，走 stdout 会被静默截断导致 JSON 解析失败（2026-09-16 实测踩坑）。
 * ★ `--compressed` 让 curl 协商 gzip：formula.json 32MB→5MB、cask.json 18MB→2MB，首次搜索明显更快。
 */
async function downloadIndex(kind) {
  const spec = KIND_SPEC[normKind(kind)];
  const url = indexApiUrl(kind);
  const tmpFile = `${indexPath(kind)}.download`;
  try {
    await exec.runWithChannel('direct_first', `下载 ${spec.label} 索引`, 'curl',
      ['-fsSL', '--compressed', '--max-time', '300', '-o', tmpFile, url],
      { timeoutMs: 320_000, env: { HOMEBREW_NO_ENV_HINTS: '1' } });
    const raw = fs.readFileSync(tmpFile, 'utf8');
    const items = buildSlimIndex(raw, kind);
    if (items.length < spec.minCount) {
      throw new AppError(ERR.PARSE_FAILED, `${spec.label} 索引内容异常`, `仅解析到 ${items.length} 条`);
    }
    return items;
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* ignore */ }
  }
}

/** 内存态（含单飞去重）：每个类别一份，并发搜索只触发一次下载。 */
const indexStates = {
  cask: { at: 0, items: null, loading: null },
  formula: { at: 0, items: null, loading: null },
};

/**
 * 确保某类别索引可用：内存 → 24h 内磁盘缓存 → 下载；下载失败时回退旧磁盘缓存。
 * 返回 { items, builtAt, source }，source ∈ memory|cache|downloaded|stale；全不可用则 throw。
 */
async function ensureIndex(kind) {
  const k = normKind(kind);
  const spec = KIND_SPEC[k];
  const st = indexStates[k];
  if (st.items && Date.now() - st.at < INDEX_TTL_MS) {
    return { items: st.items, builtAt: st.at, source: 'memory' };
  }
  const cached = readIndexCache(k);
  if (cached && Date.now() - cached.builtAt < INDEX_TTL_MS) {
    st.at = cached.builtAt; st.items = cached.items; st.loading = null;
    return { items: cached.items, builtAt: cached.builtAt, source: 'cache' };
  }
  if (!st.loading) {
    st.loading = downloadIndex(k)
      .then((items) => {
        const at = Date.now();
        st.at = at; st.items = items; st.loading = null;
        writeIndexCache(k, items);
        return { items, builtAt: at, source: 'downloaded' };
      })
      .catch((err) => {
        st.loading = null;
        throw err;
      });
  }
  try {
    return await st.loading;
  } catch (err) {
    if (cached) return { items: cached.items, builtAt: cached.builtAt, source: 'stale' };
    if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) throw err;
    throw new AppError(ERR.NET_UNREACHABLE, `${spec.label} 索引下载失败（且无本地缓存）`, (err && err.message) || String(err));
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
function buildShellenvLine(prefix, shell = 'zsh') {
  return `eval "$(${prefix}/bin/brew shellenv ${shell})"`;
}

/**
 * 生成「追加到 rc 文件」的完整新内容（纯函数）。
 *
 * 等效官方给出的前两条命令：
 *   ① `echo >> <rc>`          —— 补一个换行（原文末尾无换行时，直接追加会把新配置
 *                                粘到最后一行命令尾部，导致配置失效）
 *   ② `echo '<line>' >> <rc>` —— 追加配置行
 * 因此：原文非空且末尾无换行 → 补一个 \n；已有换行 → 多出一个空行（与官方一致）。
 * 注意绝不 trim 原文，保留用户文件原有结尾内容。
 */
function buildShellenvBlock(existingText, line) {
  const text = String(existingText || '');
  const head = text === '' ? '' : `${text}\n`;
  return `${head}# Added by MacKit (Homebrew)\n${line}\n`;
}

/** 判断 rc 文件内容是否已包含 brew shellenv 配置（纯函数）。 */
function isShellenvConfigured(text) {
  return paths.SHELLENV_RE.test(String(text || ''));
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
        // readTextSafe 对所有读取异常都返回 null，与「文件不存在」不可区分：若把读失败
        // 当成空文件再整文件写回，用户的 shell 配置会被替换成只剩这一行（2026-09-19 加固）。
        if (text === '' && paths.exists(rcFile)) {
          throw new AppError(ERR.IO_ERROR, `无法读取 ${rcFile}，已中止以免覆盖你的配置`,
            '请检查该文件的权限 / 是否为悬空软链接后重试');
        }
        paths.writeText(rcFile, block);
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
      const res = await ctx.exec.run('curl', ['-fsSL', '--max-time', '120', '-o', target, url], {
        timeoutMs: 150_000, channel: 'proxy',
        onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
      });
      if (res.code !== 0) {
        // curl 默认不删失败输出：超时中断留下的半截脚本可能仍然 >5KB 并通过下面的校验
        try { fs.rmSync(target, { force: true }); } catch { /* ignore */ }
        lastErr = new AppError(ERR.CMD_FAILED, '安装脚本下载失败', paths.tailLines(res.stderr));
        ctx.log('warn', '该地址下载失败，尝试下一个…');
        continue;
      }
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
            paths.tailLines(res.stderr));
        }
        ctx.log('ok', `Homebrew 安装完成：${paths.BREW_BIN}`);
        const ver = await safeCtx(ctx, ['--version']);
        for (const l of lineList(ver.stdout).slice(0, 1)) ctx.log('info', `  ${l}`);
      },
    },
    shellenvStep(),
  ];
}

/** 为 install_casks / install_formulae 生成「每目标一步」的安装步骤（mode: proxy|direct）。 */
function installSteps(items, kind) {
  const spec = KIND_SPEC[normKind(kind)];
  const re = tokenRe(spec.kind);
  const list = (Array.isArray(items) ? items : [])
    .map((it) => ({ name: String((it && it.name) || '').trim(), mode: it && it.mode === 'proxy' ? 'proxy' : 'direct' }))
    .filter((it) => it.name && re.test(it.name));
  if (list.length === 0) {
    return [{ id: 'noop', title: '无可安装项', run: async (ctx) => { ctx.log('warn', `未指定要安装的 ${spec.label}`); } }];
  }
  const plans = list.map((it, i) => ({
    id: `install_${i}`, title: `安装 ${it.name}`,
    channelPolicy: it.mode === 'proxy' ? 'proxy_first' : 'direct_first',
    timeoutMs: UPGRADE_TIMEOUT,
    run: async (ctx) => {
      const label = `${it.name} ${it.mode === 'proxy' ? '代理' : '直连'}安装`;
      const args = ['install', spec.brewFlag, it.name];
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

  /** brew 本体更新（proxy_first）。★ 失败若是「中断残留的 git 锁」→ 安全修复后重试一次（Task A 自愈） */
  brew_update: {
    title: '更新 Homebrew 本体',
    steps: () => [{
      id: 'brew_update', title: '更新 Homebrew 本体', channelPolicy: 'proxy_first', timeoutMs: UPGRADE_TIMEOUT,
      run: async (ctx) => { await runPolicyWithSelfHeal(ctx); },
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
            if (!tokenRe(kind).test(it.name)) {
              ctx.log('error', `名称不合法（含 brew 选项或非法字符），已跳过：${it.name}`);
              throw Object.assign(new AppError('SKIP', `名称不合法：${it.name}`), { code: 'SKIP' });
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

  /** 清理缓存（不加确认；失败不阻断） */
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

  /** Cask 安装（软件下载页：搜索后逐项指定代理/直连；非 destructive，新增不删改） */
  install_casks: {
    title: 'Cask 安装',
    destructive: false,
    steps: (params) => installSteps(params.items, 'cask'),
    finalize: finalizeBatch,
  },

  /** Formula 安装（命令行工具 / 库，等价 `brew install --formula <名称>`；非 destructive） */
  install_formulae: {
    title: 'Formula 安装',
    destructive: false,
    steps: (params) => installSteps(params.items, 'formula'),
    finalize: finalizeBatch,
  },

  /** 卸载 Cask 应用（危险操作，逐项执行、失败不中断其余项） */
  uninstall_casks: {
    title: '卸载 Cask 应用',
    destructive: true,
    steps: (params) => batchUninstallSteps(params.names, 'cask'),
    finalize: finalizeBatch,
  },

  /** 卸载 Formula（危险操作） */
  uninstall_formulae: {
    title: '卸载 Formula',
    destructive: true,
    steps: (params) => batchUninstallSteps(params.names, 'formula'),
    finalize: finalizeBatch,
  },

  /** 卸载 Tap 软件源（危险操作） */
  uninstall_taps: {
    title: '卸载 Tap 软件源',
    destructive: true,
    steps: (params) => batchUninstallSteps(params.names, 'tap'),
    finalize: finalizeBatch,
  },
};
/**
 * 为一个批量卸载动作生成「每目标一步」的步骤（失败不中断其余目标）。
 * kind ∈ tap | cask | formula；cask / formula 走同一段逻辑，仅 brew 开关与警告文案不同（KIND_SPEC）。
 */
function batchUninstallSteps(names, kind) {
  const isTap = kind === 'tap';
  const spec = isTap ? null : KIND_SPEC[normKind(kind)];
  // ★ 与安装侧同口径校验（名称最终会作为 spawn 参数）：此前卸载/untap 只判「非空字符串」，
  //   `--zap` 之类的值会被 brew 当成选项解释（2026-09-19 补齐）。
  const nameRe = isTap ? TAP_NAME_RE : tokenRe(spec.kind);
  const list = Array.isArray(names) ? names.filter((n) => typeof n === 'string' && nameRe.test(n)) : [];
  if (list.length === 0) {
    const what = isTap ? '软件源' : spec.label;
    return [{ id: 'noop', title: '无可卸载项', run: async (ctx) => { ctx.log('warn', `未选择任何${what}`); } }];
  }
  return list.map((name, i) => ({
    id: `uninstall_${i}`, title: `${isTap ? '卸载软件源' : '卸载'} ${name}`,
    run: async (ctx) => {
      if (isTap) {
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
      const check = await safeCtx(ctx, ['list', spec.brewFlag]);
      if (!lineList(check.stdout).includes(name)) {
        ctx.log('error', `${name} 未安装`);
        throw new AppError(ERR.NOT_FOUND, `${name} 未安装`);
      }
      const info = await safeCtx(ctx, ['info', spec.brewFlag, name]);
      for (const l of lineList(info.stdout).slice(0, 5)) ctx.log('info', `  ${l}`);
      ctx.log('error', spec.kind === 'formula'
        ? '警告: 卸载将删除该 Formula 及其安装文件（依赖它的软件包可能受影响）'
        : '警告: 卸载将删除应用及其数据');
      ctx.log('warn', `正在卸载 ${name} ...`);
      const res = await safeCtx(ctx, ['uninstall', spec.brewFlag, name]);
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
 * 等价 `brew cleanup --prune=all`，失败只记 warn：
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
    packageSearch: queryPackageSearch,
  },
};
