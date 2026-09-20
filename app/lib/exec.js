/**
 * MacKit · 执行层（唯一子进程出口）
 *
 *   - 一律 spawn(bin, argsArray, { shell:false })：绝不启用 shell 选项、绝不拼接命令行字符串
 *   - 命令白名单：brew / git / xattr / security / osascript / curl / node / npm / pnpm / dsh
 *     （+ 绝对路径的 Squirrel）
 *   - 环境变量注入：代理（channel）与 Homebrew 镜像源；PATH 完全固定（不继承宿主）
 *   - 流式 stdout/stderr 逐行回调、超时、AbortSignal 取消（SIGTERM→3s→SIGKILL）
 *   - osascript 管理员授权封装（退出码 -128 = 用户取消）
 *
 * 本文件是全项目唯一 import('node:child_process') 的位置。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import * as paths from './paths.js';
import * as store from './store.js';

// ---------------------------------------------------------------------------
// 错误对象
// ---------------------------------------------------------------------------

export const ERR = Object.freeze({
  ENV_MISSING: 'ENV_MISSING',
  CMD_NOT_ALLOWED: 'CMD_NOT_ALLOWED',
  CMD_FAILED: 'CMD_FAILED',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  AUTH_CANCELLED: 'AUTH_CANCELLED',
  CONFIRM_REQUIRED: 'CONFIRM_REQUIRED',
  NOT_FOUND: 'NOT_FOUND',
  PARSE_FAILED: 'PARSE_FAILED',
  IO_ERROR: 'IO_ERROR',
  NET_UNREACHABLE: 'NET_UNREACHABLE',
  FORBIDDEN: 'FORBIDDEN',
});

/**
 * 统一错误载体：{ code, message, detail? }。
 */
export class AppError extends Error {
  /**
   * @param {string} code 见 ERR
   * @param {string} message 面向用户的中文短语
   * @param {string} [detail] 技术细节（原命令 stderr 摘要）
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** 序列化为对外统一的 ErrObj */
  toObj() {
    const obj = { code: this.code, message: this.message };
    if (this.detail) obj.detail = this.detail;
    return obj;
  }
}

/**
 * 把任意抛出的异常规范化为 ErrObj。
 * @param {unknown} err
 * @returns {{code:string,message:string,detail?:string}}
 */
