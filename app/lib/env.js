/**
 * MacKit · 环境探测层
 *
 *   - snapshot({force}) 30s 缓存，返回 EnvSnapshot（总览体检卡 / Homebrew 环境卡同源）
 *   - networkTest()：直连与代理各探一次（含出口 IP），任一可达即不算全断
 *   - Git 的读写在 lib/git.js（2026-09-18 收敛），本文件只负责把它们聚合成快照
 *   - 镜像源表（5 项）
 *
 * 附加：shell rc 的别名解析与删除范围计算
 *   analyzeRc() / computeAliasRemovalRange() / expectedAliasLines()（供 sysinit 使用）
 *   —— 移除时只删除 alias 定义块，绝不删除注释行。
 *
 * 全部探测走异步子进程（exec.js），不阻塞事件循环。brew 命令串行执行以避免抢锁。
 */

import * as paths from './paths.js';
import * as store from './store.js';
import * as exec from './exec.js';
import * as git from './git.js';
import { parseRimeAppearance } from './rime-appearance.js';

/** 快照缓存时长 */
const CACHE_TTL_MS = 30_000;
const CACHE_KEY = 'env-snapshot';

// ---------------------------------------------------------------------------
// 镜像源表
// ---------------------------------------------------------------------------

const MIRRORS = Object.freeze([
  { id: 'official', label: '官方 (GitHub)', brew: '' },
  // brew 镜像 URL 唯一来源 = exec.MIRROR_REMOTES（applyMirrorEnv 用的也是它）
  { id: 'tuna', label: '清华 TUNA', brew: exec.MIRROR_REMOTES.tuna },
  { id: 'ustc', label: '中科大 USTC', brew: exec.MIRROR_REMOTES.ustc },
  { id: 'aliyun', label: '阿里云', brew: exec.MIRROR_REMOTES.aliyun },
  { id: 'tencent', label: '腾讯云', brew: exec.MIRROR_REMOTES.tencent },
]);

/**
 * 镜像源显示名。
 * @param {string} id
 * @returns {string}
 */
