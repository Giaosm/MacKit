/**
 * MacKit · DeepSeek Harness（后端模块）
 *
 * 把 DSH 官方的三条安装命令收进任务流，宿主与插件市场是**两个互不依赖的动作**：
 *   ① npm install -g @deepseek-ai/dsh                  宿主（可反复执行，顺带就是更新）
 *   ② npm install -g pnpm                              插件市场的前置（装了插件才需要）
 *   ③ dsh plugin --profile web add dshmarket            插件市场（独立动作；装过即不再执行）
 * 启动 `dsh web` 不在本模块职责内：它是长驻服务，由用户自己在终端执行。
 *
 * 契约与其它模块一致：默认导出 ModuleDefinition { id, actions, queries }，
 * 一切子进程都走 ctx.exec（白名单 + 代理通道 + 取消信号）。
 *
 * 三条纪律（对应本项目此前的踩坑）：
 *   - 不假定 dsh 在 /opt/homebrew/bin：安装目标由 npm 全局前缀推导，dsh 用
 *     `node <prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` 兜底，
 *     nvm / fnm / 官网 pkg 装的 Node 都能跑。
 *   - 全局前缀不可写时**提前失败并给出替代方案**，绝不静默改用 sudo（与 Homebrew
 *     安装脚本那条「用户明确授权」的路径不同，npm 全局安装不该悄悄提权）。
 *   - 模块只负责「装」：不代跑 `dsh web`（长驻服务会永久占住串行任务队列），
 *     也不替用户打开 Terminal —— 装完把命令告诉用户，由他自己执行。
 */

import fs from 'node:fs';
import path from 'node:path';

import * as paths from './paths.js';

// 本文件别名：错误详情统一截尾（实现唯一在 lib/paths.js；此前这里另有一份同构实现）
const tailLines = paths.tailLines;
import * as store from './store.js';
import * as exec from './exec.js';

const { ERR, AppError } = exec;

/** npm 相关命令的通用环境：关掉更新提示 / 审计 / 进度条，避免日志噪声与非 TTY 抖动 */
const NPM_ENV = Object.freeze({
  NPM_CONFIG_UPDATE_NOTIFIER: 'false',
  NPM_CONFIG_FUND: 'false',
  NPM_CONFIG_AUDIT: 'false',
  NPM_CONFIG_PROGRESS: 'false',
  NO_COLOR: '1',
});

/** npm 全局安装超时（15 分钟；DSH 及其依赖体积不小） */
const INSTALL_TIMEOUT_MS = 900_000;
/** 插件市场超时（pnpm 在 profile 目录里装依赖） */
const MARKET_TIMEOUT_MS = 600_000;
const PROBE_TIMEOUT_MS = 30_000;
/** DSH 要求的最低 Node 主版本（低于则只告警，不阻断） */
const NODE_MIN_MAJOR = 20;

// ------------------------------ 小工具 ------------------------------
const firstLine = (res) => paths.lines(res && res.stdout)[0] || null;

/** 「失败自动换通道」开关（与 brew 模块共用 ~/.mackit/config.json 的 autoFallback）。 */
function autoFallbackEnabled() {
  try { return store.readMackit().autoFallback !== false; } catch { return true; }
}

/**
 * 只读探测：直连、不注入 brew 镜像、不抛异常。
 * @param {string} bin
 * @param {string[]} args
 * @param {import('./exec.js').RunOpts} [opts]
 */
async function probe(bin, args, opts = {}) {
  return exec.runSafe(bin, args, {
    env: NPM_ENV, noMirror: true, timeoutMs: PROBE_TIMEOUT_MS, ...opts,
  });
}

/** 目录是否可写（提前发现「npm 全局安装需要 sudo」的情况）。 */
function isWritable(dir) {
  if (!dir) return false;
  try { fs.accessSync(dir, fs.constants.W_OK); return true; } catch { return false; }
}

/**
 * npm 全局前缀（`npm prefix -g`）；命令失败时按 `<prefix>/bin/npm` 的结构反推。
 * @returns {Promise<string|null>}
 */
async function npmPrefix() {
  if (!paths.exists(paths.NPM_BIN)) return null;
  const res = await probe('npm', ['prefix', '-g']);
  if (res.code === 0) {
    const p = firstLine(res);
    if (p) return p;
  }
  return path.dirname(path.dirname(paths.NPM_BIN));
}

