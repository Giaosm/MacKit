/**
 * MacKit · 自更新（后端模块）
 *
 * MacKit 本体就是一个 git 检出（README 推荐的安装方式就是 git clone），所以
 * 「有没有新版本」= 本地 HEAD 与上游 origin/<branch> 比。对外只有两个入口：
 *   - queries.status()  本地状态 + （带缓存的）远端比较结果 —— 驱动总览那颗按钮
 *   - actions.update    fetch → 比较 → git pull --ff-only → 提示重启
 *
 * 三条纪律：
 *   - **只做 fast-forward**：`git pull --ff-only`，绝不产生 merge commit，也绝不
 *     stash / 丢弃任何本地改动。本仓库常常是开发者的脏工作区，宁可让 git 拒绝一次，
 *     也不能把没提交的活搞丢 —— 失败时原样把 git 的话转给用户。
 *   - **网络检查带缓存**（10 分钟）：总览是默认视图，不能每次打开都去 fetch；但用户
 *     想看真实状态时可以 `?force=1` 绕过缓存。
 *   - **更新完不自己重启**：重启要杀掉正在跑任务的进程（服务就是当前进程），
 *     交给用户点「关闭服务」再重新打开；日志里会把这件事说清楚。
 */

import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';
import * as git from './git.js';

const { ERR, AppError } = exec;

/**
 * 非强制查询的**防抖**间隔（30 秒）。
 *
 * ★ 2026-09-21 改（原为「结果缓存 10 分钟」）：那个值的唯一作用是避免每次进总览都跑一次
 *   `git fetch`，但代价是「远端刚有提交 → 界面最长 10 分钟仍显示『已是最新』，而且重启项目
 *   也没用（缓存在磁盘上）」，用户只能干等 —— 实测被这个坑到过。
 *   现在语义是「**每次打开都重新检查**」，只留 30 秒防抖：在视图之间来回切换不会连发 fetch，
 *   而人对 30 秒无感。「⟳ 重新检查」按钮（force）连这 30 秒也绕过。
 */
const CHECK_MIN_INTERVAL_MS = 30 * 1000;
const CHECK_CACHE_KEY = 'selfupdate-check';
/** 状态查询里的 fetch 超时（每个通道；runWithChannel 最多试两个通道） */
const CHECK_FETCH_TIMEOUT_MS = 15_000;
/** 更新动作里的 fetch / pull 超时 */
const UPDATE_FETCH_TIMEOUT_MS = 90_000;
const PULL_TIMEOUT_MS = 120_000;

/**
 * ★ 正在进行的远端检查（并发去重）。总览 15s 健康轮询、用户点「检查更新」与视图 refresh
 * 会同时进来；并发跑多条 `git fetch` 会在 `.git` 的锁文件（如 `shallow.lock` /
 * `index.lock`）上互相争抢，轻则一条无谓失败、重则把两次结果都搅乱。
 * 复用进行中的 Promise（force:true 也一样：那一次 fetch 本身就是新的），
 * 并照 lib/env.js 的 snapshot() 那样在 `.finally()` 里清空。
 */
let checkInflight = null;
/** 上次**尝试**检查的时刻（成功/失败都算；仅进程内）—— 供 30s 防抖使用。 */
let lastAttemptAt = 0;
/** 上次检查结果（含失败），防抖窗口内直接复用它（否则离线时每次进总览都要干等一次超时）。 */
let lastResult = null;

/**
 * 在**仓库目录里**跑一条 git 命令。
 *
 * ★ 必须显式传 cwd：exec 层的子进程默认 `cwd` 是用户家目录（lib/exec.js 的
 *   `opts.cwd || paths.HOME`）。本项目此前的 git 调用全是 `config --global`，
 *   在家目录跑没问题；而仓库类命令（rev-parse / status / fetch / pull）在家目录里
 *   只会得到 `fatal: not a git repository`。
 */
function repoGit(args, opts = {}) {
  return git.run(args, { cwd: paths.REPO_DIR, ...opts });
}

/**
 * 读一个 commit 的摘要信息。
 * @param {string} rev
 * @returns {Promise<{commit:string, subject:string, date:number|null}|null>}
 */
async function readCommit(rev) {
  const res = await repoGit(['log', '-1', '--pretty=format:%h%x1f%s%x1f%ct', rev]);
  if (res.code !== 0) return null;
  const [commit, subject, ts] = res.stdout.split('\x1f');
  if (!commit) return null;
  const secs = Number.parseInt(ts, 10);
  return { commit, subject: subject || '', date: Number.isFinite(secs) ? secs * 1000 : null };
}

