/**
 * MacKit · LibreTV（后端模块）
 *
 * 托管 LibreTV 本地影视聚合站：下载官方 Release 的 **Next.js standalone 预构建包**、
 * 解压、以子进程方式常驻，并提供启停 / 更新 / 卸载 / 状态检测。
 *
 * 为什么能这么轻（2026-11-25 调研结论，均已实测）：
 *   · 官方每个 release 附 `libretv-<版本>-standalone.tar.gz`（仅 9.0 MB）与 `SHA256SUMS`；
 *   · 包内是 Next.js standalone 产物（server.js + .next + public + node_modules），解压 48 MB；
 *   · 直接 `PASSWORD=xxx PORT=19080 HOSTNAME=127.0.0.1 node server.js` 即可，实测 82ms 起好；
 *   · 与 CPU 架构无关（x86_64 / arm64 通用），不需要 npm install、不需要 next build。
 *
 * 边界（有意为之）：
 *   · 不内置、不预置、不分发任何点播源 / 直播源 —— 只托管官方包体本身；
 *   · 默认只绑 127.0.0.1（`HOSTNAME`），局域网访问需要用户显式打开开关并在界面上看到警示；
 *   · 下载域名只有 github.com / release-assets.githubusercontent.com，走模块通道（默认代理优先）。
 *
 * 进程模型照抄央视频直播（lib/ysp.js）那套已经踩过坑的做法：
 *   pid 文件 + `ps` 核对命令行归属 + 对进程组发信号；pid 被系统复用时宁可拒绝，也不误杀。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import * as paths from './paths.js';
import * as exec from './exec.js';
import { resolvePolicy } from './netpolicy.js';

const { ERR, AppError } = exec;

/** 启动后等 /api/status 就绪的上限（实测 82ms 起好，留足冷启动余量） */
const READY_TIMEOUT_MS = 45_000;
const READY_POLL_MS = 500;
const STOP_TIMEOUT_MS = 8_000;
const PROBE_TIMEOUT_MS = 1_500;
/** 清理残留进程后，等它把监听 socket 真正交还的上限 */
const PORT_FREE_TIMEOUT_MS = 3_000;
/** 下载超时：直连 GitHub 实测只有 7KB/s，9MB 可能 20 分钟；代理下 1.3 秒 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const LOG_TAIL_BYTES = 128 * 1024;
const STATUS_CACHE_MS = 2_000;

const RELEASE_API = 'https://api.github.com/repos/LibreSpark/LibreTV/releases/latest';
/** `libretv-2.24.0-standalone.tar.gz` */
const ASSET_RE = /^libretv-(\d+(?:\.\d+)*)-standalone\.tar\.gz$/;
/** 只认纯数字版本目录名（自己解压出来的），避免把别的东西当版本 */
const VERSION_DIR_RE = /^\d+(?:\.\d+)*$/;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 版本号比较（点分段按数值，不看字符串：2.9.0 < 2.10.0）。 */
function cmpVersion(a, b) {
  const pa = String(a).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 读日志尾部（只读最后 128KB，避免大日志拖垮内存）。 */
function readTail(file) {
  try {
    const st = fs.statSync(file);
    const size = Math.min(st.size, LOG_TAIL_BYTES);
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, size, Math.max(0, st.size - size)); } finally { fs.closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
}

function stripAnsi(text) {
  // eslint-disable-next-line no-control-regex
  return String(text || '').replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
}

function tailText(lines = 20) {
  const text = stripAnsi(readTail(paths.LIBRETV_LOG));
  if (!text) return '';
  const all = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  return all.slice(-lines).join('\n');
}

// ---------------------------------------------------------------------------
// 状态（版本 / 端口 / 密码 / pid）
// ---------------------------------------------------------------------------

/**
 * 读 state.json。永远返回一个完整对象（缺字段用默认值补齐），
 * 这样调用方不需要到处写 `st && st.xxx`。
 *
 * `port` 是**配置值**（下次启动用），`livePort` 是**实际在跑的端口** —— 两者会短暂不同：
 * 运行中改端口后，进程还在旧端口上，重启才生效（`restartPending`）。
 * @returns {{version:string|null, port:number, livePort:number, password:string, lan:boolean,
 *   pid:number, startedAt:number, restartPending:boolean}}
 */
function readState() {
  const fallback = {
    version: null,
    port: paths.LIBRETV_DEFAULT_PORT,
    livePort: 0,
    password: '',
    lan: false,
    pid: 0,
    startedAt: 0,
    restartPending: false,
  };
  const asPort = (v, dft) => (Number.isInteger(v) && v > 0 && v < 65536 ? v : dft);
  try {
    const raw = JSON.parse(fs.readFileSync(paths.LIBRETV_STATE_JSON, 'utf8'));
    if (!raw || typeof raw !== 'object') return fallback;
    return {
      version: typeof raw.version === 'string' && raw.version ? raw.version : null,
      port: asPort(raw.port, fallback.port),
      livePort: asPort(raw.livePort, 0),
      password: typeof raw.password === 'string' ? raw.password : '',
      lan: raw.lan === true,
      pid: Number.isInteger(raw.pid) && raw.pid > 1 ? raw.pid : 0,
      startedAt: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
      restartPending: raw.restartPending === true,
    };
  } catch { return fallback; }
}

/**
 * 该去探测哪个端口：有 pid 且记了 livePort 就用它（运行中改过端口的情形），
 * 否则用配置端口（此时可能根本没有实例，探测是为了发现「非本应用启动的」服务）。
 */
const probePort = (st) => (st.pid && st.livePort ? st.livePort : st.port);

/** 合并写回 state.json（600）。写失败不致命：界面会如实显示「未运行」。 */
function writeState(patch) {
  const next = { ...readState(), ...patch };
  try {
    fs.mkdirSync(paths.LIBRETV_DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(paths.LIBRETV_STATE_JSON, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { fs.chmodSync(paths.LIBRETV_STATE_JSON, 0o600); } catch { /* 目录已是 0700 */ }
  } catch { /* ignore */ }
  return next;
}

/** 只在仍是同一个 pid 时清运行态，避免并发路径下抹掉别人刚写的记录。 */
function clearPid(pid) {
  const cur = readState();
  if (cur.pid && pid && cur.pid !== pid) return;
  writeState({ pid: 0, startedAt: 0, livePort: 0 });
}

// ---------------------------------------------------------------------------
// 版本目录
// ---------------------------------------------------------------------------

const versionDir = (version) => path.join(paths.LIBRETV_DIR, version);

/** 已解压的版本目录（升序）。 */
function installedVersions() {
  try {
    return fs.readdirSync(paths.LIBRETV_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory() && VERSION_DIR_RE.test(d.name))
      .map((d) => d.name)
      .sort(cmpVersion);
  } catch { return []; }
}

/** 一个版本目录是否「可运行」（server.js + .next 都在才算完整）。 */
function versionReady(version) {
  if (!version) return false;
  const dir = versionDir(version);
  return fs.existsSync(path.join(dir, 'server.js')) && fs.existsSync(path.join(dir, '.next'));
}

/** 当前该用哪个版本：优先 state 里记的（且目录完好），否则取最大的可用版本。 */
function pickVersion(st) {
  if (st.version && versionReady(st.version)) return st.version;
  const ready = installedVersions().filter(versionReady);
  return ready.length ? ready[ready.length - 1] : null;
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 端口是否可监听（仅判本机 127.0.0.1，够用：服务默认也只绑这里）。 */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

/** 从 start 起找一个空闲端口（最多试 20 个）。 */
async function pickPort(start) {
  const from = Math.max(1024, Math.min(Number(start) || paths.LIBRETV_DEFAULT_PORT, 65535));
  for (let port = from; port < from + 20 && port < 65536; port += 1) {
    if (await isPortFree(port)) return port;
  }
  throw new AppError(ERR.CMD_FAILED, `端口 ${from}~${from + 19} 全被占用，请换一个起始端口`);
}

/**
 * 等端口真正释放再继续。
 * 为什么不能只 sleep 一下：Next standalone 是主进程 + worker，SIGTERM 之后 worker 可能
 * 还占着监听 socket 几百毫秒，这时 isPortFree 会判「被占用」，于是顺延端口并持久化 ——
 * 用户只看到端口莫名其妙变了（2026-11-25 实测）。
 * @returns {Promise<boolean>} 超时仍被占 → false
 */
async function waitPortFree(port, timeoutMs = PORT_FREE_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortFree(port)) return true;
    await sleep(100);
  }
  return isPortFree(port);
}

// ---------------------------------------------------------------------------
// 探测
// ---------------------------------------------------------------------------

/**
 * 请求 `/api/status`。实测返回
 * `{ passwordRequired, verified, version, defaultSources, ... }`。
 * @returns {Promise<object|null>} 不可达 / 非 2xx / 非 JSON → null
 */
async function probeStatus(port, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data === 'object' ? data : null;
  } catch { return null; }
}

/** 取真实路径（不存在时原样返回）。`/tmp` ↔ `/private/tmp` 这类软链会让字符串比较失效。 */
function realish(p) {
  try { return fs.realpathSync(p); } catch { return p; }
}

/**
 * 核对 pid 是否真的是我们拉起的那份 LibreTV。
 *
 * 两条判据（任一成立即认）：
 *   ① `ps -o command=` 里含 `~/.mackit/libretv/`（手工用绝对路径起的情形，以及 shell 包装）；
 *   ② 该进程的 **cwd** 在 `~/.mackit/libretv/` 下（`lsof -d cwd`）。
 *
 * 为什么需要 ②（2026-11-25 实测）：Next.js standalone 的 server.js 一启动就把**进程标题**
 * 改成 `next-server (v15.5.26)`，`ps -o command=` 只剩这串，命令行里再也看不到脚本路径 ——
 * 只按 ① 判定的话，「停止」会永远认为「这不是我们拉起的进程」，接着启动又会拉起第二个实例抢端口。
 * cwd 是 server.js 自己 chdir 过去的版本目录，等价且更可靠。
 *
 * 结论：别的 next 服务（cwd 不在我们的目录里）不会被认成我们的，stop 依然不会误杀。
 */
async function checkOwner(pid) {
  const roots = [paths.LIBRETV_DIR, realish(paths.LIBRETV_DIR)];
  const under = (p) => roots.some((root) => p === root || p.startsWith(root + path.sep));

  const r = await exec.runSafe('ps', ['-o', 'command=', '-p', String(pid)], { noMirror: true, timeoutMs: 8_000 });
  if (r.code === 0 && roots.some((root) => String(r.stdout || '').includes(root))) return true;

  const w = await exec.runSafe('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { noMirror: true, timeoutMs: 8_000 });
  if (w.code !== 0) return false;
  return String(w.stdout || '').split(/\r?\n/)
    .filter((line) => line.startsWith('n'))
    .some((line) => under(realish(line.slice(1))));
}

/**
 * 归属结论的短缓存：状态页 5s 刷一次，每次都 spawn `ps` + `lsof` 两个子进程没必要。
 * 进程存活期间归属不会变，TTL 只用来兜住「pid 被系统复用」这种小概率。
 * 启停流程里用 forgetOwner() 主动失效，避免拿着旧结论做决定。
 */
let ownerCache = { pid: 0, at: 0, ours: false };
const OWNER_TTL_MS = 10_000;
const forgetOwner = () => { ownerCache = { pid: 0, at: 0, ours: false }; };

async function pidOwnedByUs(pid) {
  if (!exec.isPidAlive(pid)) return false;
  if (ownerCache.pid === pid && Date.now() - ownerCache.at < OWNER_TTL_MS) return ownerCache.ours;
  const ours = await checkOwner(pid);
  ownerCache = { pid, at: Date.now(), ours };
  return ours;
}

/** 轮询直到 /api/status 可达（或进程提前退出 / 超时）。 */
async function waitReady(ctx, pid, port) {
  const start = Date.now();
  let lastNotice = 0;
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (ctx.signal && ctx.signal.aborted) throw new AppError(ERR.CANCELLED, '任务已取消');
    const info = await probeStatus(port);
    if (info) return info;
    if (!exec.isPidAlive(pid)) {
      ctx.log('error', '进程已退出，未能监听端口');
      return null;
    }
    const waited = Date.now() - start;
    if (waited - lastNotice >= 5_000) {
      lastNotice = waited;
      ctx.log('info', `仍在等待 http://127.0.0.1:${port} 就绪（${Math.round(waited / 1000)}s）…`);
    }
    await sleep(READY_POLL_MS);
  }
  return null;
}

// ---------------------------------------------------------------------------
// 网络
// ---------------------------------------------------------------------------

/**
 * 通道策略：显式参数优先，否则按模块档位；auto 档下按「代理优先」
 * （GitHub 直连实测 7KB/s，代理 1.4MB/s，差 200 倍）。
 */
const netPolicy = (p) => {
  const explicit = { direct: 'direct_first', proxy: 'proxy_first' }[String((p && p.channel) || '')];
  return explicit || resolvePolicy('proxy_first');
};

async function runNet(ctx, desc, args, extra = {}) {
  const res = await ctx.exec.runWithChannel(netPolicy(ctx.params), desc, 'curl', args, {
    timeoutMs: DOWNLOAD_TIMEOUT_MS,
    onLine: (line, stream) => { if (line.trim()) ctx.log(stream === 'stderr' ? 'warn' : 'info', line); },
    ...extra,
  });
  ctx.setChannel(res.channel);
  return res;
}

/**
 * 查最新 release：版本号 + standalone 包地址 + SHA256SUMS 地址。
 * @returns {Promise<{version:string, asset:{name:string,url:string,size:number}, sumsUrl:string|null, publishedAt:string|null}>}
 */
async function fetchLatestRelease(ctx) {
  const res = await runNet(ctx, '查询 LibreTV 最新版本',
    ['-fsSL', '--max-time', '60', '-H', 'Accept: application/vnd.github+json', RELEASE_API],
    { timeoutMs: 90_000 });
  if (res.code !== 0) {
    throw new AppError(ERR.NET_UNREACHABLE, '查询最新版本失败', paths.tailLines(res.stderr || res.stdout));
  }
  let data;
  try { data = JSON.parse(res.stdout); }
  catch { throw new AppError(ERR.PARSE_FAILED, 'GitHub 返回的内容不是 JSON（可能被代理拦截）', paths.tailLines(res.stdout)); }
  const version = String(data.tag_name || '').replace(/^v/i, '');
  const asset = (data.assets || []).find((a) => a && ASSET_RE.test(String(a.name || '')));
  if (!version || !asset) {
    throw new AppError(ERR.PARSE_FAILED, '未能在 release 中找到 standalone 包',
      `tag=${data.tag_name || '?'}，资产：${(data.assets || []).map((a) => a.name).join(', ') || '(无)'}`);
  }
  const sums = (data.assets || []).find((a) => a && a.name === 'SHA256SUMS');
  return {
    version,
    asset: { name: asset.name, url: asset.browser_download_url, size: Number(asset.size) || 0 },
    sumsUrl: sums ? sums.browser_download_url : null,
    publishedAt: data.published_at || null,
  };
}

/** 从 SHA256SUMS 文本里取某个文件的期望哈希。 */
function findExpectedHash(sumsText, fileName) {
  for (const line of String(sumsText || '').split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return null;
}

/**
 * 下载 + 校验 + 解压到 `~/.mackit/libretv/<版本>/`。
 * 包内**没有顶层目录**（实测：`./server.js`、`./.next/`…），所以必须先把目标目录建好。
 * @returns {Promise<string>} 版本号
 */
async function prepareVersion(ctx, rel) {
  const version = rel.version;
  const target = versionDir(version);
  if (versionReady(version)) {
    ctx.log('info', `v${version} 已存在，跳过下载`);
    return version;
  }
  const tmp = path.join(os.tmpdir(), `mackit-libretv-${version}-${Date.now()}.tar.gz`);
  try {
    ctx.log('info', `下载 ${rel.asset.name}（${(rel.asset.size / 1024 / 1024).toFixed(1)} MB）…`);
    const dl = await runNet(ctx, '下载 LibreTV 包',
      ['-fsSL', '--retry', '2', '--max-time', '1800', '-o', tmp, rel.asset.url]);
    if (dl.code !== 0) {
      throw new AppError(ERR.NET_UNREACHABLE, `下载失败（curl 退出码 ${dl.code}）`,
        'GitHub 直连很慢时请把模块通道切成「优先代理」再重试');
    }
    const size = (() => { try { return fs.statSync(tmp).size; } catch { return 0; } })();
    if (!size) throw new AppError(ERR.IO_ERROR, '下载得到的文件为空', tmp);
    ctx.log('ok', `已下载 ${(size / 1024 / 1024).toFixed(1)} MB`);

    // 校验：有 SHA256SUMS 就一定用；拿不到（网络问题）只告警不中断 —— 但也明确告诉用户
    if (rel.sumsUrl) {
      const sumsRes = await runNet(ctx, '获取校验和', ['-fsSL', '--max-time', '60', rel.sumsUrl], { timeoutMs: 90_000 });
      const expected = sumsRes.code === 0 ? findExpectedHash(sumsRes.stdout, rel.asset.name) : null;
      if (!expected) {
        ctx.log('warn', '未能从 SHA256SUMS 中取到校验值，跳过完整性校验');
      } else {
        const actual = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
        if (actual !== expected) {
          throw new AppError(ERR.PARSE_FAILED, 'SHA256 校验失败，包可能被篡改或下载不完整',
            `期望 ${expected}\n实际 ${actual}`);
        }
        ctx.log('ok', 'SHA256 校验通过');
      }
    }

    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const ex = await exec.runSafe('tar', ['-xzf', tmp, '-C', target], { noMirror: true, timeoutMs: 180_000 });
    if (ex.code !== 0) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new AppError(ERR.CMD_FAILED, `解压失败（tar 退出码 ${ex.code}）`, paths.tailLines(ex.stderr));
    }
    if (!versionReady(version)) {
      try { fs.rmSync(target, { recursive: true, force: true }); } catch { /* ignore */ }
      throw new AppError(ERR.PARSE_FAILED, '解压结果不完整（缺少 server.js 或 .next）', target);
    }
    ctx.log('ok', `已解压到 ${target}`);
    return version;
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// 内部启停（steps 与 update 的回滚共用）
// ---------------------------------------------------------------------------

function genPassword() {
  // 去掉容易看错的 0/O/1/l/I
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(14);
  let out = '';
  for (let i = 0; i < 14; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/**
 * 启动（内部实现）。已在运行会抛 SKIP；端口被占则自动顺延并持久化。
 * @param {object} ctx
 * @param {string} version
 * @returns {Promise<{port:number, info:object}>}
 */
async function startVersion(ctx, version) {
  const dir = versionDir(version);
  if (!versionReady(version)) {
    throw new AppError(ERR.ENV_MISSING, `v${version} 的文件不完整`, `请重新安装（缺 server.js 或 .next）：${dir}`);
  }
  const st = readState();
  const prevOurs = st.pid ? await pidOwnedByUs(st.pid) : false;
  const prevPort = probePort(st);
  if (prevOurs && await probeStatus(prevPort)) {
    throw new AppError(ERR.SKIP, `服务已在运行（端口 ${prevPort}）`);
  }
  if (prevOurs) {
    // 有 pid 但探测不到 —— 半死状态，先收掉再起，避免留下僵尸占端口
    ctx.log('warn', `发现残留进程（pid ${st.pid}）无响应，先清理`);
    exec.killPid(st.pid, 'SIGTERM');
    forgetOwner();
    await waitPortFree(prevPort);
    clearPid(st.pid);
  }

  const want = st.port || paths.LIBRETV_DEFAULT_PORT;
  const port = (await isPortFree(want)) ? want : await pickPort(want + 1);
  if (port !== want) ctx.log('warn', `端口 ${want} 被占用，改用 ${port}`);

  const password = st.password || genPassword();
  const host = st.lan ? '0.0.0.0' : '127.0.0.1';
  fs.mkdirSync(paths.LIBRETV_DIR, { recursive: true, mode: 0o700 });

  const nodeBin = paths.NODE_BIN;
  if (!fs.existsSync(nodeBin)) {
    throw new AppError(ERR.ENV_MISSING, '未找到 node', `期望路径：${nodeBin}`);
  }

  // ★ 传**绝对路径**而不是裸 `server.js`：pidOwnedByUs 靠 `ps -o command=` 里是否含
  //   `~/.mackit/libretv/` 来认自己拉起的进程，而裸文件名不会出现在命令行里（只有 cwd 变），
  //   那样 stop 会永远认不出自己的进程（2026-11-25 实测踩到）。Next standalone 的 server.js
  //   自身会 `process.chdir(__dirname)`，用绝对路径启动不影响它找 .next / public。
  const pid = exec.spawnDetached('node', [path.join(dir, 'server.js')], {
    cwd: dir,
    outFile: paths.LIBRETV_LOG,
    env: { PORT: String(port), HOSTNAME: host, PASSWORD: password, NODE_ENV: 'production' },
  });
  if (!pid) throw new AppError(ERR.CMD_FAILED, '未能拉起 LibreTV 进程', `请查看日志：${paths.LIBRETV_LOG}`);
  forgetOwner();

  // port 是配置值，livePort 是这一份实例真正监听的端口；restartPending 到这里就算消费掉了
  writeState({ version, port, livePort: port, password, lan: st.lan, pid, startedAt: Date.now(), restartPending: false });
  ctx.log('info', `已拉起进程（pid ${pid}，v${version}），等待 http://127.0.0.1:${port} 就绪…`);

  const info = await waitReady(ctx, pid, port);
  if (!info) {
    exec.killPid(pid, 'SIGTERM');
    clearPid(pid);
    throw new AppError(ERR.CMD_FAILED, '启动失败：端口未就绪', tailText(20) || '日志为空');
  }
  ctx.log('ok', `LibreTV v${info.version || version} 已就绪：http://127.0.0.1:${port}`);
  ctx.log('info', `访问密码：${password}（也可在页面「访问密码」一栏查看 / 复制）`);
  if (st.lan) ctx.log('warn', `已允许局域网访问：同网段设备可用 http://<本机IP>:${port} 打开`);
  return { port, info };
}

/** 停止（内部实现）。未运行时抛 SKIP。 */
async function stopVersion(ctx) {
  const st = readState();
  const pid = st.pid;
  const ours = pid ? await pidOwnedByUs(pid) : false;
  if (!ours) {
    if (pid && exec.isPidAlive(pid)) {
      ctx.log('warn', `记录的 pid ${pid} 已不是 LibreTV（可能被系统复用），不发任何信号，仅清理记录`);
    }
    clearPid(pid);
    const port = probePort(st);
    if (await probeStatus(port)) {
      ctx.log('warn', `端口 ${port} 上仍有服务响应，但不是 MacKit 启动的，不做处理`);
      throw new AppError(ERR.SKIP, `端口 ${port} 上的实例不是 MacKit 启动的`);
    }
    throw new AppError(ERR.SKIP, '服务未在运行');
  }

  const uptime = st.startedAt ? `，已运行 ${Math.round((Date.now() - st.startedAt) / 1000)}s` : '';
  ctx.log('info', `正在停止（pid ${pid}${uptime}）…`);
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
    throw new AppError(ERR.CMD_FAILED, '停止失败：进程仍在运行', `请手动结束 pid ${pid}`);
  }
  forgetOwner();
  clearPid(pid);
  ctx.log('ok', '服务已停止');
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 安装步骤组（install 与 update 共用）。 */
function prepareSteps(slot) {
  return [
    {
      id: 'resolve', title: '查询最新版本',
      run: async (ctx) => {
        slot.rel = await fetchLatestRelease(ctx);
        ctx.log('ok', `最新版本 v${slot.rel.version}${slot.rel.publishedAt ? `（${String(slot.rel.publishedAt).slice(0, 10)}）` : ''}`);
        const cur = pickVersion(readState());
        if (cur) ctx.log('info', `当前已安装：v${cur}`);
      },
    },
    {
      id: 'fetch', title: '下载并解压',
      run: async (ctx) => {
        slot.version = await prepareVersion(ctx, slot.rel);
      },
    },
  ];
}

const actions = {
  install: {
    title: '安装 LibreTV',
    destructive: false,
    steps: () => {
      /** @type {{rel?:object, version?:string}} */
      const slot = {};
      return [
        ...prepareSteps(slot),
        {
          id: 'record', title: '记录安装版本',
          run: async (ctx) => {
            const st = readState();
            writeState({ version: slot.version, password: st.password || genPassword() });
            ctx.log('ok', `已安装 LibreTV v${slot.version}`);
            ctx.log('info', '下一步点「启动」即可；首次启动会自动分配端口并生成访问密码');
          },
        },
      ];
    },
  },

  start: {
    title: '启动 LibreTV',
    destructive: false,
    steps: () => [{
      id: 'start', title: '启动 LibreTV',
      run: async (ctx) => {
        const version = pickVersion(readState());
        if (!version) {
          throw new AppError(ERR.ENV_MISSING, '尚未安装 LibreTV', '请先点「安装」下载官方包');
        }
        await startVersion(ctx, version);
      },
    }],
  },

  stop: {
    title: '停止 LibreTV',
    destructive: false,
    steps: () => [{ id: 'stop', title: '停止 LibreTV', run: async (ctx) => { await stopVersion(ctx); } }],
  },

  restart: {
    title: '重启 LibreTV',
    destructive: false,
    steps: () => [
      { id: 'stop', title: '停止 LibreTV', run: async (ctx) => { await stopVersion(ctx); } },
      {
        id: 'start', title: '启动 LibreTV',
        run: async (ctx) => {
          const version = pickVersion(readState());
          if (!version) throw new AppError(ERR.ENV_MISSING, '尚未安装 LibreTV', '请先点「安装」');
          await startVersion(ctx, version);
        },
      },
    ],
  },

  update: {
    title: '更新 LibreTV',
    destructive: false,
    steps: () => {
      /** @type {{rel?:object, version?:string}} */
      const slot = {};
      return [
        ...prepareSteps(slot),
        {
          id: 'switch', title: '切换到新版本',
          run: async (ctx) => {
            const prev = readState();
            const prevVersion = pickVersion(prev);
            const wasRunning = prev.pid ? await pidOwnedByUs(prev.pid) : false;
            // <= 0：上游不比本地新就不动。用 === 0 的话，本地版本比上游新时会被「降级」过去
            if (prevVersion && cmpVersion(slot.version, prevVersion) <= 0 && versionReady(slot.version)) {
              ctx.log('info', `已是最新版本 v${slot.version}，无需切换`);
              if (!wasRunning) {
                ctx.log('info', '顺带启动服务');
                await startVersion(ctx, slot.version);
              }
              return;
            }
            if (wasRunning) {
              await stopVersion(ctx).catch((err) => {
                if (err instanceof AppError && err.code === ERR.SKIP) return;
                throw err;
              });
            }
            try {
              await startVersion(ctx, slot.version);
            } catch (err) {
              // 回滚：新版本起不来就退回旧版本继续跑，别让用户落到「更新完服务不可用」
              if (prevVersion && versionReady(prevVersion)) {
                ctx.log('warn', `新版本启动失败，回滚到 v${prevVersion}`);
                await startVersion(ctx, prevVersion).catch(() => {
                  ctx.log('error', `回滚也失败了，请查看日志：${paths.LIBRETV_LOG}`);
                });
              }
              throw err;
            }
            writeState({ version: slot.version });
            // 切换成功后清理旧版本目录（只留当前这一份，避免每次更新堆 48MB）
            for (const v of installedVersions()) {
              if (v === slot.version) continue;
              try {
                fs.rmSync(versionDir(v), { recursive: true, force: true });
                ctx.log('info', `已清理旧版本 v${v}`);
              } catch { /* 删不掉不影响使用 */ }
            }
          },
        },
      ];
    },
  },

  uninstall: {
    title: '卸载 LibreTV',
    destructive: true,
    steps: () => [
      {
        id: 'stop', title: '停止服务',
        run: async (ctx) => {
          // 未在运行时抛 SKIP → runner 记为跳过，不中断后续删除
          await stopVersion(ctx);
        },
      },
      {
        id: 'purge', title: '删除程序与状态',
        run: async (ctx) => {
          try { fs.rmSync(paths.LIBRETV_DIR, { recursive: true, force: true }); }
          catch (err) {
            throw new AppError(ERR.IO_ERROR, '删除目录失败', `${paths.LIBRETV_DIR}\n${err && err.message}`);
          }
          ctx.log('ok', `已删除 ${paths.LIBRETV_DIR}`);
          ctx.log('info', '浏览器里的观看历史存在本地 IndexedDB，不受影响');
        },
      },
    ],
  },

  configure: {
    title: '修改 LibreTV 配置',
    destructive: false,
    steps: (params) => [{
      id: 'config', title: '写入配置',
      run: async (ctx) => {
        const st = readState();
        const patch = {};
        if (params && params.password !== undefined) {
          const pw = String(params.password || '');
          if (pw.length > 0 && pw.length < 6) {
            throw new AppError(ERR.PARSE_FAILED, '访问密码至少 6 位');
          }
          patch.password = pw || genPassword();
          ctx.log('ok', pw ? '访问密码已更新' : `已重置为随机密码：${patch.password}`);
        }
        if (params && params.port !== undefined && params.port !== null && params.port !== '') {
          const port = Number(params.port);
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new AppError(ERR.PARSE_FAILED, '端口需为 1024~65535 的整数');
          }
          patch.port = port;
          ctx.log('ok', `端口已设为 ${port}`);
        }
        if (params && params.lan !== undefined) {
          patch.lan = !!params.lan;
          ctx.log('ok', patch.lan ? '已允许局域网访问（注意：同网段设备都能打开）' : '已限制为仅本机访问');
        }
        if (Object.keys(patch).length === 0) {
          ctx.log('warn', '没有需要修改的项');
          return;
        }
        // 运行中改配置：进程还跑在旧端口 / 旧密码上，打个标记让状态页如实说明，
        // 否则界面会把「新端口、新密码」当成正在生效的值（复制过去必然登录失败）
        const running = st.pid ? await pidOwnedByUs(st.pid) : false;
        if (running) {
          patch.restartPending = true;
          // 只报真正改了的项，别在只改密码时说「端口变更」
          const changed = [];
          if (patch.port !== undefined && patch.port !== st.port) changed.push(`端口 ${patch.port}`);
          if (patch.password !== undefined) changed.push('访问密码');
          if (patch.lan !== undefined) changed.push('监听地址');
          ctx.log('warn', `${changed.join('、') || '设置'}已保存；当前实例仍在端口 ${probePort(st)} 上按旧配置运行，点「重启」后生效（几秒，播放中的页面刷新一下即可）`);
        }
        writeState(patch);
      },
    }],
  },

  open: {
    title: '在浏览器打开',
    destructive: false,
    steps: () => [{
      id: 'open', title: '打开站点',
      run: async (ctx) => {
        const st = readState();
        const port = probePort(st);
        if (!await probeStatus(port)) {
          throw new AppError(ERR.NOT_FOUND, `服务未在运行（端口 ${port} 无响应）`, '请先点「启动」');
        }
        const url = `http://127.0.0.1:${port}/`;
        const res = await exec.runSafe(paths.OPEN_BIN, [url], { noMirror: true, timeoutMs: 15_000 });
        if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, '打开浏览器失败', paths.tailLines(res.stderr));
        ctx.log('ok', `已在浏览器打开 ${url}`);
      },
    }],
  },
};

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

let statusCache = { at: 0, value: null };

async function collectStatus() {
  const st = readState();
  const installed = installedVersions();
  const version = pickVersion(st);
  const alive = st.pid ? exec.isPidAlive(st.pid) : false;
  const ours = alive ? await pidOwnedByUs(st.pid) : false;
  const info = await probeStatus(probePort(st));
  const running = !!info;
  // 实际能访问的端口：跑着就是 livePort，没跑就是配置里的端口
  const urlPort = running ? probePort(st) : st.port;
  return {
    installed: !!version,
    installedVersions: installed,
    version,
    dir: version ? versionDir(version) : null,
    /** 目录里的版本与 state 记录不一致（手工动过目录）时前端应提示重新启动 */
    versionMismatch: !!(version && st.version && version !== st.version),
    /** 配置端口（下次启动用）；运行中改过端口时它与 livePort 不同 */
    port: st.port,
    /** 这次实例实际监听的端口（没在跑 → 0） */
    livePort: running ? probePort(st) : 0,
    /** 配置改过但还没重启：界面要明确提示「重启后生效」 */
    restartPending: running && st.restartPending,
    password: st.password,
    lan: st.lan,
    running,
    /** 是 MacKit 拉起的实例（可以停） */
    managed: running && ours,
    /** 端口有响应但 pid 不是我们的（用户手动跑的 / 别的工具）→ 只能提示 */
    foreign: running && !ours,
    pid: ours ? st.pid : null,
    startedAt: ours ? st.startedAt : 0,
    serverVersion: running ? (info.version || null) : null,
    passwordRequired: running ? info.passwordRequired === true : null,
    url: `http://127.0.0.1:${urlPort}/`,
    /** 局域网模式下的可用地址（只给本机第一个物理网卡） */
    lanUrl: st.lan ? `http://${firstLanIp()}:${urlPort}/` : null,
    logFile: paths.LIBRETV_LOG,
    stateFile: paths.LIBRETV_STATE_JSON,
    defaultPort: paths.LIBRETV_DEFAULT_PORT,
    node: { bin: paths.NODE_BIN, exists: fs.existsSync(paths.NODE_BIN) },
  };
}

/** 第一个物理网卡 IPv4（局域网地址用；取不到返回 127.0.0.1）。 */
function firstLanIp() {
  let ifaces = {};
  try { ifaces = os.networkInterfaces(); } catch { return '127.0.0.1'; }
  for (const [name, list] of Object.entries(ifaces)) {
    if (/^(utun|awdl|llw|gif|stf|anpi|bridge)/i.test(name)) continue;
    for (const item of list || []) {
      const family = typeof item.family === 'string' ? item.family : `IPv${item.family}`;
      if (family === 'IPv4' && !item.internal && !item.address.startsWith('169.254.')) return item.address;
    }
  }
  return '127.0.0.1';
}

/**
 * GET /api/libretv/status
 * @param {{force?:boolean}} [params] force 绕过 2s 缓存（启停任务刚结束时前端必须带）
 */
async function status(params) {
  const force = !!(params && params.force === true);
  const now = Date.now();
  if (!force && statusCache.value && now - statusCache.at < STATUS_CACHE_MS) return statusCache.value;
  const value = await collectStatus();
  statusCache = { at: now, value };
  return value;
}

/** GET /api/libretv/latest —— 上游最新版本（与本地对比）。 */
async function latest(params) {
  const st = readState();
  const version = pickVersion(st);
  const ctx = {
    params: params || {},
    log: () => {},
    setChannel: () => {},
    exec,
  };
  try {
    const rel = await fetchLatestRelease(ctx);
    return {
      version: rel.version,
      publishedAt: rel.publishedAt,
      size: rel.asset.size,
      upToDate: version ? cmpVersion(rel.version, version) <= 0 : null,
      localVersion: version,
      error: null,
      checkedAt: Date.now(),
    };
  } catch (err) {
    return {
      version: null,
      publishedAt: null,
      size: null,
      upToDate: null,
      localVersion: version,
      error: err instanceof AppError ? (err.detail || err.message) : String(err && err.message),
      checkedAt: Date.now(),
    };
  }
}

/** GET /api/libretv/logs?lines=N */
function logs(params) {
  const want = Number(params && params.lines);
  const lines = Number.isInteger(want) ? Math.min(Math.max(want, 20), 500) : 120;
  const text = stripAnsi(readTail(paths.LIBRETV_LOG));
  if (!text) return { exists: false, file: paths.LIBRETV_LOG, text: '' };
  const all = text.split(/\r?\n/).filter((l) => l.length > 0);
  return { exists: true, file: paths.LIBRETV_LOG, text: all.slice(-lines).join('\n') };
}

export default {
  id: 'libretv',
  actions,
  queries: { status, latest, logs },
};