/**
 * dsh 的调用方式：优先 PATH 上探测到的 dsh，否则用 node 直接跑全局包入口。
 * @returns {{bin:string, argv:string[], path:string}|null}
 */
function dshInvocation(prefix) {
  if (paths.exists(paths.DSH_BIN)) return { bin: 'dsh', argv: [], path: paths.DSH_BIN };
  if (prefix) {
    const parts = paths.DSH_PACKAGE.split('/');
    const entry = path.join(prefix, 'lib', 'node_modules', ...parts, 'lib', 'bin.js');
    if (paths.exists(entry)) return { bin: 'node', argv: [entry], path: entry };
  }
  return null;
}

/**
 * pnpm 的调用方式（pnpm 12 的 bin 是原生启动器；独立安装脚本装在 ~/Library/pnpm）。
 * @returns {{bin:string, argv:string[], path:string}|null}
 */
function pnpmInvocation(prefix) {
  if (paths.exists(paths.PNPM_BIN)) return { bin: 'pnpm', argv: [], path: paths.PNPM_BIN };
  if (prefix) {
    for (const entry of ['pnpm.mjs', 'pnpm.cjs']) {
      const p = path.join(prefix, 'lib', 'node_modules', 'pnpm', 'bin', entry);
      if (paths.exists(p)) return { bin: 'node', argv: [p], path: p };
    }
  }
  return null;
}

// ------------------------------ 最新版本检查 ------------------------------
/**
 * npm registry 的 latest dist-tag 接口（scoped 包的斜杠可以原样写）。
 * 用 curl 而不是 `npm view`：后者要起一个 node 进程 + 读 npm 配置，慢一个数量级。
 */
const REGISTRY_LATEST_URL = `https://registry.npmjs.org/${paths.DSH_PACKAGE}/latest`;
const LATEST_TTL_MS = 12 * 60 * 60 * 1000;
/** 失败结果的缓存时长（1 小时）——失败也缓存，免得每次开页面都去撞一次网络 */
const LATEST_FAIL_TTL_MS = 60 * 60 * 1000;
const LATEST_CACHE_KEY = 'dsh-latest-version';

/**
 * 解析版本号（只认 semver 三段 + 可选预发布后缀）。
 * @param {string} v
 * @returns {{nums:number[], pre:string[]|null}|null}
 */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v || '').trim());
  if (!m) return null;
  return {
    nums: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : null,
  };
}

/**
 * 按 semver 语义比较两个版本号。
 *
 * 需要它（而不是简单字符串比较）的原因：预发布版本的排序是反直觉的 ——
 * `0.1.5-rc.2` **小于** `0.1.5`，所以「本地是 rc、registry 上出了正式版」必须判定为
 * 有更新；反过来本地已是更靠前的预发布时，绝不能被降级提示成「有新版本」。
 *
 * @param {string} a
 * @param {string} b
 * @returns {number|null} a>b → 1，a<b → -1，相等 → 0；任一无法解析 → null
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return null;
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1;
  }
  if (!pa.pre && !pb.pre) return 0;
  if (!pa.pre) return 1;   // 正式版 > 同号预发布
  if (!pb.pre) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1; // 段数少的更小
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) > Number(y) ? 1 : -1;
    } else if (nx !== ny) {
      return nx ? -1 : 1; // 数字标识符 < 字母标识符
    } else if (x !== y) {
      return x > y ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 查宿主包在 npm registry 上的最新版本。
 *
 * 磁盘缓存 + 失败也缓存：调用方是 30s 一次的环境体检链路，没有缓存会把 registry
 * 打成筛子；离线、被墙、返回非 JSON 一律**静默降级为 null**（更新提示属于锦上添花，
 * 绝不能让它拖垮状态查询）。
 *
 * @returns {Promise<{version:string|null, checkedAt:number, cached:boolean}>}
 */
