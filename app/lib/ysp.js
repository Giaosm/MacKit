/**
 * MacKit · 央视频直播（后端模块）
 *
 * 功能来自第三方脚本 `ysp-live-v9.5`（Python，约 3500 行：央视频 4K/1080p 双引擎、
 * HLS 代理、7 天时移回看、单端口 8767 出 m3u 订阅）。**不重写、不内联**：
 *   · 那是作者的完整实现（含设备协议 / AES / WASM 伴生引擎），重写等于重造一遍且必然漂移；
 *   · 作者在 README 里写明「其他任何分发渠道均非作者本人」，所以脚本**不进本仓库** ——
 *     用户自己解压到 MacKit 根目录的 `ysp-live-vX.Y/`，本模块只负责把它当**受管服务**跑起来。
 *   · 具体用哪份目录不写死：`paths.findYspDist()` 自动挑版本号最大的（见该函数注释），
 *     作者发新版只需把新目录丢进根目录，代码一行不改。
 *
 * 本模块的职责（就是「把它接进 MacKit」这件事）：
 *   - start  ：python3 自检 → spawnDetached 拉起（脱离 MacKit 生命周期）→ 等 /health 就绪；
 *   - stop   ：按 ~/.mackit/ysp.json 里的 pid 对**整个进程组**发 SIGTERM（→ 8s → SIGKILL），
 *              连带回收脚本自己 fork 的 ysp-engine.js；
 *   - restart：停止 + 启动（服务未运行时「停止」记 skip，不阻断启动）；
 *   - status ：脚本 / 解释器是否就位、是否在跑、端口、版本、频道数、引擎就绪、订阅地址；
 *   - logs   ：日志尾部（脚本 stdout/stderr 追加到 ~/.mackit/ysp.log）。
 *
 * ★ 为什么服务要脱离 MacKit 生命周期（spawnDetached）：直播是给播放器（TiviMate / APTV）
 *   拉流用的常驻服务，MacKit 重启 / 关界面不应该把正在看的流掐断；用户要停就点「停止」。
 * ★ 状态文件里的 pid 是「是否由本应用拉起」的唯一依据：端口上有响应但 pid 不是我们的，
 *   就如实说「不是 MacKit 启动的，无法自动停止」，绝不盲杀别人的进程。
 */

import fs from 'node:fs';
import * as paths from './paths.js';
import * as exec from './exec.js';

const { ERR, AppError } = exec;

/** 就绪等待上限：首启要初始化设备会话并拉频道目录，实测 2~6s；给足 30s，避免慢网误判失败。 */
const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 400;
/** 停止等待上限：SIGTERM 后最多等 8s，再补 SIGKILL。 */
const STOP_TIMEOUT_MS = 8_000;
const HEALTH_TIMEOUT_MS = 1_200;
/** status 结果缓存：前端每 5s 轮询、多标签页会叠加 —— 2s 内复用同一次探测。 */
const STATUS_CACHE_MS = 2_000;
/** 日志只读文件尾部这么多字节（脚本的 diag 日志可能很长，绝不整文件读入）。 */
const LOG_TAIL_BYTES = 128 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 毫秒 → `1 小时 23 分`（只用于「停止」日志里那句「已运行多久」）。 */
function fmtUptime(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
}

// ---------------------------------------------------------------------------
// 运行态（谁是本应用拉起的那个进程）
// ---------------------------------------------------------------------------

/**
 * 读运行态文件。
 * @returns {{pid:number, port:number, startedAt:number}|null} 无文件 / 损坏 → null
 */
function readState() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.YSP_STATE_JSON, 'utf8'));
    if (!raw || !Number.isInteger(raw.pid) || raw.pid <= 1) return null;
    return {
      pid: raw.pid,
      port: Number.isInteger(raw.port) && raw.port > 0 ? raw.port : paths.YSP_PORT,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
    };
  } catch { return null; }
}