/** 当前分支名（detached HEAD 时为 'HEAD'）。 */
async function currentBranch() {
  const res = await repoGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return res.code === 0 ? (res.stdout.trim() || null) : null;
}

/** 上游 ref（优先 @{u}，其次 origin/<branch>）。 */
async function upstreamRef(branch) {
  const res = await repoGit(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const up = res.code === 0 ? res.stdout.trim() : '';
  if (up && up !== '@{u}') return up;
  return branch ? `origin/${branch}` : null;
}

/**
 * 解析 `git status --porcelain` 的文件路径。
 *
 * ★ 不能用 paths.lines()：它会把行首的 `XY ` 状态码连着 trim 掉，再切片就切进路径里了。
 * @param {string} porcelain
 * @returns {string[]}
 */
function porcelainPaths(porcelain) {
  return String(porcelain || '')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.trim().length > 0 && l.length > 3)
    .map((l) => l.slice(3).replace(/^"(.*)"$/, '$1').trim())
    .filter((p) => p.length > 0);
}

/**
 * 本地未提交改动 与 本次更新要改的文件 的交集。
 *
 * 有交集时 `git pull` 必然拒绝（"Your local changes would be overwritten"）。
 * 与其等 git 报错（还会因为通道重试把同一段错误打印两遍），不如提前停手并说清是哪些文件。
 *
 * @param {string} upstream
 * @param {string} porcelain
 * @returns {Promise<string[]>}
 */
async function findConflicts(upstream, porcelain) {
  const changedRes = await repoGit(['diff', '--name-only', `HEAD..${upstream}`]);
  if (changedRes.code !== 0) return [];
  const changed = new Set(paths.lines(changedRes.stdout));
  const seen = new Set();
  const out = [];
  for (const f of porcelainPaths(porcelain)) {
    if (changed.has(f) && !seen.has(f)) { seen.add(f); out.push(f); }
  }
  return out;
}

/**
 * 远端比较（fetch + rev-list），结果写磁盘缓存。
 *
 * ★ 只缓存「成功」的结果：fetchOk === false（网络抖动 / 代理挂了）不写缓存，
 *   否则一次瞬时失败会让 UI 连续 10 分钟显示「无法检查更新」，网络恢复了也看不到。
 * ★ 并发去重见模块头部的 checkInflight。
 *
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<{value:any, cached:boolean}>}
 */
async function checkRemote(opts = {}) {
  // ★ ① 已有一次检查在跑 → 直接复用它，不再发起第二条 fetch（避免抢 .git 锁）。
  //   force:true 也复用：那次 fetch 正在/即将拿到最新远端数据，对调用方就是「新鲜」的。
  if (checkInflight) return checkInflight;

  // ★ ② 防抖（force 时跳过）：最近 30s 内已经查过（不管成功还是失败）就直接复用上次结果。
  //   成功过的结果同时落盘（进程重启后仍可复用），失败只在进程内记着 —— 这样离线时
  //   不会每次切回总览都干等一次 fetch 超时。
  if (opts.force !== true) {
    const cached = store.getCached(CHECK_CACHE_KEY);
    const cachedAt = (cached && cached.value && typeof cached.at === 'number') ? cached.at : 0;
    if (Date.now() - Math.max(cachedAt, lastAttemptAt) < CHECK_MIN_INTERVAL_MS) {
      const value = lastResult || (cached && cached.value) || null;
      if (value) return { value, cached: true };
    }
  }

  // ★ ③ 真查：记下本次尝试（失败也算，供上面的防抖使用）
  lastAttemptAt = Date.now();
  checkInflight = computeRemote().finally(() => { checkInflight = null; });
  return checkInflight;
}