async function latestHostVersion() {
  const cached = store.getCached(LATEST_CACHE_KEY);
  if (cached && cached.value && typeof cached.value === 'object') {
    const ttl = cached.value.version ? LATEST_TTL_MS : LATEST_FAIL_TTL_MS;
    if (Date.now() - cached.at < ttl) return { ...cached.value, cached: true };
  }
  let version = null;
  try {
    const res = await exec.runWithChannel('direct_first', '查询 DSH 最新版本', 'curl',
      ['-fsSL', '--max-time', '6', REGISTRY_LATEST_URL],
      { env: NPM_ENV, noMirror: true, timeoutMs: 20_000 });
    const obj = JSON.parse(res.stdout);
    if (obj && typeof obj.version === 'string') version = obj.version;
  } catch { /* 离线 / 超时 / 非 JSON：降级为「这次没查到」 */ }
  const value = { version, checkedAt: Date.now() };
  try { store.setCached(LATEST_CACHE_KEY, value); } catch { /* 缓存写失败不影响本次结果 */ }
  return { ...value, cached: false };
}

// ------------------------------ 只读查询 ------------------------------
/**
 * DSH 环境状态（模块页与总览体检共用，单一事实源）。
 *
 * 只读、无副作用：4 个版本探测并发跑，市场状态直接读 profile 清单（不起 pnpm）。
 * 更新检查走 latestHostVersion() 的 12h 磁盘缓存，不会每次都打 registry。
 * @returns {Promise<any>}
 */
export async function queryStatus() {
  const nodeInstalled = paths.exists(paths.NODE_BIN);
  const npmInstalled = paths.exists(paths.NPM_BIN);
  const prefix = npmInstalled ? await npmPrefix() : null;
  const dshInv = dshInvocation(prefix);
  const pnpmInv = pnpmInvocation(prefix);
  const market = paths.readDshMarketState();

  const [nodeRes, npmRes, pnpmRes, dshRes, latest] = await Promise.all([
    nodeInstalled ? probe('node', ['--version']) : null,
    npmInstalled ? probe('npm', ['--version']) : null,
    pnpmInv ? probe(pnpmInv.bin, [...pnpmInv.argv, '--version']) : null,
    dshInv ? probe(dshInv.bin, [...dshInv.argv, '--version']) : null,
    dshInv ? latestHostVersion() : null,
  ]);

  const nodeVersion = firstLine(nodeRes);
  const major = Number.parseInt(String(nodeVersion || '').replace(/^v/, ''), 10);
  const nodeMajor = Number.isFinite(major) ? major : null;

  const dshVersion = firstLine(dshRes);
  const latestVersion = latest ? latest.version : null;
  // 「有更新」= 查到了最新版 && 本地已装 && 最新版严格大于本地版
  const updateAvailable = !!(latestVersion && dshVersion
    && compareVersions(latestVersion, dshVersion) === 1);

  return {
    node: {
      installed: nodeInstalled,
      version: nodeVersion,
      path: paths.NODE_BIN,
      major: nodeMajor,
      ok: !!nodeVersion && (nodeMajor === null || nodeMajor >= NODE_MIN_MAJOR),
      minMajor: NODE_MIN_MAJOR,
    },
    npm: {
      installed: npmInstalled,
      version: firstLine(npmRes),
      path: paths.NPM_BIN,
      prefix,
      prefixWritable: prefix ? isWritable(prefix) : false,
    },
    pnpm: {
      installed: !!pnpmInv,
      version: firstLine(pnpmRes),
      path: pnpmInv ? pnpmInv.path : null,
    },
    dsh: {
      installed: !!dshInv,
      version: dshVersion,
      path: dshInv ? dshInv.path : null,
      packageName: paths.DSH_PACKAGE,
      home: paths.DSH_HOME,
      profile: paths.DSH_WEB_PROFILE_DIR,
      profileExists: paths.exists(paths.DSH_WEB_PROFILE_DIR),
      // 更新检查：latestVersion 为 null 表示「这次没查到」（离线等），而非「没有新版」
      latestVersion,
      updateAvailable,
      updateCheckedAt: latest ? latest.checkedAt : null,
    },
    market: {
      packageName: paths.DSH_MARKET_PACKAGE,
      installed: market.installed,
      version: market.version,
      declared: market.declared,
      bundled: market.bundles.includes(paths.DSH_MARKET_PACKAGE),
      bundles: market.bundles,
      manifest: market.manifest,
    },
    commands: {
      install: `npm install -g ${paths.DSH_PACKAGE}`,
      pnpm: 'npm install -g pnpm',
      market: `dsh plugin --profile ${paths.DSH_WEB_PROFILE} add ${paths.DSH_MARKET_PACKAGE}`,
    },
  };
}

