/**
 * MacKit · 执行层（唯一子进程出口）
 *
 * 依据《MacKit-架构设计.md》§3.8 与 §8.8：
 *   - 一律 spawn(bin, argsArray, { shell:false })：绝不启用 shell 选项、绝不拼接命令行字符串
 *   - 命令白名单：brew / git / xattr / security / osascript / curl / open（+ 绝对路径的 Squirrel）
 *   - 环境变量注入：代理（channel）与 Homebrew 镜像源；PATH 完全固定（不继承宿主）
 *   - 流式 stdout/stderr 逐行回调、超时、AbortSignal 取消（SIGTERM→3s→SIGKILL）
 *   - osascript 管理员授权封装（退出码 -128 = 用户取消）
 *
 * 本文件是全项目唯一 import('node:child_process') 的位置。
 */

import { spawn } from 'node:child_process';
import * as paths from './paths.js';
import * as store from './store.js';

// ---------------------------------------------------------------------------
// 错误对象（§3.2）
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

  /** 序列化为 §3.2 的 ErrObj */
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

/** 命令白名单（逻辑名） */
export const WHITELIST = Object.freeze([
  'brew', 'git', 'xattr', 'security', 'osascript', 'curl', 'open',
]);

/** 默认单步超时：600s */
export const DEFAULT_TIMEOUT_MS = 600_000;
/** 取消时 SIGTERM → SIGKILL 的等待窗口：3s */
export const KILL_GRACE_MS = 3_000;
/** 累积输出上限，避免异常命令撑爆内存 */
const MAX_CAPTURE = 4_000_000;

/** 逻辑名 → 固定路径 */
const BIN_MAP = Object.freeze({
  brew: paths.BREW_BIN,
  git: paths.GIT_BIN,
  xattr: paths.XATTR_BIN,
  security: paths.SECURITY_BIN,
  osascript: paths.OSASCRIPT_BIN,
  curl: paths.CURL_BIN,
  open: paths.OPEN_BIN,
});

/**
 * 允许直接以绝对路径调用的可执行。
 *   - §8.8 的 Squirrel（--reload）
 *   - plum 的 rime-install 脚本（rime 模块联网安装词库/方案/语法模型所需）：
 *     原脚本以 `bash rime-install ...` 调用；本应用不复刻 bash（不在白名单），
 *     改为直接执行该脚本（自身带 `#!/usr/bin/env bash` shebang，已实测可执行）。
 *   - /bin/bash：仅用于执行 Homebrew 官方安装脚本 install.sh（必须由 bash 解释，
 *     脚本自身会在 macOS 上校验管理员权限并按官方流程安装）；调用方为 brew.install_homebrew。
 */
const ABSOLUTE_ALLOWED = Object.freeze([
  paths.SQUIRREL_BIN,
  `${paths.PLUM_DIR}/rime-install`,
  paths.BASH_BIN,
]);

// ---------------------------------------------------------------------------
// 存活子进程登记（进程退出前的强制回收）
// ---------------------------------------------------------------------------
/**
 * 当前存活的子进程集合（spawn 成功即登记，关闭即注销）。
 *
 * 为什么要登记：正常取消走 AbortSignal → SIGTERM →（3s）→ SIGKILL，靠 exec 内部的
 * 兜底定时器完成。但**进程准备退出时**（server.js 的 gracefulShutdown）不能只依赖它：
 * `process.exit` 会直接丢掉尚未触发的定时器，把忽略 SIGTERM 的子进程留成孤儿。
 * 登记句柄后，退出路径可以显式补一刀，见 {@link killAllNow}。
 */