export function toErrObj(err) {
  if (err && typeof err === 'object') {
    const e = /** @type {any} */ (err);
    const code = typeof e.code === 'string' ? e.code : ERR.CMD_FAILED;
    const message = typeof e.message === 'string' && e.message
      ? e.message
      : '发生未知错误';
    const out = { code, message };
    if (typeof e.detail === 'string' && e.detail) out.detail = e.detail;
    return out;
  }
  return { code: ERR.CMD_FAILED, message: '发生未知错误' };
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 默认单步超时：600s */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** 取消时 SIGTERM → SIGKILL 的等待窗口：3s */
const KILL_GRACE_MS = 3_000;
/** 累积输出上限，避免异常命令撑爆内存 */
const MAX_CAPTURE = 4_000_000;

/**
 * 命令白名单：逻辑名 → 固定路径。
 * ★ 白名单即本表的键集（不另设平行数组，避免两处手工同步漏改）。
 *   node / npm / pnpm / dsh 供 DeepSeek Harness 模块安装与自检使用。
 */
const BIN_MAP = Object.freeze({
  brew: paths.BREW_BIN,
  git: paths.GIT_BIN,
  xattr: paths.XATTR_BIN,
  security: paths.SECURITY_BIN,
  osascript: paths.OSASCRIPT_BIN,
  curl: paths.CURL_BIN,
  node: paths.NODE_BIN,
  npm: paths.NPM_BIN,
  pnpm: paths.PNPM_BIN,
  dsh: paths.DSH_BIN,
});

/**
 * 允许直接以绝对路径调用的可执行。
 *   - Squirrel（--reload）
 *   - plum 的 rime-install 脚本（rime 模块联网安装词库/方案/语法模型所需）：
 *     原本以 `bash rime-install ...` 调用；本应用不使用 bash（不在白名单），
 *     改为直接执行该脚本（自身带 `#!/usr/bin/env bash` shebang，已实测可执行）。
 *   - /bin/bash：仅用于执行 Homebrew 官方安装脚本 install.sh（必须由 bash 解释，
 *     脚本自身会在 macOS 上校验管理员权限并按官方流程安装）；调用方为 brew.install_homebrew。
 */
const ABSOLUTE_ALLOWED = Object.freeze([
  paths.SQUIRREL_BIN,
  `${paths.PLUM_DIR}/rime-install`,
  paths.BASH_BIN,
  // 音乐模块 venv 内的解释器（创建 venv / 执行 bridge.py 都用它）；同一 venv 的 pip
  // 走 resolveBin 的 PY_DIR 前缀放行，无需在此重复登记。
  paths.MUSIC_VENV_PY,
  // 音乐模块「在 Finder 打开下载目录」：只调用 `open <目录>`（参数数组，不拼 shell）。
  paths.OPEN_BIN,
]);

/** 允许的裸 python 解释器文件名（音乐模块用；只认 python3 / python3.12，不含 python）。 */
const PY_BASENAME_RE = /^python3(\.12)?$/;

// ---------------------------------------------------------------------------
// 存活子进程登记（进程退出前的强制回收）
// ---------------------------------------------------------------------------
/**
 * 当前存活的子进程 → 所属 lane 的映射（spawn 成功即登记，关闭即注销）。
 *
 * 为什么要登记：正常取消走 AbortSignal → SIGTERM →（3s）→ SIGKILL，靠 exec 内部的
 * 兜底定时器完成。但**进程准备退出时**（server.js 的 gracefulShutdown）不能只依赖它：
 * `process.exit` 会直接丢掉尚未触发的定时器，把忽略 SIGTERM 的子进程留成孤儿。
 * 登记句柄后，退出路径可以显式补一刀，见 {@link killAllNow}。
 *
 * 为什么带 lane（设计 §5.1）：音乐模块的下载走独立并行通道（lane），其**搜索子进程**
 * 用的是 `music-search` lane。取消音乐下载时必须只杀 `music` lane 的子进程，绝不能
 * 误伤正在跑的搜索子进程（见 {@link killLaneNow}）。
 *
 * @type {Map<import('node:child_process').ChildProcess, string>}
 */
const LIVE_CHILDREN = new Map();

/**
 * 立即对全部存活子进程**整组**发信号（默认 SIGKILL），用于进程退出前的强制回收。
 *
 * 与常规取消的区别：这里不等宽限期、不做优雅终止，属于「最后手段」。
 * 常规取消请走 `opts.signal`（SIGTERM → 3s → SIGKILL）。
 *
 * @param {NodeJS.Signals} [signal='SIGKILL']
 * @returns {number} 实际尝试发信号的子进程数（0 表示当前无存活子进程）
 */
export function killAllNow(signal = 'SIGKILL') {
  let n = 0;
  for (const child of Array.from(LIVE_CHILDREN.keys())) {
    const pid = child.pid;
    try {
      // 优先对进程组发信号（spawn 时 detached:true → 子进程自成进程组），
      // 这样子进程 fork 出的孙进程也会一起结束；无进程组时退回单进程 kill。
      if (pid) process.kill(-pid, signal);
      else child.kill(signal);
      n += 1;
    } catch {
      try { child.kill(signal); n += 1; } catch { /* 进程已退出 */ }
    }
  }
  return n;
}

/**
 * 只对指定 lane 的存活子进程**整组**发信号（默认 SIGKILL）。
 *
 * 用途：取消「音乐下载通道」的全部下载子进程时，**不得**连带杀掉 `music-search`
 * lane 上正在运行的搜索子进程（设计 §5.1 明确点名的隐患）。
 *
 * @param {string} lane 目标 lane 名（'default' | 'music' | 'music-search' | …）
 * @param {NodeJS.Signals} [signal='SIGKILL']
 * @returns {number} 实际尝试发信号的子进程数
 */
export function killLaneNow(lane, signal = 'SIGKILL') {
  let n = 0;
  for (const [child, childLane] of Array.from(LIVE_CHILDREN.entries())) {
    if (childLane !== lane) continue;
    const pid = child.pid;
    try {
      if (pid) process.kill(-pid, signal);
      else child.kill(signal);
      n += 1;
    } catch {
      try { child.kill(signal); n += 1; } catch { /* 进程已退出 */ }
    }
  }
  return n;
}

/**
 * 是否存在存活子进程（任意 lane）。
 *
 * 供 server.js 的优雅退出兜底判断：音乐**搜索会话**用 exec.run 直接起 bridge.py
 * （lane 'music-search'），**不经过 runner**，因此 `runner.isBusy()` / `activeTaskIds()`
 * 看不见它。若只凭 runner 状态决定是否补杀，会在「只有搜索在跑、没有任何任务」时
 * 整段回收被跳过 → Python 子进程变孤儿（见 server.js gracefulShutdown）。
 *
 * @returns {boolean}
 */
export function hasLiveChildren() {
  return LIVE_CHILDREN.size > 0;
}

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

/**
 * p 是否位于 dir 内（含 dir 自身）；参数非法一律 false。
 * @param {string} p
 * @param {string} dir
 * @returns {boolean}
 */
function withinDir(p, dir) {
  if (typeof p !== 'string' || !p || typeof dir !== 'string' || !dir) return false;
  const d = dir.endsWith(path.sep) ? dir.slice(0, -1) : dir;
  return p === d || p.startsWith(d + path.sep);
}

/** realpath（解析符号链接）；路径不存在时回落原值，绝不抛。 */
function realPathOr(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * 解释器目录白名单：`~/.mackit/py` + `PY312_CANDIDATES` 各自目录 + 宿主 PATH 目录。
 * 这些目录来自固定表与宿主 PATH 扫描，**不由用户输入决定**，是「解释器只可能来自哪里」的边界。
 *
 * ★ 按当前 `process.env.PATH` 记忆化：PATH 未变时复用，变了就重算。
 *   （不能只缓存一次——测试 / 运行期可能改写 PATH；paths.findPython312 每次都读实时 PATH，
 *    这里必须与它保持一致，否则会与「探测到的候选」失配。）
 * @type {string[]|null}
 */
let interpreterDirs = null;
let interpreterDirsPath = null;
function trustedInterpreterPath(p) {
  if (!p) return false;
  const pathEnv = String(process.env.PATH || '');
  if (interpreterDirs === null || interpreterDirsPath !== pathEnv) {
    const set = new Set([paths.PY_DIR]);
    for (const c of paths.PY312_CANDIDATES) set.add(path.dirname(c));
    for (const d of pathEnv.split(path.delimiter)) {
      if (d) set.add(path.resolve(d));
    }
    interpreterDirs = [...set];
    interpreterDirsPath = pathEnv;
  }
  return interpreterDirs.some((d) => withinDir(p, d));
}

/**
 * 判断并解析可执行文件路径；不在白名单则抛 CMD_NOT_ALLOWED。
 *
 * 绝对路径放行分三层（设计 §5.1；2026-09-19 按 QA 反馈收紧）：
 *   1) ABSOLUTE_ALLOWED 精确匹配（含音乐 venv 的解释器 / Squirrel / rime-install / bash）；
 *   2) `~/.mackit/py/**` 前缀放行（覆盖 venv 内 `bin/python`、`bin/pip`）——
 *      ★ 先 `path.resolve` 归一化（消解 `..` / `.` / 相对段）**再**比较，避免
 *        `~/.mackit/py/../../evil.sh` 这类「字符串前缀命中、实际落在目录外」的绕过；
 *      ★ 判定用 `withinDir(resolved) || withinDir(real)` 的**「或」语义，这是有意为之**：
 *        必须放行「PY_DIR 内的软链指向外部」，因为真实 venv 的 `bin/python` 就是这种形态
 *        （指向 /opt/homebrew/bin/python3.12 这类基础解释器）；收紧成「与」会把正常 venv 一并拒掉。
 *        ⟹ 本层**不防御「PY_DIR 内被植入软链」这一威胁**：该威胁的前提是攻击者已取得用户级
 *        写权限，早已越过本应用的安全边界。真正兜底的是「`bin` 参数永不由 HTTP 入参 /
 *        配置 / 任务 params 决定」（见 app/test/resolvebin.test.js 的绊线断言）。
 *        realpath 仅在路径存在时参与判断，不存在时回落到归一化结果、不抛。
 *   3) 解释器文件名 `python3` / `python3.12` —— **仅当**其归一化（或 realpath）路径落在
 *      「受信任解释器目录」内（`~/.mackit/py`、`PY312_CANDIDATES` 各自目录、宿主 PATH 目录）。
 *      即解释器只可能来自 PY312 固定候选或宿主 PATH，**不再是「任意目录下名叫 python3 即放行」**。
 *      第 3 层依旧不引入「任意命令」口子：受信任目录来自固定表 + 宿主 PATH，不由用户输入决定。
 *
 * @param {string} name 逻辑名（brew/git/...）或允许的绝对路径
 * @returns {string} 实际可执行文件路径
 */
function resolveBin(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppError(ERR.CMD_NOT_ALLOWED, '命令为空');
  }
  // 绝对路径：仅允许白名单内的绝对可执行
  if (name.includes('/')) {
    if (ABSOLUTE_ALLOWED.includes(name)) return name;

    // 归一化 + realpath（存在时）：后续所有前缀/目录判断都基于归一化结果，杜绝 `..` 绕过
    const resolved = path.resolve(name);
    const real = realPathOr(resolved);

    // 层 2：~/.mackit/py/** 前缀放行（venv 内的 python / pip）
    if (withinDir(resolved, paths.PY_DIR) || withinDir(real, paths.PY_DIR)) return name;

    // 层 3：解释器文件名，但必须落在受信任解释器目录内
    const base = path.basename(name);
    if (PY_BASENAME_RE.test(base)
      && (trustedInterpreterPath(resolved) || trustedInterpreterPath(real))) {
      return name;
    }
    throw new AppError(ERR.CMD_NOT_ALLOWED, `不允许的命令路径：${name}`);
  }
  const fixed = BIN_MAP[name];
  if (!fixed) {
    throw new AppError(ERR.CMD_NOT_ALLOWED, `命令不在白名单：${name}`);
  }
  return fixed;
}

// ---------------------------------------------------------------------------
// 环境变量注入
// ---------------------------------------------------------------------------

/**
 * 读取 brewgo 配置（端口 / 镜像）；读取失败时回落到安全默认值。
 * @returns {{httpPort:number, socksPort:number, mirror:string}}
 */
function safeConfig() {
  try {
    const c = store.readBrewgo();
    return { httpPort: c.httpPort, socksPort: c.socksPort, mirror: c.mirror };
  } catch {
    return { httpPort: 7897, socksPort: 7897, mirror: 'official' };
  }
}

/**
 * 注入代理环境变量（只写小写三键 http_proxy / https_proxy / all_proxy）。
 *
 * ★ 大小写清理（2026-09-20 教训）：buildEnv 会整体继承 process.env，而 libcurl/git 既认
 *   小写也认**大写**的 HTTP_PROXY / HTTPS_PROXY / ALL_PROXY。此前只删小写键，宿主的
 *   大写代理变量会原样漏进「直连」子进程 —— 名义直连，实际仍走代理。因此：
 *     · `direct`：把 http(s)_proxy / all_proxy / no_proxy **大小写不敏感**全部删除；
 *     · `proxy`：先做同样的清理（删大写 HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY 与
 *       no_proxy/NO_PROXY），再写入小写三键 —— 让配置的通道成为唯一权威，
 *       且 NO_PROXY 不能悄悄把某些主机排除在代理之外。
 *   注意：`opts.env` 的显式覆盖发生在本函数之后（buildEnv 里 applyProxyEnv → env 合并），
 *   所以 music/stream.js 里**有意**给 curl 注入大写 HTTP_PROXY/HTTPS_PROXY 的路径不受影响。
 * @param {Record<string,string|undefined>} env
 * @param {'direct'|'proxy'} channel
 * @param {{httpPort:number,socksPort:number}} cfg
 */
export function applyProxyEnv(env, channel, cfg) {
  // 大小写不敏感地摘掉全部代理相关键（http_proxy/https_proxy/all_proxy/no_proxy 各自的大小写形态）
  for (const k of Object.keys(env)) {
    if (/^(https?_proxy|all_proxy|no_proxy)$/i.test(k)) delete env[k];
  }
  if (channel === 'proxy') {
    const host = paths.PROXY_HOST;
    const httpUrl = `http://${host}:${cfg.httpPort}`;
    env.http_proxy = httpUrl;
    env.https_proxy = httpUrl;
    env.all_proxy = `socks5://${host}:${cfg.socksPort}`;
  }
}

/**
 * 注入 Homebrew 镜像源环境变量（BREW_GIT_REMOTE / API_DOMAIN / BOTTLE_DOMAIN）。
 * `MIRROR === 'official'` 时删除三键。
 * @param {Record<string,string|undefined>} env
 * @param {string} mirror
 */
/** 镜像源 → brew git 远端（applyMirrorEnv 与 brew.js 的 cask 索引下载共用一套映射）。 */
export const MIRROR_REMOTES = Object.freeze({
  tuna: 'https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git',
  ustc: 'https://mirrors.ustc.edu.cn/brew.git',
  aliyun: 'https://mirrors.aliyun.com/homebrew/brew.git',
  tencent: 'http://mirrors.cloud.tencent.com/git/homebrew/brew.git',
});

/**
 * 镜像源 → Homebrew **API / Bottles** 域名（2026-09-19 修正）。
 *
 * ★ 为什么必须单独列表：此前的推导是「把 brew.git 远端末尾的 /brew.git 去掉，
 *   再拼 /homebrew-bottles/api」。这对 ustc（`.../brew.git`）和 aliyun
 *   （`.../homebrew/brew.git`）恰好成立，但 tuna / tencent 的远端多一层
 *   `/git/homebrew`，拼出来是 `.../git/homebrew/homebrew-bottles/api` —— 实测 404
 *   （正确的 `.../homebrew-bottles/api/cask.json` 实测 206）。后果有两处：
 *     · brew.js 的中文搜索索引必然下载失败，静默退化成只认英文的 `brew search`；
 *     · 这里注入给 brew 本体的 HOMEBREW_API_DOMAIN / HOMEBREW_BOTTLE_DOMAIN 也是错的。
 *   所以官方 API 域名一律显式维护，不再从 git 远端猜。
 */
export const MIRROR_API_DOMAINS = Object.freeze({
  tuna: 'https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api',
  ustc: 'https://mirrors.ustc.edu.cn/homebrew-bottles/api',
  aliyun: 'https://mirrors.aliyun.com/homebrew/homebrew-bottles/api',
  tencent: 'http://mirrors.cloud.tencent.com/homebrew-bottles/api',
});

/**
 * 取某镜像源的 API 域名（`official` / 未知值 → null，表示用官方 formulae.brew.sh）。
 * @param {string} mirror
 * @returns {string|null}
 */
export function mirrorApiDomain(mirror) {
  return MIRROR_API_DOMAINS[mirror] || null;
}

function applyMirrorEnv(env, mirror) {
  const brew = MIRROR_REMOTES[mirror];
  const api = mirrorApiDomain(mirror);
  if (brew && api) {
    env.HOMEBREW_BREW_GIT_REMOTE = brew;
    env.HOMEBREW_API_DOMAIN = api;
    // Bottle 域名 = API 域名去掉结尾的 /api（四个镜像都是这个形态，实测可用）
    env.HOMEBREW_BOTTLE_DOMAIN = api.replace(/\/api$/, '');
  } else {
    delete env.HOMEBREW_BREW_GIT_REMOTE;
    delete env.HOMEBREW_API_DOMAIN;
    delete env.HOMEBREW_BOTTLE_DOMAIN;
  }
}

/**
 * 构造子进程环境变量。
 * @param {{env?:Record<string,string>, channel?:('direct'|'proxy'), mirror?:string, noMirror?:boolean}} opts
 * @returns {Record<string,string>}
 */
function buildEnv(opts) {
  /** @type {Record<string,string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  // PATH 完全固定，不继承宿主环境（2026-09-16 教训）：宿主 PATH 可能包含工具 shim
  // 目录（如代理工具向 bash 注入的 brokered-bin，且注入脚本会把该目录再次前置到
  // 每个非交互 bash 的 PATH 最顶），劫持 plum 配方管道里的 sed，导致 patch_files
  // 类配方（切换方案/语法模型补丁）把 YAML 正文当 bash 命令执行而全部失败。
  // MacKit 子进程只需要 PATH_PREFIX 内的工具（brew/git/curl/sed 等），全部显式固定。
  // paths.EXEC_PATH = PATH_PREFIX + 各工具（node/npm/pnpm/dsh…）实际所在目录，
  // 这样 nvm / 自定义前缀装的 Node 也能被 `#!/usr/bin/env node` 这类 shebang 找到。
  env.PATH = paths.EXEC_PATH.join(':');
  // 剥离会向子 shell 注入行为的变量：BASH_ENV 会被每个非交互 bash source；
  // BASH_FUNC_* 是 bash 导出函数（同名命令会被函数拦截）。
  delete env.BASH_ENV;
  delete env.ENV;
  for (const k of Object.keys(env)) {
    if (k.startsWith('BASH_FUNC_')) delete env[k];
  }

  const cfg = safeConfig();

  // 镜像源：默认注入
  if (!opts.noMirror) {
    applyMirrorEnv(env, opts.mirror || cfg.mirror);
  }
  // 代理通道：缺省按「直连」处理 —— 显式删除宿主可能存在的代理变量。
  // 不能因为调用方没传 channel 就把宿主的 http_proxy 悄悄带进子进程：那样
  // 「直连 / 代理」两种语义就只对显式传 channel 的调用成立（历史上卸载 / cleanup /
  // git 读取等未传 channel 的路径确实会继承宿主代理）。
  applyProxyEnv(env, opts.channel === 'proxy' ? 'proxy' : 'direct', cfg);
  // 显式追加的环境变量优先级最高
  if (opts.env) {
    for (const [k, v] of Object.entries(opts.env)) {
      if (v === undefined || v === null) delete env[k];
      else env[k] = String(v);
    }
  }
  return env;
}

// ---------------------------------------------------------------------------
// 子进程执行
// ---------------------------------------------------------------------------

/**
 * 创建一个受控子进程并等待结束。
 *
 * @param {string} bin 逻辑名或允许的绝对路径
 * @param {string[]} args 参数数组（绝不拼接 shell 字符串）
 * @param {import('./exec.js').RunOpts} [opts]
 * @returns {Promise<import('./exec.js').RunResult>}
 */
export function run(bin, args, opts = {}) {
  const binPath = resolveBin(bin);
  const argsArr = Array.isArray(args) ? args.slice() : [];
  const env = buildEnv(opts);
  // lane 标记（设计 §5.1）：缺省一律落 'default'，使未传 lane 的调用（现有 7 个模块）
  // 与改动前完全等价；killLaneNow 只按本字段精确匹配目标通道。
  const laneName = (typeof opts.lane === 'string' && opts.lane) || 'default';
  const timeoutMs = typeof opts.timeoutMs === 'number' && opts.timeoutMs > 0
    ? opts.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    // 已取消：直接拒绝
    if (opts.signal && opts.signal.aborted) {
      reject(new AppError(ERR.CANCELLED, '任务已取消'));
      return;
    }

    let child;
    try {
      child = spawn(binPath, argsArr, {
        cwd: opts.cwd || paths.HOME,
        env,
        shell: false,            // ★ 红线：绝不使用 shell
        windowsHide: true,
        // 自成进程组：超时/取消时可整组回收。
        // 脚本类命令（bash install.sh、rime-install）会再 fork 孙进程，
        // 只 kill 直接子进程会把孙进程留成孤儿（常驻服务里会持续累积）。
        detached: true,
        stdio: [opts.stdin !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
      LIVE_CHILDREN.set(child, laneName);
    } catch (err) {
      reject(new AppError(ERR.CMD_FAILED, `无法启动命令 ${bin}`, String(err && err.message)));
      return;
    }

    /** @type {{stdout:string, stderr:string}} */
    const cap = { stdout: '', stderr: '' };
    /**
     * 单行累计上限：`makeLineReader.buf` 只在遇到 `\n` 时才吐出，命令若输出大量
     * **不含换行**的内容（例如 \r 结尾的进度条、二进制转储），buf 会一直涨。
     * 实测灌 24MB 无换行输出 → onLine 收到 25MB 的「一行」、进程堆涨约 394MB
     * （字符串反复 += / slice 的放大）。超过上限就截断成一行发出去并清空。
     */
    const LINE_MAX = 64 * 1024;
    let settled = false;
    let killedByUs = false;
    let killReason = null; // 'cancel' | 'timeout' | null
    let killTimer = null;

    const append = (which, chunk) => {
      if (cap[which].length < MAX_CAPTURE) {
        cap[which] += chunk;
        if (cap[which].length > MAX_CAPTURE) cap[which] = cap[which].slice(0, MAX_CAPTURE);
      }
    };

    // 逐行回调（保留残余，结束时 flush）
    const makeLineReader = (which) => {
      let buf = '';
      /** 把一行交给回调（回调异常不影响执行）。 */
      const emitLine = (line) => {
        if (!opts.onLine) return;
        try { opts.onLine(line, which); } catch { /* 回调异常不影响执行 */ }
      };
      return {
        push(chunk) {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            emitLine(line);
          }
          // 超长且始终没有换行 → 截断发一行，避免 buf 无界增长（见 LINE_MAX 注释）
          if (buf.length > LINE_MAX) {
            emitLine(`${buf.slice(0, LINE_MAX)} …（本行超过 ${LINE_MAX / 1024}KB，已截断）`);
            buf = '';
          }
        },
        flush() {
          if (buf.length === 0) return;
          const line = buf.replace(/\r$/, '');
          buf = '';
          emitLine(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX)} …（本行已截断）` : line);
        },
      };
    };
    const outReader = makeLineReader('stdout');
    const errReader = makeLineReader('stderr');

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d) => { append('stdout', d); outReader.push(d); });
    child.stderr?.on('data', (d) => { append('stderr', d); errReader.push(d); });

    // stdin
    if (opts.stdin !== undefined && child.stdin) {
      // ★ 必须挂 error 监听：`write()` 的失败（EPIPE —— 子进程先退出、管道读端已关）
      //   是**异步**經由 'error' 事件抛出的，外层 try/catch 只兜得住同步异常；
      //   没有监听器时它会变成 uncaughtException，在常驻服务里等于整个进程退出。
      //   当前调用方都只写几十~几百字节（落在管道缓冲内，实测 300 次不触发），
      //   但这是明确的健壮性缺口，一行兜住。
      child.stdin.on('error', () => { /* 子进程没读 stdin 就退出：忽略 */ });
      try {
        child.stdin.write(opts.stdin);
        child.stdin.end();
      } catch { /* ignore */ }
    }

    /**
     * 整组回收：优先对子进程所属进程组发信号（负 pid），
     * 这样 bash 脚本 fork 出来的孙进程也会一起结束；无进程组时退回单进程 kill。
     */
    const killTree = (sig) => {
      const pid = child.pid;
      if (pid) {
        try { process.kill(-pid, sig); return; } catch { /* 退回单进程 */ }
      }
      try { child.kill(sig); } catch { /* ignore */ }
    };

    const doKill = (reason) => {
      if (settled || killedByUs) return;
      killedByUs = true;
      killReason = reason;
      killTree('SIGTERM');
      killTimer = setTimeout(() => killTree('SIGKILL'), KILL_GRACE_MS);
      if (killTimer.unref) killTimer.unref();
    };

    // 超时 / 取消都归到 doKill（SIGTERM → 宽限期 → SIGKILL）
    const timeoutTimer = setTimeout(() => doKill('timeout'), timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    const onAbort = () => doKill('cancel');
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      LIVE_CHILDREN.delete(child); // 结束即注销（Map.delete 与旧 Set.delete 语义一致），killAllNow / killLaneNow 不会误伤已退出的进程
    };

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      outReader.flush();
      errReader.flush();
      if (killReason === 'cancel') {
        reject(new AppError(ERR.CANCELLED, '任务已取消'));
      } else if (killReason === 'timeout') {
        reject(new AppError(
          ERR.TIMEOUT,
          `命令超时（>${Math.round(timeoutMs / 1000)}s）`,
          paths.tailLines(cap.stderr, 5) || undefined
        ));
      } else {
        resolve({ code: code === null ? -1 : code, signal: signal || null, stdout: cap.stdout, stderr: cap.stderr });
      }
    };

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new AppError(ERR.CMD_FAILED, `无法执行 ${bin}`, String(err && err.message)));
    });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

/**
 * 执行并吞掉异常，返回统一的「子进程退出码」结构。
 *
 * 供「只读探测 / 尽力而为」场景使用（env / sysinit / backup 的同类兜底已收敛到这里）。
 *
 * ★ 失败一律回落数字 `-1`，绝不把 AppError 的字符串语义码（如 CMD_NOT_ALLOWED）
 *   塞进 `code`：下游全部按「子进程退出码」用它（`res.code !== 0`），
 *   混入字符串会让类型失去意义。原始错误码另见 `errCode`。
 *
 * @param {string} bin
 * @param {string[]} args
 * @param {import('./exec.js').RunOpts} [opts]
 * @returns {Promise<{code:number, signal:null, stdout:string, stderr:string, errCode:string|null}>}
 */
export async function runSafe(bin, args, opts = {}) {
  try {
    return await run(bin, args, opts);
  } catch (err) {
    return {
      code: -1,
      signal: null,
      stdout: '',
      stderr: (err && err.message) || String(err),
      errCode: (err && err.code) || null,
    };
  }
}

// ---------------------------------------------------------------------------
// 通道尝试
// ---------------------------------------------------------------------------

/**
 * 按策略依次尝试通道，成功即返回并可返回命中的通道。
 *
 * 策略语义：
 *   - 'proxy_first' → [proxy, direct]
 *   - 'direct_first' → [direct, proxy]
 *   - 'auto'         → [direct, proxy]（自动降级，等价 direct_first 的尝试顺序）
 *
 * @param {'direct_first'|'proxy_first'|'auto'} policy
 * @param {string} desc 人类可读的描述（用于失败汇总）
 * @param {string} bin
 * @param {string[]} args
 * @param {import('./exec.js').RunOpts & { onAttempt?:(ch:'direct'|'proxy', phase:'try'|'fail'|'ok')=>void }} [opts]
 * @returns {Promise<import('./exec.js').RunResult & { channel:'direct'|'proxy' }>}
 */
export async function runWithChannel(policy, desc, bin, args, opts = {}) {
  const order = policy === 'proxy_first' ? ['proxy', 'direct'] : ['direct', 'proxy'];
  let lastDetail = '';
  let lastCode = null;

  for (let i = 0; i < order.length; i++) {
    const channel = /** @type {'direct'|'proxy'} */ (order[i]);
    if (opts.onAttempt) {
      try { opts.onAttempt(channel, 'try'); } catch { /* ignore */ }
    }
    try {
      const res = await run(bin, args, { ...opts, channel });
      if (res.code === 0) {
        if (opts.onAttempt) {
          try { opts.onAttempt(channel, 'ok'); } catch { /* ignore */ }
        }
        return { ...res, channel };
      }
      lastCode = res.code;
      lastDetail = paths.tailLines(res.stderr || res.stdout);
      if (opts.onAttempt) {
        try { opts.onAttempt(channel, 'fail'); } catch { /* ignore */ }
      }
    } catch (err) {
      // 取消 / 超时不降级，直接向上抛
      if (err instanceof AppError && (err.code === ERR.CANCELLED || err.code === ERR.TIMEOUT)) {
        throw err;
      }
      lastDetail = err instanceof AppError ? (err.detail || err.message) : String(err);
      if (opts.onAttempt) {
        try { opts.onAttempt(channel, 'fail'); } catch { /* ignore */ }
      }
    }
  }

  throw new AppError(
    ERR.CMD_FAILED,
    `${desc}失败，直连与代理均不可用`,
    (lastCode !== null ? `exit=${lastCode}\n` : '') + lastDetail
  );
}

// ---------------------------------------------------------------------------
// osascript 管理员授权
// ---------------------------------------------------------------------------

/**
 * POSIX 单引号转义：把任意字符串安全嵌入单引号 shell 片段。
 * `'` → `'\''`
 * @param {string} s
 * @returns {string} 形如 'xxx' 的安全单引号片段
 */
export function posixQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/**
 * 把字符串转义为 AppleScript 双引号字符串字面量的内容。
 * @param {string} s
 * @returns {string}
 */
function escapeAppleScript(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * 以管理员权限执行一条 shell 命令（弹系统密码框；密码不经过应用）。
 *
 * @param {string} shellCmd 已构造好的 shell 命令字符串（调用方需用 posixQuote 处理路径）
 * @param {{timeoutMs?:number, signal?:AbortSignal}} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string, cancelled:boolean}>}
 *          code === -128 表示用户取消授权（对应 AUTH_CANCELLED，不算失败）
 */
export async function osascriptAdmin(shellCmd, opts = {}) {
  const script = `do shell script "${escapeAppleScript(shellCmd)}" with administrator privileges`;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  const res = await run(paths.OSASCRIPT_BIN, ['-e', script], {
    timeoutMs,
    signal: opts.signal,
    noMirror: true, // 授权命令不需要 brew 镜像注入
  });
  return {
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    cancelled: res.code === -128,
  };
}

// ---------------------------------------------------------------------------
// 在 Finder 打开目录
// ---------------------------------------------------------------------------

/**
 * 在 Finder 中打开一个目录（音乐模块 P0-6「在 Finder 打开下载目录」）。
 *
 * 语义等价于 `open <dir>`：把（用户可控的）目录以**参数数组**原样交给 `/usr/bin/open`
 * —— 与 {@link osascriptAdmin} 同类，是本层对某个具体工具的语义封装，**集中保证**
 * 「绝不拼 shell 字符串」（exec 层一律 `shell:false`，无注入面）。
 *
 * 之所以做成 exec 层语义封装而非在模块内直接 `run(paths.OPEN_BIN, …)`：让 `bin` 常量
 * 统一收敛在唯一的子进程出口（exec.js），模块侧只表达「打开目录」的意图。
 *
 * ★ 参数用 `['--', target]`：加终止符后，任何以 `-` 开头的路径（用户若把目录命名为
 *   `-backup`）都会被 `open` 当普通路径而非选项（macOS 的 `open` 基于 getopt，支持 `--`）。
 *
 * @param {string} dir 目标目录（调用方需确保其存在）
 * @param {{timeoutMs?:number, signal?:AbortSignal, lane?:string}} [opts]
 * @returns {Promise<import('./exec.js').RunResult>}
 */
export function openInFinder(dir, opts = {}) {
  const target = String(dir == null ? '' : dir);
  if (!target) return Promise.reject(new AppError(ERR.PARSE_FAILED, '目录为空'));
  return run(paths.OPEN_BIN, ['--', target], { noMirror: true, ...opts });
}