// ------------------------------ 安装原语 ------------------------------
/**
 * `npm install -g <pkg>`：代理优先，按 autoFallback 决定是否直连降级。
 * @param {any} ctx 步骤上下文
 * @param {string} pkg
 * @param {string} label 面向用户的名称
 * @param {number} [timeoutMs]
 */
async function installGlobal(ctx, pkg, label, timeoutMs = INSTALL_TIMEOUT_MS) {
  // 前置复查（quiet）：单步失败不会中断后续步骤，这里必须自己再拦一次才不会被空跑。
  await requireToolchain(ctx, { quiet: true });
  const args = ['install', '-g', pkg];
  const common = {
    env: NPM_ENV,
    timeoutMs,
    onLine: (line, stream) => {
      const t = String(line || '').trim();
      if (t) ctx.log(stream === 'stderr' ? 'warn' : 'info', t);
    },
  };
  ctx.log('info', `执行：npm install -g ${pkg}`);
  if (!autoFallbackEnabled()) {
    ctx.log('info', '已关闭「自动降级」：只走代理通道');
    const res = await ctx.exec.run('npm', args, { ...common, channel: 'proxy' });
    ctx.setChannel('proxy');
    if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, `${label}安装失败`, tailLines(res.stderr) || tailLines(res.stdout));
    ctx.log('ok', `${label} 安装完成`);
    return;
  }
  const res = await ctx.exec.runWithChannel('proxy_first', `安装 ${label}`, 'npm', args, {
    ...common,
    onAttempt: (ch, phase) => {
      const name = ch === 'proxy' ? '代理' : '直连';
      if (phase === 'try') ctx.log('info', `尝试${name}安装 ${label} …`);
      else if (phase === 'ok') ctx.log('ok', `${label} 已安装（${name}）`);
      else ctx.log('warn', `${name}失败，改用另一种方式重试…`);
    },
  });
  ctx.setChannel(res.channel);
}

// ------------------------------ 步骤 ------------------------------
/**
 * 校验 Node / npm 与 npm 全局前缀可写性；不满足就抛出带替代方案的 AppError。
 *
 * ★ 每个「会写全局环境」的步骤都必须自己在开头调一次：runner 的语义是
 *   「单步失败不中断后续步骤」（brew 的批量装卸载依赖这一点），所以不能只靠
 *   第一步把关 —— 否则前置检查失败后，后面的 npm 照样会被拉起来空跑（代理通道下
 *   还会先卡到超时），日志里全是噪声。重复调用用 quiet 关掉重复日志。
 *
 * @param {any} ctx 步骤上下文
 * @param {{quiet?:boolean}} [opts]
 * @returns {Promise<string|null>} npm 全局前缀
 */
async function requireToolchain(ctx, opts = {}) {
  const quiet = opts.quiet === true;
  const say = (level, text) => { if (!quiet) ctx.log(level, text); };

  if (!paths.exists(paths.NODE_BIN)) {
    throw new AppError(ERR.ENV_MISSING, `未检测到 Node.js（DSH 需要 ${NODE_MIN_MAJOR} 或更高版本）`,
      '已装 Homebrew：brew install node；否则到 https://nodejs.org 下载安装包');
  }
  const nv = await probe('node', ['--version']);
  const nodeVersion = firstLine(nv) || '';
  say('ok', `Node.js ${nodeVersion}（${paths.NODE_BIN}）`);
  const major = Number.parseInt(nodeVersion.replace(/^v/, ''), 10);
  if (Number.isFinite(major) && major < NODE_MIN_MAJOR) {
    say('warn', `Node ${major} 低于 DSH 要求的 ${NODE_MIN_MAJOR}，建议先升级：brew upgrade node`);
  }

  if (!paths.exists(paths.NPM_BIN)) {
    throw new AppError(ERR.ENV_MISSING, `未检测到 npm（期望位置：${paths.NPM_BIN}）`,
      'Homebrew 装的 Node 自带 npm；用 nvm / fnm 的话请从终端启动 MacKit，让它继承你的 PATH');
  }
  const npmRes = await probe('npm', ['--version']);
  say('ok', npmRes.code === 0 ? `npm ${firstLine(npmRes)}` : `npm：${paths.NPM_BIN}`);

  const prefix = await npmPrefix();
  say('info', `npm 全局目录：${prefix || '未知'}`);
  if (prefix && !isWritable(prefix)) {
    throw new AppError(ERR.FORBIDDEN, `npm 全局目录当前不可写：${prefix}`,
      '请改用 Homebrew 装的 Node（brew install node）；或执行 npm config set prefix ~/.npm-global，'
      + '并把 ~/.npm-global/bin 加进 PATH 后重试');
  }
  return prefix;
}