/** 真正执行 fetch + rev-list 的那一轮检查（由 checkRemote 负责缓存与并发去重）。 */
async function computeRemote() {
  const branch = await currentBranch();
  const upstream = await upstreamRef(branch);

  let fetchOk = false;
  let fetchError = null;
  try {
    await exec.runWithChannel('proxy_first', '检查 MacKit 更新', 'git', ['fetch', '--prune', 'origin'], {
      cwd: paths.REPO_DIR, noMirror: true, timeoutMs: CHECK_FETCH_TIMEOUT_MS,
    });
    fetchOk = true;
  } catch (err) {
    fetchError = (err && (err.detail || err.message)) || String(err);
  }

  let behind = null;
  let ahead = null;
  let latest = null;
  if (fetchOk && upstream) {
    const b = await repoGit(['rev-list', '--count', `HEAD..${upstream}`]);
    const a = await repoGit(['rev-list', '--count', `${upstream}..HEAD`]);
    if (b.code === 0) behind = Number.parseInt(b.stdout.trim(), 10) || 0;
    if (a.code === 0) ahead = Number.parseInt(a.stdout.trim(), 10) || 0;
    if (behind !== null && behind > 0) latest = await readCommit(upstream);
  }

  const value = { upstream, behind, ahead, latest, fetchOk, fetchError, checkedAt: Date.now() };
  lastResult = value; // 供 30s 防抖复用（成功与失败都记）
  // ★ 2026-09-21 修复：fetch 失败时**不写缓存**（仍照常返回 value）。
  //   原实现无条件 setCached，导致瞬时网络故障被缓存 10 分钟：用户网络恢复后
  //   UI 仍一直显示「无法检查更新」，直到 TTL 过期。成功才缓存，同一成功结果依旧 10 分钟内复用。
  if (fetchOk) {
    try { store.setCached(CHECK_CACHE_KEY, value); } catch { /* 缓存写失败不影响本次结果 */ }
  }
  return { value, cached: false };
}

/**
 * MacKit 自身的更新状态（总览那颗按钮的数据源）。
 * @param {{force?:boolean}} [opts] force=true 绕过缓存重新 fetch
 * @returns {Promise<any>}
 */
export async function queryStatus(opts = {}) {
  const base = {
    managed: false, repo: paths.REPO_DIR, branch: null, remote: null,
    dirty: 0, head: null, upstream: null, behind: null, ahead: null,
    latest: null, fetchOk: false, fetchError: null, checkedAt: null, cached: false,
  };
  // 非 git 检出（ZIP 下载）→ 如实告知，不假装能更新
  if (!paths.exists(paths.GIT_DIR)) return base;

  const branch = await currentBranch();
  const head = await readCommit('HEAD');
  const statusRes = await repoGit(['status', '--porcelain']);
  const dirty = statusRes.code === 0 ? paths.lines(statusRes.stdout).length : 0;
  const remoteRes = await repoGit(['remote', 'get-url', 'origin']);
  const remote = remoteRes.code === 0 ? (remoteRes.stdout.trim() || null) : null;

  const checked = await checkRemote({ force: opts.force === true });
  return {
    ...base,
    managed: true,
    branch,
    remote,
    dirty,
    head,
    ...checked.value,
    cached: checked.cached,
  };
}