function writeState(state) {
  try {
    paths.ensureDirs();
    fs.writeFileSync(paths.YSP_STATE_JSON, JSON.stringify({ ...state, version: 1 }, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(paths.YSP_STATE_JSON, 0o600); } catch { /* 权限设置失败不致命（目录 0700） */ }
  } catch { /* 写不了运行态不致命：只影响「停止」能否找到 pid，状态页会如实显示 */ }
}

/**
 * 删除运行态 —— 只在**仍是同一个 pid** 时删。
 * 与 server.js 的 removeRuntime 同款理由：并发路径下不要把别的进程刚写好的状态抹掉。
 * @param {number} pid 期望的 pid（0 表示不校验）
 */
function clearState(pid) {
  const cur = readState();
  if (cur && pid && cur.pid !== pid) return;
  try { fs.rmSync(paths.YSP_STATE_JSON, { force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * 请求脚本的 /health。响应 `{ ok:true, version, channels, engine:{ready}, uptime_sec }`。
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<object|null>} 不可达 / 非 2xx / 非 JSON / ok!==true → null
 */
async function probeHealth(port, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ok === true ? data : null;
  } catch { return null; }
}

/**
 * 定位当前该用的脚本目录（自动发现最新版本，见 paths.findYspDist）。
 * 每次调用都现扫一次 `REPO_DIR`（十来个条目、几十微秒），这样用户把新版本目录丢进来后
 * 不必重启 MacKit —— status 有 2s 缓存，不会变成每 5s 轮询一次读目录的负担。
 */
function locate() {
  const dist = paths.findYspDist();
  return {
    dir: dist.dir,
    script: dist.script,
    version: dist.version,
    others: dist.others,
    scriptExists: dist.found && fs.existsSync(dist.script),
  };
}

/**
 * 「python3 真的能跑吗」——文件存在不等于可用（macOS 自带的 /usr/bin/python3 在未装
 * Xcode 命令行工具时是个一执行就报错的 shim），所以真跑一次 `--version`。
 * 注：Python 2 把版本打到 stderr，Python 3 打到 stdout —— 两边都收。
 * @returns {Promise<{ok:boolean, version:string, detail:string}>}
 */
async function probePython() {
  if (!fs.existsSync(paths.PYTHON3_BIN)) {
    return { ok: false, version: '', detail: `未找到 ${paths.PYTHON3_BIN}` };
  }
  const r = await exec.runSafe('python3', ['--version'], { timeoutMs: 15_000, noMirror: true });
  const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
  return r.code === 0
    ? { ok: true, version: text, detail: '' }
    : { ok: false, version: '', detail: text || `退出码 ${r.code}` };
}

/**
 * 核对某个 pid 到底是不是我们启的那个直播脚本。
 *
 * ★ 为什么必须核对：`~/.mackit/ysp.json` 是上一轮留下的，而 pid 会被系统复用
 *   （重启电脑后尤其容易撞上）。只凭 {@link exec.isPidAlive} 就认定「这是我们的服务」，
 *   极端情况下会对**别人整组进程**发 SIGTERM —— 宁可拒绝停止，也绝不误杀。
 *   判据：`ps -o command= -p <pid>` 的命令行里含 `ysp-live*.py`。
 *
 * @param {number} pid
 * @returns {Promise<boolean>}
 */
async function pidOwnedByUs(pid) {
  if (!exec.isPidAlive(pid)) return false;
  const r = await exec.runSafe('ps', ['-o', 'command=', '-p', String(pid)], { timeoutMs: 5_000, noMirror: true });
  if (r.code !== 0) return false;
  return /ysp-live[^\s]*\.py/.test(r.stdout);
}

/**
 * 读文件尾部（最多 LOG_TAIL_BYTES）。
 * @param {string} file
 * @returns {{text:string, size:number, truncated:boolean}|null}
 */
function readTail(file) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - LOG_TAIL_BYTES);
    const len = st.size - start;
    if (len <= 0) return { text: '', size: st.size, truncated: false };
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // 从中间截断会切在多字节字符 / 半行上：丢掉第一段残行，避免日志开头出现半截乱码
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return { text, size: st.size, truncated: start > 0 };
  } catch { return null; }
  finally { if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } } }
}