/** 所有安装动作的第一步：Node / npm 是否可用、全局前缀是否可写。 */
function toolchainStep() {
  return {
    id: 'toolchain', title: '检查 Node.js / npm',
    run: (ctx) => requireToolchain(ctx),
  };
}

/** 「npm install -g <pkg>」步骤。 */
function npmInstallStep(pkg, label, timeoutMs = INSTALL_TIMEOUT_MS) {
  return {
    id: `install_${pkg.replace(/[^A-Za-z0-9]+/g, '_')}`,
    title: `安装 ${label}`,
        timeoutMs,
    run: (ctx) => installGlobal(ctx, pkg, label, timeoutMs),
  };
}

/** 「准备 pnpm」步骤：已装则跳过（插件市场的前置）。 */
function pnpmStep() {
  return {
    id: 'pnpm', title: '准备 pnpm（插件市场前置）',
    run: async (ctx) => {
      const inv = pnpmInvocation(await npmPrefix());
      if (inv) {
        const res = await probe(inv.bin, [...inv.argv, '--version']);
        ctx.log('ok', `已检测到 pnpm ${firstLine(res) || ''}，跳过安装`);
        return;
      }
      ctx.log('info', `未检测到 pnpm（${paths.PNPM_BIN}），开始安装…`);
      await installGlobal(ctx, 'pnpm', 'pnpm');
    },
  };
}

/** 验证 dsh 可用（安装后自检）。 */
function verifyDshStep() {
  return {
    id: 'verify_dsh', title: '验证 dsh',
    run: async (ctx) => {
      const prefix = await npmPrefix();
      const inv = dshInvocation(prefix);
      if (!inv) {
        throw new AppError(ERR.NOT_FOUND, '安装已结束但未找到 dsh 可执行文件',
          `已检查：${paths.DSH_BIN}${prefix ? ` 与 ${path.join(prefix, 'lib', 'node_modules', ...paths.DSH_PACKAGE.split('/'))}` : ''}`);
      }
      const res = await probe(inv.bin, [...inv.argv, '--version']);
      if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, 'dsh --version 执行失败', tailLines(res.stderr));
      ctx.log('ok', `DeepSeek Harness 已就绪：${firstLine(res) || ''}（${inv.path}）`);
      if (!paths.readDshMarketState().installed) {
        ctx.log('info', `提示：插件市场（${paths.DSH_MARKET_PACKAGE}）尚未安装，可在本页单独安装`);
      }
      ctx.log('info', '下一步：点「在终端启动 dsh web」，再在浏览器打开它提示的地址');
    },
  };
}

/**
 * 「安装插件市场」步骤：dsh plugin --profile web add dshmarket。
 * 该命令内部就是 `pnpm add`，pnpm 必须能被找到 → 把 npm 全局前缀的 bin 放到 PATH 最前。
 */