// ------------------------------ 动作 ------------------------------
/** 「检查并更新 MacKit」步骤：fetch → 比较 → pull --ff-only → 提示重启。 */
function updateStep() {
  return {
    id: 'update', title: '检查并更新 MacKit',
    timeoutMs: 300_000,
    run: async (ctx) => {
      if (!paths.exists(paths.GIT_DIR)) {
        throw new AppError(ERR.ENV_MISSING, '当前不是 git 检出，无法自动更新',
          `未找到 ${paths.GIT_DIR}；用 ZIP 下载的副本请到 GitHub 重新下载最新版`);
      }
      const remoteRes = await repoGit(['remote', 'get-url', 'origin']);
      const remote = remoteRes.code === 0 ? remoteRes.stdout.trim() : '';
      if (!remote) {
        throw new AppError(ERR.ENV_MISSING, '未配置 origin 远端，无法自动更新', `仓库：${paths.REPO_DIR}`);
      }
      ctx.log('info', `仓库：${paths.REPO_DIR}`);
      ctx.log('info', `远端：${remote}`);

      const branch = await currentBranch();
      const statusRes = await repoGit(['status', '--porcelain']);
      const dirty = statusRes.code === 0 ? paths.lines(statusRes.stdout).length : 0;
      if (dirty > 0) {
        ctx.log('warn', `本地有 ${dirty} 处未提交改动：更新只用 --ff-only，git 遇到冲突会拒绝，`
          + '不会覆盖、不会 stash、也不会丢弃你的改动');
      }

      const beforeRes = await repoGit(['rev-parse', 'HEAD']);
      const before = beforeRes.stdout.trim();
      ctx.log('info', `当前提交：${before.slice(0, 7) || '未知'}（${branch || 'detached'}）`);

      const onLine = (line, stream) => {
        const t = String(line || '').trim();
        if (t) ctx.log(stream === 'stderr' ? 'warn' : 'info', t);
      };

      ctx.log('info', '执行：git fetch --prune origin');
      await ctx.exec.runWithChannel('proxy_first', '拉取远端信息', 'git', ['fetch', '--prune', 'origin'], {
        cwd: paths.REPO_DIR, noMirror: true, timeoutMs: UPDATE_FETCH_TIMEOUT_MS, onLine,
      });

      const upstream = await upstreamRef(branch);
      const bRes = await repoGit(['rev-list', '--count', `HEAD..${upstream}`]);
      if (bRes.code !== 0) {
        throw new AppError(ERR.CMD_FAILED, `无法比较本地与 ${upstream}`,
          (bRes.stderr || '').trim() || '远端分支可能不存在');
      }
      const behind = Number.parseInt(bRes.stdout.trim(), 10) || 0;
      const aRes = await repoGit(['rev-list', '--count', `${upstream}..HEAD`]);
      const ahead = aRes.code === 0 ? (Number.parseInt(aRes.stdout.trim(), 10) || 0) : 0;
      if (ahead > 0) ctx.log('warn', `本地有 ${ahead} 个提交未推送；--ff-only 更新在分叉时会失败`);

      if (behind === 0) {
        ctx.log('ok', `已经是最新（${upstream} 没有新提交）`);
        try { store.setCached(CHECK_CACHE_KEY, { upstream, behind: 0, ahead, latest: null, fetchOk: true, fetchError: null, checkedAt: Date.now() }); } catch { /* ignore */ }
        return;
      }
      ctx.log('info', `${upstream} 有 ${behind} 个新提交，开始更新…`);

      // 预检：本地改动命中本次更新要改的文件 → 提前停手（否则 git 也会拒绝，还多打一遍错误）
      const conflicts = await findConflicts(upstream, statusRes.stdout);
      if (conflicts.length > 0) {
        throw new AppError(ERR.CMD_FAILED,
          `本地有 ${conflicts.length} 个文件与本次更新冲突，已停止（未改动任何文件）`,
          `涉及：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? ' 等' : ''}\n`
          + '请先提交或暂存（git stash）后再更新。');
      }

      ctx.log('info', '执行：git pull --ff-only');
      try {
        await ctx.exec.runWithChannel('proxy_first', '更新 MacKit', 'git', ['pull', '--ff-only'], {
          cwd: paths.REPO_DIR, noMirror: true, timeoutMs: PULL_TIMEOUT_MS, onLine,
        });
      } catch (err) {
        const detail = (err && (err.detail || err.message)) || String(err);
        const conflict = /local changes|would be overwritten|Your local changes|not possible to fast-forward|diverging/i.test(detail);
        throw new AppError(ERR.CMD_FAILED, '更新失败（工作区保持原样，未产生 merge commit）',
          conflict
            ? `${detail}\n提示：本地改动或分叉与本次更新冲突。请先提交 / 暂存（git stash）后重试。`
            : detail);
      }

      const after = (await repoGit(['rev-parse', 'HEAD'])).stdout.trim();
      const head = await readCommit('HEAD');
      if (after && after !== before) {
        ctx.log('ok', `MacKit 已更新：${before.slice(0, 7)} → ${after.slice(0, 7)}${head ? ` · ${head.subject}` : ''}`);
      } else {
        ctx.log('warn', 'git pull 已结束，但 HEAD 没有变化（可能已是最新）');
      }
      try { store.setCached(CHECK_CACHE_KEY, { upstream, behind: 0, ahead: 0, latest: null, fetchOk: true, fetchError: null, checkedAt: Date.now() }); } catch { /* ignore */ }

      ctx.log('warn', '新的后端代码要重启服务才会生效：点右上角「关闭服务」，再重新双击 app/MacKit.command；'
        + '浏览器页面刷新一下即可（前端文件是每次请求现读的）');
    },
  };
}

export default {
  id: 'selfupdate',
  actions: {
    /** 检查并更新 MacKit 本体（fast-forward；不改用户的本地改动） */
    update: {
      title: '更新 MacKit',
      destructive: true,
      steps: () => [updateStep()],
    },
  },
  queries: { status: queryStatus },
};