/**
 * 去掉 ANSI 颜色码。
 * 脚本的 banner 是**无条件**彩色的（不判断 isatty），直接展示会在界面上出现一堆
 * `\u001b[1;31m` 乱码，所以在出 HTTP 之前统一剥掉。
 * @param {string} text
 */
function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** 日志尾部若干行（失败详情用）。 */
function tailText(lines = 20) {
  const t = readTail(paths.YSP_LOG);
  if (!t || !t.text) return '';
  return stripAnsi(t.text).split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/**
 * 等待端口就绪。
 * @param {object} ctx 步骤上下文（用它的 log / signal）
 * @param {number} pid 刚拉起的进程
 * @returns {Promise<object|null>} health 负载；进程提前退出 / 超时 → null
 */
async function waitReady(ctx, pid) {
  const start = Date.now();
  let lastNotice = 0;
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (ctx.signal && ctx.signal.aborted) throw new AppError(ERR.CANCELLED, '任务已取消');
    const health = await probeHealth(paths.YSP_PORT);
    if (health) return health;
    if (!exec.isPidAlive(pid)) {
      ctx.log('error', '进程已退出，未能监听端口');
      return null;
    }
    const waited = Date.now() - start;
    if (waited - lastNotice >= 5_000) {
      lastNotice = waited;
      ctx.log('info', `仍在等待端口 ${paths.YSP_PORT} 就绪（${Math.round(waited / 1000)}s）…`);
    }
    await sleep(READY_POLL_MS);
  }
  return null;
}