function mirrorLabel(id) {
  const m = MIRRORS.find((x) => x.id === id);
  return m ? m.label : '未知';
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const readTextSafe = paths.readTextSafe;
// 本文件别名：多处 brew 快照统计使用（实现统一在 lib/paths.js）
const nonEmptyLines = paths.lines;

function normLines(text) {
  return String(text).split(/\r?\n/);
}

/**
 * 运行一条只读探测命令并吞掉异常（默认不注入 brew 镜像源）。
 * 兜底逻辑本身在 exec.runSafe（2026-09-18 收敛），这里只额外做「白名单拒绝只告警一次」：
 * 这类失败若静默吞掉，会把真 bug 伪装成「探测不到」。
 * @param {string} bin
 * @param {string[]} args
 * @param {import('./exec.js').RunOpts} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
const warnedNotAllowed = new Set();
async function runQuiet(bin, args, opts = {}) {
  // ★ 2026-09-21：brew 的读命令统一带上与 brew.js 相同的 env（常量唯一在 paths.BREW_READ_ENV）。
  //   此前这条体检路径没带 HOMEBREW_NO_AUTO_UPDATE=1，于是 brew 可能在命令执行中途自己刷新元数据：
  //   同一个「可更新 N 项」在仪表盘与 brew 视图里就会不一致，还可能去抢 index.lock。
  //   现在两条路径读的是同一份元数据快照，新鲜度只由「一键更新本体并刷新索引」驱动。
  const env = bin === 'brew' ? { env: paths.BREW_READ_ENV } : null;
  const res = await exec.runSafe(bin, args, { noMirror: true, ...env, ...opts });
  if (res.errCode === exec.ERR.CMD_NOT_ALLOWED && !warnedNotAllowed.has(bin)) {
    warnedNotAllowed.add(bin);
    console.warn(`[env] 命令不在白名单，已跳过（应改用裸命令名）：${bin}`);
  }
  return res;
}

// ---------------------------------------------------------------------------
// shell rc 别名解析
// ---------------------------------------------------------------------------

/**
 * 定位某个别名（proxy / unproxy）的定义块。
 * 块范围 = 从 `alias <name>=` 所在行，到其引号闭合的那一行（不包含相邻注释行）。
 * @param {string[]} lines
 * @param {string} name 'proxy' | 'unproxy'
 * @returns {{start:number, end:number, lines:string[]}|null}
 */
function findAliasBlock(lines, name) {
  const startRe = new RegExp('^\\s*alias\\s+' + name + '\\s*=');
  for (let i = 0; i < lines.length; i++) {
    const m = startRe.exec(lines[i]);
    if (!m) continue;

    const rest = lines[i].slice(m[0].length);
    const qi = rest.search(/['"]/);
    let end = i;
    if (qi >= 0) {
      const quote = rest[qi];
      let count = 0;
      let started = false;
      let j = i;
      for (; j < lines.length; j++) {
        const seg = j === i ? rest.slice(qi) : lines[j];
        for (let k = 0; k < seg.length; k++) {
          if (seg[k] === quote) { count += 1; started = true; }
        }
        if (started && count >= 2) break;
      }
      end = Math.min(j, lines.length - 1);
    }
    return { start: i, end, lines: lines.slice(i, end + 1) };
  }
  return null;
}

/**
 * 计算「移除别名」要删除的行范围（0-based，含首含尾）。
 * ★ 只返回 alias 定义块本身，绝不包含任何注释行或空行。
 * @param {string} text rc 文件全文
 * @param {string} name 'proxy' | 'unproxy'
 * @returns {{start:number, end:number, lines:string[]}|null}
 */
export function computeAliasRemovalRange(text, name) {
  const lines = normLines(text);
  const block = findAliasBlock(lines, name);
  if (!block) return null;
  return { start: block.start, end: block.end, lines: block.lines.slice() };
}

/**
 * 生成「将要写入」的期望别名行（单行版，端口取自当前配置）。
 * 别名语义：proxy 导出 http/https 代理并回显出口 IP；unproxy 取消这两个变量。
 * @param {number} port
 * @returns {string[]}
 */
export function expectedAliasLines(port) {
  const p = port;
  return [
    `# 代理设置（端口 ${p}）`,
    `alias proxy='export http_proxy=http://127.0.0.1:${p}; export https_proxy=http://127.0.0.1:${p}; echo "✅ 代理已开启 (${p})"; echo "🌍 当前IP信息:"; curl -s https://myip.ipip.net'`,
    `alias unproxy='unset http_proxy; unset https_proxy; echo "❌ 代理已关闭"'`,
  ];
}

/**
 * 分析 rc 文件里的 proxy/unproxy 别名现状。
 * @param {string|null} text
 * @param {number} port 当前配置端口（用于判定是否与期望一致）
 * @returns {{present:boolean, multiline:boolean, matchesExpected:boolean,
 *            existing:string[], willWrite:string[], proxyBlock:any, unproxyBlock:any, rcExists:boolean}}
 */
export function analyzeRc(text, port) {
  const willWrite = expectedAliasLines(port);
  if (text === null) {
    return {
      present: false, multiline: false, matchesExpected: false,
      existing: [], willWrite, proxyBlock: null, unproxyBlock: null, rcExists: false,
    };
  }
  const lines = normLines(text);
  const proxyBlock = findAliasBlock(lines, 'proxy');
  const unproxyBlock = findAliasBlock(lines, 'unproxy');
  const present = !!(proxyBlock || unproxyBlock);

  const multiline = !!(
    (proxyBlock && proxyBlock.end > proxyBlock.start)
    || (unproxyBlock && unproxyBlock.end > unproxyBlock.start)
  );

  const expectedProxy = willWrite[1];
  const expectedUnproxy = willWrite[2];
  const matchesExpected = !!(
    proxyBlock && unproxyBlock
    && proxyBlock.lines.length === 1 && unproxyBlock.lines.length === 1
    && proxyBlock.lines[0].trim() === expectedProxy.trim()
    && unproxyBlock.lines[0].trim() === expectedUnproxy.trim()
  );

  const existing = [];
  if (proxyBlock) existing.push(...proxyBlock.lines);
  if (unproxyBlock) existing.push(...unproxyBlock.lines);

  return {
    present, multiline, matchesExpected, existing, willWrite,
    proxyBlock, unproxyBlock, rcExists: true,
  };
}

/**
 * 检测 shell 类型与 rc 文件。
 * @returns {{kind:'zsh'|'bash'|'unknown', rcFile:string|null}}
 */
export function detectShell() {
  const sh = String(process.env.SHELL || '');
  if (sh.includes('zsh')) return { kind: 'zsh', rcFile: paths.RC_ZSH };
  if (sh.includes('bash')) return { kind: 'bash', rcFile: paths.RC_BASH };
  if (paths.exists(paths.RC_ZSH)) return { kind: 'zsh', rcFile: paths.RC_ZSH };
  if (paths.exists(paths.RC_BASH)) return { kind: 'bash', rcFile: paths.RC_BASH };
  return { kind: 'unknown', rcFile: null };
}

// ---------------------------------------------------------------------------
// 网络体检
// ---------------------------------------------------------------------------

/**
 * 解析 myip.ipip.net 返回值，尽力抽取 IP 与归属地。
 * @param {string} text
 * @returns {{ip:string|null, location:string|null}}
 */
function parseIpInfo(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return { ip: null, location: null };
  const m = t.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  const ip = m ? m[1] : null;
  let location = t;
  if (m) location = t.replace(m[0], '').replace(/^[\s：:]+/, '').trim();
  // 去掉可能的 "IP：" 前缀残留
  location = location.replace(/^IP[\s：:]*/i, '').trim();
  return { ip, location: location || null };
}

/**
 * 单通道出口 IP 探测。
 * @param {'direct'|'proxy'} channel
 * @returns {Promise<{ip:string|null, location:string|null}>}
 */
async function probeIp(channel) {
  const res = await runQuiet('curl', ['--max-time', '5', '-sSf', 'https://myip.ipip.net'], {
    channel,
    timeoutMs: 8000,
  });
  if (res.code !== 0) return { ip: null, location: null };
  return parseIpInfo(res.stdout);
}

/**
 * 网络体检：直连 + 代理。
 * 直连：curl --max-time 3 -sSf https://www.baidu.com
 * 代理：curl --max-time 5 -sSfL https://www.google.com
 * 两者全失败 → allFailed=true。
 * @returns {Promise<{direct:any, proxy:any, allFailed:boolean}>}
 */
async function networkTest() {
  /** @type {{ok:boolean, ip:string|null, location:string|null, error?:any}} */
  const direct = { ok: false, ip: null, location: null };
  /** @type {{ok:boolean, ip:string|null, location:string|null, error?:any}} */
  const proxy = { ok: false, ip: null, location: null };

  const dRes = await runQuiet(
    'curl',
    ['--max-time', '3', '-sSf', 'https://www.baidu.com'],
    { channel: 'direct', timeoutMs: 8000 }
  );
  if (dRes.code === 0) {
    direct.ok = true;
    const info = await probeIp('direct');
    direct.ip = info.ip;
    direct.location = info.location;
  } else {
    direct.error = { code: exec.ERR.NET_UNREACHABLE, message: '直连网络异常' };
  }

  const pRes = await runQuiet(
    'curl',
    ['--max-time', '5', '-sSfL', 'https://www.google.com'],
    { channel: 'proxy', timeoutMs: 10000 }
  );
  if (pRes.code === 0) {
    proxy.ok = true;
    const info = await probeIp('proxy');
    proxy.ip = info.ip;
    proxy.location = info.location;
  } else {
    proxy.error = { code: exec.ERR.NET_UNREACHABLE, message: '代理网络异常' };
  }

  return { direct, proxy, allFailed: !direct.ok && !proxy.ok };
}

// ---------------------------------------------------------------------------
// git / token（具体读写见 lib/git.js）
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 快照
// ---------------------------------------------------------------------------

/**
 * 终端是否已配置 Homebrew 环境变量：检查 ~/.zprofile / ~/.bash_profile 是否含 `brew shellenv`。
 * 用于前端提示「已装 Homebrew 但终端未配置」并提供一键配置入口（2026-09-16 新增）。
 * @returns {boolean}
 */
function readShellenvConfigured() {
  for (const f of [paths.RC_ZPROFILE, paths.RC_BASH_PROFILE]) {
    const text = paths.readTextSafe(f);
    if (text !== null && paths.SHELLENV_RE.test(text)) return true;
  }
  return false;
}

async function brewSnapshot() {
  const installed = paths.exists(paths.BREW_BIN);
  const snap = {
    status: installed ? 'ok' : 'error',
    installed,
    version: null,
    path: installed ? paths.BREW_BIN : null,
    formulaCount: 0,
    caskCount: 0,
    outdatedFormula: 0,
    outdatedCask: 0,
    tapList: [],
    tapEmpty: true,
    // 终端环境变量是否已配置（~/.zprofile 或 ~/.bash_profile 内是否含 brew shellenv）
    shellenvConfigured: readShellenvConfigured(),
    // 未配置时「一键配置环境变量」实际会写入的目标（供前端如实预览）
    shellenvRc: paths.SHELL_RC,
    shellenvRcDisplay: paths.SHELL_RC.replace(`${paths.HOME}/`, '~/'),
    shellKind: paths.SHELL_KIND,
    shellenvLine: `eval "$(${paths.BREW_PREFIX}/bin/brew shellenv ${paths.SHELL_KIND})"`,
  };
  if (!installed) return snap;

  const ver = await runQuiet('brew', ['--version'], { timeoutMs: 15_000 });
  if (ver.code === 0) snap.version = nonEmptyLines(ver.stdout)[0] || null;

  const fList = await runQuiet('brew', ['list', '--formula'], { timeoutMs: 30_000 });
  snap.formulaCount = nonEmptyLines(fList.stdout).length;

  const cList = await runQuiet('brew', ['list', '--cask'], { timeoutMs: 30_000 });
  snap.caskCount = nonEmptyLines(cList.stdout).length;

  const oF = await runQuiet('brew', ['outdated', '--formula', '--quiet'], { timeoutMs: 60_000 });
  snap.outdatedFormula = nonEmptyLines(oF.stdout).length;

  const oC = await runQuiet('brew', ['outdated', '--cask', '--greedy', '--quiet'], { timeoutMs: 60_000 });
  snap.outdatedCask = nonEmptyLines(oC.stdout).length;

  const taps = await runQuiet('brew', ['tap'], { timeoutMs: 15_000 });
  snap.tapList = nonEmptyLines(taps.stdout);
  // brew 7 下 brew tap 输出为空属正常，不视为错误
  snap.tapEmpty = snap.tapList.length === 0;

  return snap;
}

async function gitSnapshot() {
  const installed = paths.exists(paths.GIT_BIN);
  const snap = {
    status: installed ? 'ok' : 'error',
    installed,
    userName: null,
    userEmail: null,
    safeDirectory: null,
    httpProxy: null,
    httpsProxy: null,
    credentialHelper: null,
    tokenExists: false,
  };
  if (!installed) return snap;

  snap.userName = await git.config('user.name');
  snap.userEmail = await git.config('user.email');
  snap.safeDirectory = await git.config('safe.directory');
  snap.httpProxy = await git.config('http.proxy');
  snap.httpsProxy = await git.config('https.proxy');
  snap.credentialHelper = await git.config('credential.helper');
  snap.tokenExists = await git.credentialExists();
  snap.status = snap.userName ? 'ok' : 'warn';
  return snap;
}

function rimeSnapshot() {
  const dirExists = paths.exists(paths.RIME_DIR);
  const plumExists = paths.exists(paths.PLUM_DIR);
  const mainSchemaExists = paths.exists(paths.RIME_MAIN_SCHEMA);
  const squirrelDeployable = paths.exists(paths.SQUIRREL_BIN);

  // 与 rime.js 的「应用外观」预览同源（lib/rime-appearance.js，跳过注释行）
  const appearance = parseRimeAppearance(readTextSafe(paths.RIME_CUSTOM));
  const currentSkin = appearance.skin;
  const currentLayout = appearance.layout;
  const currentOrientation = appearance.orientation;

  return {
    status: (dirExists && mainSchemaExists && squirrelDeployable) ? 'ok' : 'warn',
    dirExists,
    dir: paths.RIME_DIR,
    plumExists,
    plumDir: paths.PLUM_DIR,
    mainSchemaExists,
    squirrelDeployable,
    squirrelPath: paths.SQUIRREL_BIN,
    currentSkin,
    currentLayout,
    currentOrientation,
  };
}

function shellSnapshot() {
  const { kind, rcFile } = detectShell();
  const text = rcFile ? readTextSafe(rcFile) : null;
  const cfg = store.readBrewgo();
  const analysis = analyzeRc(text, cfg.httpPort);

  let status = 'ok';
  if (kind === 'unknown') status = 'warn';
  else if (analysis.present && !analysis.matchesExpected) status = 'warn';
  else if (!analysis.present) status = 'warn';

  return {
    status,
    kind,
    rcFile,
    aliasPresent: analysis.present,
    aliasMatchesExpected: analysis.matchesExpected,
    aliasIsMultiline: analysis.multiline,
  };
}

/**
 * 生成完整环境快照（30s 缓存）。
 * @param {{force?:boolean}} [opts]
 * @returns {Promise<any>}
 */
export async function snapshot(opts = {}) {
  const force = !!opts.force;
  if (!force) {
    const cached = store.getCached(CACHE_KEY);
    // `cached.value != null` 不可省：invalidate() 用「写入 null」来作废缓存，
    // 若只判 `cached` 真值就会把那个 null 当成命中返回，导致保存配置后
    // 30s 内 /api/env 一直回 data:null（首屏「体检失败」）。
    if (cached && cached.value != null && Date.now() - cached.at < CACHE_TTL_MS) {
      return cached.value;
    }
  }
  // ★ 并发去重：一次体检要跑 5 条 brew 命令 + 4 次网络探测，而首屏多个视图会同时请求
  //   /api/env（还有 15s 一次的健康轮询与各处 refreshEnv(true)）。没有这层去重就会并行
  //   跑多轮 brew —— 与本文件「brew 命令串行以避免抢锁」的约束冲突（index.lock）。
  if (inflight) {
    // 同 generation 的构建直接复用（无论 force：新的那一轮已经在算了）。
    if (inflightGen === generation) return inflight;
    // 否则那次构建基于「配置已被改动」之前的旧数据（invalidate 提升了 generation）。
    // force 本意是「不要缓存、要新的」，把过期结果回给它就等于失效没生效；
    // 这里先等旧构建收尾（仍不并行 → 不抢 index.lock），再重新构建一次。
    await inflight.catch(() => { /* 旧构建失败无所谓，下面重建 */ });
    if (inflight) return inflight; // 等待期间又有人发起了构建
  }
  const gen = generation;
  inflightGen = gen;
  inflight = buildSnapshot(gen).finally(() => { inflight = null; });
  return inflight;
}

/** 正在构建的快照（并发去重）；generation 用于丢弃「构建期间配置已变」的过期结果。 */
let inflight = null;
/** 上面那次 inflight 构建发起时的 generation（用于判断它是否已被 invalidate 作废）。 */
let inflightGen = -1;
let generation = 0;

async function buildSnapshot(gen) {
  const cfg = store.readBrewgo();
  const mackit = store.readMackit();

  const brew = await brewSnapshot();
  const network = await networkTest();
  const gitInfo = await gitSnapshot(); // 变量名避开上方的 git 模块导入
  const rime = rimeSnapshot();
  const shell = shellSnapshot();

  const networkStatus = network.allFailed ? 'error' : ((network.direct.ok && network.proxy.ok) ? 'ok' : 'warn');

  const result = {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    nodeBin: paths.NODE_BIN,
    brew,
    network: {
      status: networkStatus,
      direct: network.direct,
      proxy: network.proxy,
      allFailed: network.allFailed,
    },
    mirror: {
      status: 'ok',
      id: cfg.mirror,
      // mirrorRaw 是文件里 MIRROR 行的原值：自定义镜像（枚举外）时 id 会回落 'official'，
      // 只回 id 会把自建源显示成官方源（误导用户以为镜像被改了）。
      raw: cfg.mirrorRaw,
      label: cfg.mirrorRaw && cfg.mirrorRaw !== cfg.mirror ? `自定义（${cfg.mirrorRaw}）` : mirrorLabel(cfg.mirror),
      isCustom: !!(cfg.mirrorRaw && cfg.mirrorRaw !== cfg.mirror),
    },
    proxyPorts: {
      status: cfg.exists ? 'ok' : 'warn',
      http: cfg.httpPort,
      socks5: cfg.socksPort,
      configPath: paths.BREWGO_CONFIG,
      hadMirrorKey: cfg.hadMirrorKey,
    },
    shell,
    git: gitInfo,
    rime,
    mackit,
    checkedAt: Date.now(),
  };

  // 构建期间配置被改过（invalidate 提升 generation）→ 结果已过期，不写缓存，
  // 让下一次请求自然重算；否则会把旧配置的快照重新喂给 30s 内的所有调用方。
  // 缓存写失败绝不能拖垮体检本身：快照是算出来的、缓存只是加速。
  // （此前未包裹：~/.mackit/cache 不可写时整个 /api/env 直接报 IO_ERROR，
  //   而 store.getCached / 其它 3 处 setCached 都是静默兜底的。）
  if (gen === generation) { try { store.setCached(CACHE_KEY, result); } catch { /* ignore */ } }
  return result;
}

/**
 * 清空环境快照缓存（并作废正在构建中的那一次，见 buildSnapshot 的 gen 校验）。
 */
/** 是否正在构建体检快照（供 server.js 决定「brew 元数据同步」的时机，避免两边抢 brew 锁）。 */
export function isBuilding() { return inflight !== null; }

export function invalidate() {
  generation += 1;
  try { store.setCached(CACHE_KEY, null); } catch { /* ignore */ }
}