const LIVE_CHILDREN = new Set();

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
  for (const child of Array.from(LIVE_CHILDREN)) {
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

/** 当前存活子进程数（仅用于测试与诊断，不参与业务逻辑）。 */
export function liveChildCount() { return LIVE_CHILDREN.size; }

// ---------------------------------------------------------------------------
// 解析与校验
// ---------------------------------------------------------------------------

/**
 * 判断并解析可执行文件路径；不在白名单则抛 CMD_NOT_ALLOWED。
 * @param {string} name 逻辑名（brew/git/...）或允许的绝对路径
 * @returns {string} 实际可执行文件路径
 */
export function resolveBin(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppError(ERR.CMD_NOT_ALLOWED, '命令为空');
  }
  // 绝对路径：仅允许白名单内的绝对可执行
  if (name.includes('/')) {
    if (ABSOLUTE_ALLOWED.includes(name)) return name;
    throw new AppError(ERR.CMD_NOT_ALLOWED, `不允许的命令路径：${name}`);
  }
  if (!WHITELIST.includes(name)) {
    throw new AppError(ERR.CMD_NOT_ALLOWED, `命令不在白名单：${name}`);
  }
  const fixed = BIN_MAP[name];
  if (fixed) return fixed;
  return name;
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
 * 注入代理环境变量（严格复刻 `brewgo.sh:54-61` 的小写三键语义）。
 * @param {Record<string,string|undefined>} env
 * @param {'direct'|'proxy'} channel
 * @param {{httpPort:number,socksPort:number}} cfg
 */
function applyProxyEnv(env, channel, cfg) {
  if (channel === 'proxy') {
    const host = paths.PROXY_HOST;
    const httpUrl = `http://${host}:${cfg.httpPort}`;
    env.http_proxy = httpUrl;
    env.https_proxy = httpUrl;
    env.all_proxy = `socks5://${host}:${cfg.socksPort}`;
  } else if (channel === 'direct') {
    // direct：显式删除（不是置空），确保真的不走代理
    delete env.http_proxy;
    delete env.https_proxy;
    delete env.all_proxy;
  }
}

/**
 * 注入 Homebrew 镜像源环境变量（复刻 `apply_mirror`）。
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

function applyMirrorEnv(env, mirror) {
  const brew = MIRROR_REMOTES[mirror];
  if (brew) {
    env.HOMEBREW_BREW_GIT_REMOTE = brew;
    env.HOMEBREW_API_DOMAIN = `${brew.replace(/\/brew\.git$/, '')}/homebrew-bottles/api`;
    env.HOMEBREW_BOTTLE_DOMAIN = `${brew.replace(/\/brew\.git$/, '')}/homebrew-bottles`;
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
export function buildEnv(opts) {
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
  env.PATH = paths.PATH_PREFIX.join(':');
  // 剥离会向子 shell 注入行为的变量：BASH_ENV 会被每个非交互 bash source；
  // BASH_FUNC_* 是 bash 导出函数（同名命令会被函数拦截）。
  delete env.BASH_ENV;
  delete env.ENV;
  for (const k of Object.keys(env)) {
    if (k.startsWith('BASH_FUNC_')) delete env[k];
  }

  const cfg = safeConfig();

  // 镜像源：默认注入（与原脚本启动时 apply_mirror 一致）
  if (!opts.noMirror) {
    applyMirrorEnv(env, opts.mirror || cfg.mirror);
  }
  // 代理通道
  if (opts.channel === 'proxy' || opts.channel === 'direct') {
    applyProxyEnv(env, opts.channel, cfg);
  }
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
      LIVE_CHILDREN.add(child);
    } catch (err) {
      reject(new AppError(ERR.CMD_FAILED, `无法启动命令 ${bin}`, String(err && err.message)));
      return;
    }

    /** @type {{stdout:string, stderr:string}} */
    const cap = { stdout: '', stderr: '' };
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
      return {
        push(chunk) {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, idx).replace(/\r$/, '');
            buf = buf.slice(idx + 1);
            if (opts.onLine) {
              try { opts.onLine(line, which); } catch { /* 回调异常不影响执行 */ }
            }
          }
        },
        flush() {
          if (buf.length > 0) {
            const line = buf.replace(/\r$/, '');
            buf = '';
            if (opts.onLine) {
              try { opts.onLine(line, which); } catch { /* ignore */ }
            }
          }
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

    // 超时
    const timeoutTimer = setTimeout(() => doKill('timeout'), timeoutMs);
    if (timeoutTimer.unref) timeoutTimer.unref();

    // 取消
    const onAbort = () => doKill('cancel');
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (opts.signal) opts.signal.removeEventListener('abort', onAbort);
      LIVE_CHILDREN.delete(child); // 结束即注销，killAllNow 不会误伤已退出的进程
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
          cap.stderr.trim().split('\n').slice(-5).join('\n') || undefined
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

// ---------------------------------------------------------------------------
// 通道尝试（复刻 run_with_mode）
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
      lastDetail = (res.stderr || res.stdout || '').trim().split('\n').slice(-3).join('\n');
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
export function escapeAppleScript(s) {
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

export default {
  ERR,
  AppError,
  toErrObj,
  WHITELIST,
  MIRROR_REMOTES,
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  resolveBin,
  buildEnv,
  run,
  killAllNow,
  liveChildCount,
  runWithChannel,
  osascriptAdmin,
  posixQuote,
  escapeAppleScript,
};