/** 「启动」步骤（start 与 restart 共用）。 */
function startStep() {
  return {
    id: 'start',
    title: '启动直播服务',
    run: async (ctx) => {
      const loc = locate();
      if (!loc.scriptExists) {
        throw new AppError(
          ERR.ENV_MISSING,
          '未找到直播脚本',
          `没有在 ${paths.REPO_DIR} 下找到 ysp-live-vX.Y 目录（含 ysp-live*.py）\n`
          + '请把作者发布的整个目录解压到 MacKit 根目录（与 app/ 同级），名字保持原样即可'
        );
      }
      ctx.log('info', `脚本：${loc.script}${loc.version ? `（v${loc.version}）` : ''}`);
      if (loc.others.length) ctx.log('info', `同时存在旧版本目录（已忽略）：${loc.others.join('、')}`);
      // 已在运行：可能是上一轮 MacKit 拉起的（状态文件还在），也可能只是端口被占。
      // 这里必须核对 pid 归属：pid 被复用时会误判成「我们的服务还在跑」。
      const prev = readState();
      if (prev && await pidOwnedByUs(prev.pid) && await probeHealth(prev.port)) {
        ctx.log('warn', `服务已在运行（pid ${prev.pid}），无需重复启动`);
        throw new AppError(ERR.SKIP, '服务已在运行');
      }
      if (await probeHealth(paths.YSP_PORT)) {
        ctx.log('warn', `端口 ${paths.YSP_PORT} 上已有服务在响应，未重复启动（可能是你手动运行的实例）`);
        throw new AppError(ERR.SKIP, `端口 ${paths.YSP_PORT} 已被占用`);
      }
      const py = await probePython();
      if (!py.ok) {
        throw new AppError(
          ERR.ENV_MISSING,
          'python3 不可用',
          `${py.detail || ''}\n请先安装：xcode-select --install（系统自带）或 brew install python`
        );
      }
      ctx.log('info', `解释器：${paths.PYTHON3_BIN}${py.version ? `（${py.version}）` : ''}`);

      paths.ensureDirs();
      try { fs.mkdirSync(paths.YSP_DATA_DIR, { recursive: true, mode: 0o700 }); } catch { /* 脚本自己也会尝试建 */ }

      const pid = exec.spawnDetached(
        'python3',
        [loc.script, String(paths.YSP_PORT), '--data-dir', paths.YSP_DATA_DIR],
        {
          cwd: loc.dir,
          outFile: paths.YSP_LOG,
          // ★ PYTHONUNBUFFERED 是关键：stdout 重定向到文件时 Python 默认**全缓冲**，
          //   日志要攒满 8KB 才落盘 —— 「点了启动，日志里却什么都没有」正是这个原因。
          env: { PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' },
        }
      );
      if (!pid) throw new AppError(ERR.CMD_FAILED, '未能拉起直播服务进程', `请查看日志：${paths.YSP_LOG}`);

      writeState({ pid, port: paths.YSP_PORT, startedAt: Date.now() });
      ctx.log('info', `已拉起进程（pid ${pid}），等待端口 ${paths.YSP_PORT} 就绪…`);

      const health = await waitReady(ctx, pid);
      if (!health) {
        // 起不来的进程必须收掉：否则它会一直占着 pid 文件，界面还显示「已启动」
        exec.killPid(pid, 'SIGTERM');
        clearState(pid);
        throw new AppError(ERR.CMD_FAILED, '服务启动失败：端口未就绪', tailText(20) || '日志为空');
      }
      ctx.log('ok', `服务已就绪：${health.channels || 0} 个频道，版本 ${health.version || '未知'}`);
      ctx.log('info', `订阅地址：http://127.0.0.1:${paths.YSP_PORT}/all.m3u`);
      // health.engine.ready = 「设备协议（4K/高码率）就绪」，与 WASM 伴生引擎是两件事：
      // 首次启动要注册设备身份，几秒到几十秒内为 false，期间 4K 频道自动回退 1080p。
      if (health.engine && health.engine.ready === false) {
        ctx.log('info', '高码率设备协议仍在初始化：4K/8K 频道暂时走 1080p 回退，就绪后自动切换');
      }
    },
  };
}

/** 「停止」步骤（stop 与 restart 共用）。 */
function stopStep() {
  return {
    id: 'stop',
    title: '停止直播服务',
    run: async (ctx) => {
      const st = readState();
      const pid = st ? st.pid : 0;
      const ours = pid ? await pidOwnedByUs(pid) : false;
      if (!ours) {
        // pid 已死，或已被系统复用给别的进程 —— 两种都不发任何信号，只清理自己的记录
        if (pid && exec.isPidAlive(pid)) {
          ctx.log('warn', `运行态记录的 pid ${pid} 已不是直播脚本（pid 可能被系统复用），未发送任何信号，仅清理记录`);
        }
        clearState(pid);
        if (await probeHealth(paths.YSP_PORT)) {
          ctx.log('warn', `端口 ${paths.YSP_PORT} 上仍有服务在响应，但它不是 MacKit 启动的，不做处理`);
          throw new AppError(ERR.SKIP, '该实例不是 MacKit 启动的，请手动结束它');
        }
        ctx.log('info', '服务未在运行，无需停止');
        throw new AppError(ERR.SKIP, '服务未在运行');
      }

      // 运行态里的 startedAt 只在日志里露一面：停之前让用户看清「这个挂了多久的实例」被停掉了
      const uptime = st && st.startedAt ? `，已运行 ${fmtUptime(Date.now() - st.startedAt)}` : '';
      ctx.log('info', `正在停止（pid ${pid}${uptime}）…`);
      // 对进程组发信号：脚本自己 fork 的 ysp-engine.js 与它同组，会一起收到
      exec.killPid(pid, 'SIGTERM');
      const deadline = Date.now() + STOP_TIMEOUT_MS;
      while (Date.now() < deadline && exec.isPidAlive(pid)) {
        if (ctx.signal && ctx.signal.aborted) break;
        await sleep(200);
      }
      if (exec.isPidAlive(pid)) {
        ctx.log('warn', `进程 ${STOP_TIMEOUT_MS / 1000}s 内未退出，改用 SIGKILL`);
        exec.killPid(pid, 'SIGKILL');
        await sleep(400);
      }
      if (exec.isPidAlive(pid)) {
        throw new AppError(ERR.CMD_FAILED, '停止失败：进程仍在运行', `请手动结束 pid ${pid}（kill -9 ${pid}）`);
      }
      clearState(pid);
      ctx.log('ok', '服务已停止');
    },
  };
}

const actions = {
  start: {
    title: '启动央视频直播',
    destructive: false,
    steps: () => [startStep()],
  },
  stop: {
    title: '停止央视频直播',
    destructive: false,
    steps: () => [stopStep()],
  },
  restart: {
    title: '重启央视频直播',
    destructive: false,
    // 未在运行时「停止」会抛 SKIP（runner 记为跳过，不中断后续步骤）→ 直接启动
    steps: () => [stopStep(), startStep()],
  },
};

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** status 的短缓存（见 STATUS_CACHE_MS）。 */
let statusCache = { at: 0, value: null };

/** 一次完整探测（status / logs 之外的内部用）。 */
async function collectStatus() {
  const loc = locate();
  const st = readState();
  // 「这个 pid 还是不是我们的脚本」必须核实：pid 复用会让旧记录指向无关进程
  const ours = st ? await pidOwnedByUs(st.pid) : false;
  const health = await probeHealth(st ? st.port : paths.YSP_PORT);
  const running = !!health;
  const port = st ? st.port : paths.YSP_PORT;

  return {
    installed: loc.scriptExists,
    script: loc.script,
    /** 目录名里的版本号（自动发现时挑中的那一份）；未发现时为空串 */
    distVersion: loc.version || null,
    /** 同时存在的旧版本目录（已忽略，仅作提示） */
    otherDists: loc.others,
    python: { bin: paths.PYTHON3_BIN, exists: fs.existsSync(paths.PYTHON3_BIN) },
    port,
    running,
    /** 端口上是**本应用拉起的**实例（pid 活着且命令行确实是这个脚本） */
    managed: running && ours,
    /** 端口上有响应但不是我们拉起的（手动跑的 / 别的工具）→ 只能提示，不能停 */
    foreign: running && !ours,
    pid: ours ? st.pid : null,
    version: running ? (health.version || null) : null,
    channels: running ? (health.channels ?? null) : null,
    /**
     * 高码率（4K/8K）**设备协议**是否就绪 —— 对应 /health 的 `engine.ready`。
     * ★ 不是「WASM 伴生引擎」：后者是脚本自己用 node 拉起的 ysp-engine.js（端口 8787），
     *   成败只体现在日志里；这里这一位决定 4K 频道是真 4K 还是 1080p 回退。
     */
    deviceReady: running && health.engine ? health.engine.ready === true : null,
    deviceSlots: running && health.engine && Number.isInteger(health.engine.active_device_slots)
      ? health.engine.active_device_slots
      : null,
    uptimeSec: running && Number.isFinite(health.uptime_sec) ? health.uptime_sec : null,
    urls: {
      playlist: `http://127.0.0.1:${port}/all.m3u`,
      health: `http://127.0.0.1:${port}/health`,
      diag: `http://127.0.0.1:${port}/diag`,
    },
    logFile: paths.YSP_LOG,
    dataDir: paths.YSP_DATA_DIR,
  };
}

/**
 * GET /api/ysp/status
 * @param {{force?:boolean}} [params] force=true 绕过 2s 缓存 —— 启停任务刚结束时前端必须带，
 *   否则会读到任务开始前那次轮询的旧状态（表现为「点完启动，卡片还写着未启动」）。
 */
async function status(params) {
  const force = !!(params && params.force === true);
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const value = await collectStatus();
  statusCache = { at: now, value };
  return value;
}

/**
 * GET /api/ysp/logs?lines=N
 * @param {{lines?:number}} [params]
 */
function logs(params) {
  const want = Number(params && params.lines);
  const lines = Number.isInteger(want) ? Math.min(Math.max(want, 20), 500) : 120;
  const tail = readTail(paths.YSP_LOG);
  if (!tail) {
    return { exists: false, file: paths.YSP_LOG, text: '', lines: 0, size: 0, truncated: false };
  }
  const all = stripAnsi(tail.text).split(/\r?\n/).filter((l) => l.length > 0);
  return {
    exists: true,
    file: paths.YSP_LOG,
    text: all.slice(-lines).join('\n'),
    lines: all.length,
    size: tail.size,
    truncated: tail.truncated || all.length > lines,
  };
}

export default {
  id: 'ysp',
  actions,
  queries: { status, logs },
};