function marketStep() {
  return {
    id: 'market', title: `安装插件市场（${paths.DSH_MARKET_PACKAGE}）`,
        timeoutMs: MARKET_TIMEOUT_MS,
    run: async (ctx) => {
      const prefix = await npmPrefix();
      const inv = dshInvocation(prefix);
      if (!inv) throw new AppError(ERR.ENV_MISSING, '未检测到 dsh，请先安装 DeepSeek Harness', `期望位置：${paths.DSH_BIN}`);

      // dsh plugin 内部 spawn 的是裸命令 `pnpm`：先确认它确实可被找到，否则白跑一趟。
      const pnpmInv = pnpmInvocation(prefix);
      if (!pnpmInv) {
        throw new AppError(ERR.ENV_MISSING, '未检测到 pnpm（插件市场的前置）',
          `请先执行 npm install -g pnpm，或在本页点「安装 pnpm」`);
      }

      const before = paths.readDshMarketState();
      if (before.installed) {
        // 按设计不提供「再次安装 / 更新」：界面上这个按钮此时已经禁用，这里是兜底。
        // 以 SKIP 结束 → 该步骤记为「已跳过」，任务仍算成功，不会误报失败。
        ctx.log('warn', `${paths.DSH_MARKET_PACKAGE} 已安装${before.version ? `（v${before.version}）` : ''}，按设计不重复安装`);
        ctx.log('info', `如需更新，请在终端执行：dsh plugin --profile ${paths.DSH_WEB_PROFILE} add ${paths.DSH_MARKET_PACKAGE}`);
        throw new AppError('SKIP', `${paths.DSH_MARKET_PACKAGE} 已安装，跳过`);
      }

      const envPath = prefix
        ? [path.join(prefix, 'bin'), ...paths.EXEC_PATH].join(':')
        : paths.EXEC_PATH.join(':');
      const args = [...inv.argv, 'plugin', '--profile', paths.DSH_WEB_PROFILE, 'add', paths.DSH_MARKET_PACKAGE];
      const common = {
        env: { ...NPM_ENV, PATH: envPath },
        noMirror: true,
        timeoutMs: MARKET_TIMEOUT_MS,
        onLine: (line, stream) => {
          const t = String(line || '').trim();
          if (t) ctx.log(stream === 'stderr' ? 'warn' : 'info', t);
        },
      };
      ctx.log('info', `执行：dsh plugin --profile ${paths.DSH_WEB_PROFILE} add ${paths.DSH_MARKET_PACKAGE}`);

      if (!autoFallbackEnabled()) {
        ctx.log('info', '已关闭「自动降级」：只走代理通道');
        const res = await ctx.exec.run(inv.bin, args, { ...common, channel: 'proxy' });
        ctx.setChannel('proxy');
        if (res.code !== 0) throw new AppError(ERR.CMD_FAILED, '插件市场安装失败', tailLines(res.stderr) || tailLines(res.stdout));
      } else {
        const res = await ctx.exec.runWithChannel('proxy_first', '安装插件市场', inv.bin, args, {
          ...common,
          onAttempt: (ch, phase) => {
            const name = ch === 'proxy' ? '代理' : '直连';
            if (phase === 'try') ctx.log('info', `尝试${name}安装插件市场 …`);
            else if (phase === 'ok') ctx.log('ok', `插件市场安装完成（${name}）`);
            else ctx.log('warn', `${name}失败，改用另一种方式重试…`);
          },
        });
        ctx.setChannel(res.channel);
      }

      const after = paths.readDshMarketState();
      if (!after.installed) {
        throw new AppError(ERR.CMD_FAILED, `命令已结束，但 profile 里仍未检测到 ${paths.DSH_MARKET_PACKAGE}`,
          `请检查 ${after.manifest}`);
      }
      ctx.log('ok', `插件市场已就绪${after.version ? `（${paths.DSH_MARKET_PACKAGE} v${after.version}）` : ''}`);
      if (!after.bundles.includes(paths.DSH_MARKET_PACKAGE)) {
        ctx.log('warn', '插件尚未登记进 profile 的 bundles 列表，重启 dsh web 后可能仍不生效（可参考上面 pnpm 的输出）');
      }
      ctx.log('info', '启动 dsh web 后：Settings → Plugin Market');
    },
  };
}

// ------------------------------ 动作定义 ------------------------------
const actions = {
  /** 安装 / 更新宿主（可反复执行；不含插件市场，那是一个独立动作） */
  install_dsh: {
    title: '安装 / 更新 DeepSeek Harness',
    destructive: true,
    steps: () => [
      toolchainStep(),
      npmInstallStep(paths.DSH_PACKAGE, 'DeepSeek Harness'),
      verifyDshStep(),
    ],
  },

  /**
   * 安装插件市场（独立动作）。
   * 已安装时不重复执行：marketStep 会以 SKIP 结束该步骤。
   */
  add_market: {
    title: '安装插件市场',
    destructive: true,
    steps: () => [toolchainStep(), pnpmStep(), marketStep()],
  },
};

export default {
  id: 'dsh',
  actions,
  queries: { status: queryStatus },
};
