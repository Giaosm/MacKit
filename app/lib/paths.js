/**
 * MacKit · 路径常量唯一来源
 *
 * 全项目的文件/可执行文件路径必须在此定义，
 * 任何其他文件不得自行拼接这些路径。
 *
 * 纪律：本文件只使用 node:fs / node:path / node:os，不引入 child_process
 * （唯一子进程出口是 lib/exec.js）。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 应用目录（基于本文件位置推导，兼容任何安装路径）
// ---------------------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** app/ 根目录 */
export const APP_DIR = path.resolve(__dirname, '..');
/** app/web/ */
export const WEB_DIR = path.join(APP_DIR, 'web');

// ---------------------------------------------------------------------------
// 用户家目录与 ~/.mackit 数据目录
// ---------------------------------------------------------------------------
export const HOME = os.homedir();
/**
 * `~/.mackit`（MacKit 数据根目录）。
 * 需要导出而不是各自拼串：启动器 MacKit.command 也把服务日志写成 `$MACKIT_DIR/server.out`，
 * server.js 的「重启服务」必须续写到同一个文件（2026-09-21 实测：漏了 export 导致
 * `path.join(undefined, ...)` 抛错，重启静默失败）。
 */
export const MACKIT_DIR = path.join(HOME, '.mackit');
/** ~/.mackit/config.json（MacKit 专属配置） */
export const CONFIG_JSON = path.join(MACKIT_DIR, 'config.json');
/** ~/.mackit/runtime.json（运行态：port/pid/startedAt） */
export const RUNTIME_JSON = path.join(MACKIT_DIR, 'runtime.json');
/** ~/.mackit/logs/（每任务一份 <taskId>.log） */
export const LOGS_DIR = path.join(MACKIT_DIR, 'logs');
/** ~/.mackit/history/（每任务一份 <taskId>.json） */
export const HISTORY_DIR = path.join(MACKIT_DIR, 'history');
/** ~/.mackit/cache/（环境探测缓存等） */
export const CACHE_DIR = path.join(MACKIT_DIR, 'cache');
/** ~/.mackit/webdav.json（WebDAV 备份凭据，明文 + 权限 600；独立于 config.json） */
export const WEBDAV_JSON = path.join(MACKIT_DIR, 'webdav.json');

// ---------------------------------------------------------------------------
// 配置事实源（格式不变）
// ---------------------------------------------------------------------------
/** ~/.brewgo_config ← 代理端口 / 镜像源唯一事实源 */
export const BREWGO_CONFIG = path.join(HOME, '.brewgo_config');

// ---------------------------------------------------------------------------
// shell rc 文件
// ---------------------------------------------------------------------------
/** ~/.zshrc */
export const RC_ZSH = path.join(HOME, '.zshrc');
/** ~/.bashrc */
export const RC_BASH = path.join(HOME, '.bashrc');
/** ~/.zprofile（brew shellenv 官方推荐写入位置，zsh 登录 shell 生效） */
export const RC_ZPROFILE = path.join(HOME, '.zprofile');
/** ~/.bash_profile（bash 登录 shell） */
export const RC_BASH_PROFILE = path.join(HOME, '.bash_profile');
/** 当前登录 shell 类别（zsh | bash），决定 brew shellenv 写入哪个 rc 文件 */
export const SHELL_KIND = String(process.env.SHELL || '').includes('bash') ? 'bash' : 'zsh';
/** 与 SHELL_KIND 对应的登录 rc 文件（zsh → ~/.zprofile，bash → ~/.bash_profile） */
export const SHELL_RC = SHELL_KIND === 'bash' ? RC_BASH_PROFILE : RC_ZPROFILE;
/**
 * 判定一段 rc 文本是否已写入 brew 环境变量。
 * env.js（环境体检：查 zprofile / bash_profile 两份）与 brew.js（幂等写入：只查将要写的那份）
 * 共用同一标记，避免两处正则各自漂移。
 *
 * ★ 2026-09-21 修：此前是裸 `/brew\s+shellenv/`，会命中**被注释掉**的行
 *   （用户自己 `# eval "$(brew shellenv)"` 关掉过配置）→ env.js 误报「已配置」、
 *   brew.js 误判幂等而跳过写入，配置永远修不回来。现在要求该行不是注释行（m 标志逐行判定）。
 */
export const SHELLENV_RE = /^(?!\s*#).*brew\s+shellenv/m;

/**
 * brew **只读命令**的统一环境（跨模块共享，避免两处各写一份而漂移）。
 *
 * `HOMEBREW_NO_AUTO_UPDATE=1` 的两条理由（2026-09-21 收敛到这一处）：
 *   ① 禁止 brew 在读命令里隐式执行 `brew update` —— 否则会与「更新 Homebrew 本体」/ 升级任务
 *      抢 `index.lock`（这正是当初给只读命令加它的原因）；
 *   ② 更重要的语义：**「可更新」列表只在用户显式刷新后才变**。若一条路径允许隐式刷新、另一条
 *      不允许，同一个数字在「环境体检」与「brew 视图」里就会不一致（实测两条路径原本确实不同口径）。
 * 元数据的新鲜度因此只由 actions.brew_update（一键更新本体并刷新索引）这一个入口驱动。
 */
export const BREW_READ_ENV = Object.freeze({ HOMEBREW_NO_AUTO_UPDATE: '1', HOMEBREW_NO_ENV_HINTS: '1' });

// ---------------------------------------------------------------------------
// Rime 输入法
// ---------------------------------------------------------------------------
/** ~/Library/Rime */
export const RIME_DIR = path.join(HOME, 'Library', 'Rime');
/** ~/Library/Rime/squirrel.custom.yaml（外观 patch 写入目标） */
export const RIME_CUSTOM = path.join(RIME_DIR, 'squirrel.custom.yaml');
/** ~/Library/Rime/squirrel.yaml（22 款皮肤的定义来源） */
export const RIME_SQUIRREL = path.join(RIME_DIR, 'squirrel.yaml');
/** ~/Library/Rime/build/squirrel.yaml（解析兜底来源） */
export const RIME_BUILD_SQUIRREL = path.join(RIME_DIR, 'build', 'squirrel.yaml');
/** ~/Library/Rime/rime_ice.schema.yaml（主方案存在性判定） */
export const RIME_MAIN_SCHEMA = path.join(RIME_DIR, 'rime_ice.schema.yaml');
/** ~/Library/Rime/rime_ice.dict.yaml（词库版本号所在，version: "YYYY-MM-DD"） */
export const RIME_MAIN_DICT = path.join(RIME_DIR, 'rime_ice.dict.yaml');
/** 分片词库目录（词库内容的真正所在地，上游日常更新都改这里而非主 dict 文件） */
export const RIME_CN_DICTS = path.join(RIME_DIR, 'cn_dicts');
/** 英文分片词库目录（上游 2026-09-14 的词库提交都在这里，必须一并纳入检测） */
export const RIME_EN_DICTS = path.join(RIME_DIR, 'en_dicts');
/** ~/Library/Rime/build/default.yaml（部署后的编译结果，schema_list = 当前生效方案） */
export const RIME_BUILD_DEFAULT = path.join(RIME_DIR, 'build', 'default.yaml');
/** ~/Library/Rime/default.custom.yaml（当前生效方案的 patch 读取源之一） */
export const RIME_DEFAULT_CUSTOM = path.join(RIME_DIR, 'default.custom.yaml');
/** ~/plum（雾凇词库安装器；已存在则 git pull） */
export const PLUM_DIR = path.join(HOME, 'plum');
/** Squirrel 可执行文件（重部署 --reload 用） */
export const SQUIRREL_BIN = '/Library/Input Methods/Squirrel.app/Contents/MacOS/Squirrel';

// ---------------------------------------------------------------------------
// DeepSeek Harness（dsh）
// ---------------------------------------------------------------------------
/** DSH 宿主包名（npm install -g @deepseek-ai/dsh） */
export const DSH_PACKAGE = '@deepseek-ai/dsh';
/** 插件市场包名（dsh plugin --profile web add dshmarket） */
export const DSH_MARKET_PACKAGE = 'dshmarket';
/** DSH 主 profile 名（dsh web 用的就是它） */
export const DSH_WEB_PROFILE = 'web';
/** DSH_HOME：环境变量可覆盖，默认 ~/.dsh（dsh 自身就是这么定的） */
export const DSH_HOME = (() => {
  const fromEnv = String(process.env.DSH_HOME || '').trim();
  return fromEnv !== '' ? fromEnv : path.join(HOME, '.dsh');
})();
/** <DSH_HOME>/profiles */
export const DSH_PROFILES_DIR = path.join(DSH_HOME, 'profiles');
/** <DSH_HOME>/profiles/web —— web profile 目录 */
export const DSH_WEB_PROFILE_DIR = path.join(DSH_PROFILES_DIR, DSH_WEB_PROFILE);
/** web profile 的 package.json（插件依赖 / bundles 的事实源） */
export const DSH_WEB_MANIFEST = path.join(DSH_WEB_PROFILE_DIR, 'package.json');

// ---------------------------------------------------------------------------
// MacKit 自身（自更新用）
// ---------------------------------------------------------------------------
/** 仓库根目录 = app/ 的上一级；README 推荐的就是 git clone，所以 .git 通常在这里 */
export const REPO_DIR = path.resolve(APP_DIR, '..');
/** .git 路径（worktree / submodule 里可能是文件，exists() 两种情况都能判） */
export const GIT_DIR = path.join(REPO_DIR, '.git');

// ---------------------------------------------------------------------------
// 可执行文件路径探测
//
// 说明：这里只做「存在性探测」并给出确定路径；真正的子进程调用在 lib/exec.js。
// brew 已实测位于 /opt/homebrew/bin/brew（Apple Silicon），Intel 兜底 /usr/local/bin/brew。
// ---------------------------------------------------------------------------

/**
 * 判断路径是否存在（同步）。
 * @param {string} p
 * @returns {boolean}
 */
export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/**
 * 读文本文件，失败返回 null（不抛错）。
 * @param {string} p
 * @returns {string|null}
 */
export function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

/**
 * 构造带 `code` 的错误（形态与 exec.js 的 AppError 一致）。
 *
 * ★ 在这里而不是 import exec.js：exec.js → paths.js 已是一条依赖边，反向 import 会成环。
 * @param {string} code 取值与 exec.ERR 对齐（如 'IO_ERROR'）
 * @param {string} message 面向用户的中文短语
 * @param {string} [detail] 技术细节
 */
export function mkCodedError(code, message, detail) {
  const err = new Error(message);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/**
 * 写文本文件；失败抛 `IO_ERROR`（裸 fs 错误没有 code，会被上层报成 502 命令失败）。
 * @param {string} p
 * @param {string} text
 */
export function writeText(p, text) {
  try { fs.writeFileSync(p, text, 'utf8'); }
  catch (err) { throw mkCodedError('IO_ERROR', `写入失败：${p}`, String(err && err.message)); }
}

/**
 * 取字符串末尾 n 行（错误摘要用）。
 * @param {string} text
 * @param {number} [n=3]
 * @returns {string}
 */
export function tailLines(text, n = 3) {
  return String(text || '').trim().split('\n').slice(-n).join('\n');
}

/**
 * 按行拆分，去掉空行与每行首尾空白（全项目唯一实现）。
 * @param {string} text
 * @returns {string[]}
 */
export function lines(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * 从候选列表里挑第一个存在的路径，都不存在则返回 fallback。
 * @param {string[]} candidates
 * @param {string} fallback
 * @returns {string}
 */
function firstExisting(candidates, fallback) {
  for (const c of candidates) {
    if (c && exists(c)) return c;
  }
  return fallback;
}

/**
 * 宿主 PATH 里的目录列表（仅用于「定位工具」，绝不把它整体注入子进程 PATH）。
 * @returns {string[]}
 */
function pathDirs() {
  return String(process.env.PATH || '').split(':').filter((d) => d.length > 0);
}

/**
 * 在宿主 PATH 里找到第一个存在的可执行文件（npm / pnpm / dsh 的兜底探测）。
 * @param {string} name 裸命令名
 * @returns {string|null}
 */
function firstOnPath(name) {
  for (const dir of pathDirs()) {
    const p = path.join(dir, name);
    if (exists(p)) return p;
  }
  return null;
}

/** Homebrew 安装前缀：Apple Silicon 默认 /opt/homebrew，Intel 默认 /usr/local。 */
export const BREW_PREFIX = process.arch === 'arm64' ? '/opt/homebrew' : '/usr/local';
/** Homebrew 可执行文件 */
export const BREW_BIN = firstExisting(
  [`${BREW_PREFIX}/bin/brew`, '/opt/homebrew/bin/brew', '/usr/local/bin/brew'],
  `${BREW_PREFIX}/bin/brew`
);
/** git 可执行文件（Apple Git） */
export const GIT_BIN = firstExisting(['/usr/bin/git'], '/usr/bin/git');
/** xattr 可执行文件 */
export const XATTR_BIN = firstExisting(['/usr/bin/xattr'], '/usr/bin/xattr');
/** security 可执行文件（Keychain） */
export const SECURITY_BIN = firstExisting(['/usr/bin/security'], '/usr/bin/security');
/** osascript 可执行文件（图形授权） */
export const OSASCRIPT_BIN = firstExisting(['/usr/bin/osascript'], '/usr/bin/osascript');
/**
 * open 可执行文件（音乐模块「在 Finder 打开下载目录」用）。
 * 只用于 `open <目录>`：以参数数组形式调用，绝不把（用户可控的）路径拼进 shell 字符串。
 */
export const OPEN_BIN = firstExisting(['/usr/bin/open'], '/usr/bin/open');
export const CURL_BIN = firstExisting(['/usr/bin/curl'], '/usr/bin/curl');
/**
 * bash 可执行文件：仅用于执行 Homebrew 官方安装脚本（install.sh 需要 bash 解释器）。
 * 以绝对路径形式登记在 exec.js 的 ABSOLUTE_ALLOWED 中，不允许其他用途。
 */
export const BASH_BIN = firstExisting(['/bin/bash', '/usr/local/bin/bash'], '/bin/bash');
/**
 * node 可执行文件：启动器优先 /opt/homebrew/bin/node，
 * 代码内自引用则回落到当前进程的 execPath。
 */
export const NODE_BIN = firstExisting(
  ['/opt/homebrew/bin/node', '/usr/local/bin/node', ...pathDirs().map((d) => path.join(d, 'node'))],
  process.execPath
);

/**
 * npm / pnpm / dsh 可执行文件（DeepSeek Harness 模块用）。
 * 探测顺序：Homebrew 两代前缀 → 官网 pkg 的 /usr/local → pnpm 独立安装目录 →
 * 宿主 PATH 里实际能找到的那一个（覆盖 nvm / fnm / volta 等）。
 * 都找不到时回落到确定路径，交给调用方按「不存在」处理（exec 层会把 spawn 失败报出来）。
 */
export const NPM_BIN = firstExisting(
  [`${BREW_PREFIX}/bin/npm`, '/opt/homebrew/bin/npm', '/usr/local/bin/npm'],
  firstOnPath('npm') || `${BREW_PREFIX}/bin/npm`
);
/** pnpm（插件市场的前置；也可能来自 brew install pnpm 或独立安装脚本） */
export const PNPM_BIN = firstExisting(
  [`${BREW_PREFIX}/bin/pnpm`, '/opt/homebrew/bin/pnpm', '/usr/local/bin/pnpm',
    path.join(HOME, 'Library', 'pnpm', 'pnpm'), path.join(HOME, '.local', 'share', 'pnpm', 'pnpm')],
  firstOnPath('pnpm') || `${BREW_PREFIX}/bin/pnpm`
);
/** dsh（DeepSeek Harness 宿主；npm install -g 后落在全局前缀的 bin 下） */
export const DSH_BIN = firstExisting(
  [`${BREW_PREFIX}/bin/dsh`, '/opt/homebrew/bin/dsh', '/usr/local/bin/dsh',
    path.join(HOME, '.local', 'bin', 'dsh'), path.join(HOME, 'Library', 'pnpm', 'dsh')],
  firstOnPath('dsh') || `${BREW_PREFIX}/bin/dsh`
);

/**
 * PATH 前置段（子进程注入用）。
 * 现实是 brew 在 /opt/homebrew/bin（Apple Silicon）或 /usr/local/bin（Intel），
 * 官网 pkg 装的 Node 也在 /usr/local/bin；exec.js 会把它拼到 PATH 最前。
 */
export const PATH_PREFIX = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * 实际注入子进程的 PATH（exec.js 用这一个）。
 *
 * 在固定的 PATH_PREFIX 之后追加「上面探测到的各工具自己所在目录」：宿主 PATH 仍然
 * 完全不被继承（这是 2026-09-16 的教训，见 exec.buildEnv），但 nvm / fnm / 自定义
 * 前缀装的 node / npm / pnpm / dsh 也能被子进程找到 —— 否则 `#!/usr/bin/env node`
 * 这类 shebang 会因为 PATH 里没有 node 而失败。
 * 去重且保持顺序：PATH_PREFIX 里已有的目录不会被重复追加。
 */
export const EXEC_PATH = (() => {
  const dirs = [NODE_BIN, NPM_BIN, PNPM_BIN, DSH_BIN, BREW_BIN, GIT_BIN]
    .map((bin) => path.dirname(bin));
  const seen = new Set();
  const out = [];
  for (const d of [...PATH_PREFIX, ...dirs]) {
    if (!seen.has(d)) { seen.add(d); out.push(d); }
  }
  return out;
})();

// ---------------------------------------------------------------------------
// 音乐模块 · Python 环境路径（第 8 模块「音乐下载」）
//
// 全部常量集中在此，其它文件不得自拼（设计文档 §9）。Python 依赖被隔离在用户目录下
// 的独立虚拟环境里按需安装，绝不触碰系统 python3、不写系统目录、不 sudo；
// 未安装时其余 7 个模块 100% 照常工作。本文件只做「存在性探测」（fs.existsSync），
// 绝不执行 python、不联网 —— 真正确认可用性的执行探针在 lib/music/env.js。
// ---------------------------------------------------------------------------
/** ~/.mackit/py（音乐模块 Python 运行数据的根；删除即完全回滚） */
export const PY_DIR = path.join(MACKIT_DIR, 'py');
/** ~/.mackit/py/venv（独立虚拟环境） */
export const MUSIC_VENV = path.join(PY_DIR, 'venv');
/** venv 内解释器（exec 白名单精确放行；被 spawn 的绝对路径） */
export const MUSIC_VENV_PY = path.join(MUSIC_VENV, 'bin', 'python');
/** venv 内 pip（先执行 `-U pip musicdl` 的入口） */
export const MUSIC_VENV_PIP = path.join(MUSIC_VENV, 'bin', 'pip');
/** ~/.mackit/py/cache（PIP_CACHE_DIR，避免污染用户全局 pip 缓存） */
export const MUSIC_PIP_CACHE = path.join(PY_DIR, 'cache');
/** 桥接脚本（全项目唯一 import musicdl 的文件） */
export const MUSIC_BRIDGE = path.join(APP_DIR, 'lib', 'music', 'bridge.py');
/** ~/.mackit/cache/music/search（搜索结果快照 search-<id>.json） */
export const MUSIC_SEARCH_CACHE_DIR = path.join(CACHE_DIR, 'music', 'search');
/** ~/.mackit/cache/music/audio（边听边存：在线播放的音频按内容键缓存，供二次播放命中） */
export const MUSIC_AUDIO_CACHE_DIR = path.join(CACHE_DIR, 'music', 'audio');
/** 默认下载目录 ~/Music/MacKit */
export const MUSIC_DEFAULT_DIR = path.join(HOME, 'Music', 'MacKit');
/** 建 venv 用的 python3.12 固定候选（Homebrew 两代前缀；exec 白名单精确放行） */
export const PY312_CANDIDATES = Object.freeze([
  '/opt/homebrew/bin/python3.12',
  '/usr/local/bin/python3.12',
]);

/**
 * 探测可用于创建 venv 的 Python 3.12 解释器（纯存在性检查，不执行、不联网）。
 *
 * 顺序（设计 §6.1）：Homebrew 两代前缀 → `~/.mackit/py/<name>/bin/python3`（历史 venv）→
 * 宿主 PATH 里的 `python3.12` → 最后 `python3`。本函数只回答「路径是否存在」，
 * `version` 一律为 null；真正的版本号由 lib/music/env.js 用执行探针填充并校验 >= 3.12。
 *
 * @returns {{found:boolean, version:string|null, path:string|null,
 *            candidates:Array<{path:string, version:string|null}>}}
 */
export function findPython312() {
  const seen = new Set();
  /** @type {Array<{path:string, version:string|null}>} */
  const candidates = [];
  const push = (p) => {
    if (typeof p === 'string' && p.length > 0 && !seen.has(p)) {
      seen.add(p);
      candidates.push({ path: p, version: null });
    }
  };

  for (const p of PY312_CANDIDATES) push(p);
  // 历史 venv：~/.mackit/py/<name>/bin/python3（用户此前手动建的虚拟环境）
  try {
    for (const name of fs.readdirSync(PY_DIR)) push(path.join(PY_DIR, name, 'bin', 'python3'));
  } catch { /* PY_DIR 不存在：忽略 */ }
  // 宿主 PATH 里的 python3.12，最后再兜一层裸 python3（版本是否达标交给 env.js 判定）
  for (const dir of pathDirs()) push(path.join(dir, 'python3.12'));
  push(firstOnPath('python3'));

  for (const c of candidates) {
    if (exists(c.path)) return { found: true, version: null, path: c.path, candidates };
  }
  return { found: false, version: null, path: null, candidates };
}

/** 目录权限是否已在本进程内收紧过 */
let dirModeFixed = false;

/**
 * 幂等创建 MacKit 数据目录：MACKIT_DIR / LOGS_DIR / HISTORY_DIR / CACHE_DIR。
 *
 * 权限收紧到 0700（2026-09-19）：目录里放的是任务日志（可能含 WebDAV 地址、包名、
 * 本机路径）与缓存，此前用默认 mode 建成 0755，同机其他用户可读；config.json /
 * webdav.json / history 早就单独 chmod 600 了，目录与日志属于漏网。
 * chmod 只在进程内做一次：ensureDirs 会被 appendLog 每写一行日志调用，
 * 每次都 chmod 4 个目录是白白的系统调用。
 */
export function ensureDirs() {
  for (const dir of [MACKIT_DIR, LOGS_DIR, HISTORY_DIR, CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (dirModeFixed) return;
  dirModeFixed = true;
  for (const dir of [MACKIT_DIR, LOGS_DIR, HISTORY_DIR, CACHE_DIR]) {
    try { fs.chmodSync(dir, 0o700); } catch { /* 目录可能不属于自己（历史遗留），不致命 */ }
  }
}

/** 默认 Web 服务端口（占用则顺延） */
export const DEFAULT_PORT = 18080;

/** 本机回环地址（全局唯一绑定地址） */
export const LOOPBACK = '127.0.0.1';

/** 代理主机 */
export const PROXY_HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// DeepSeek Harness · profile 清单读取（纯 fs，无子进程，供 dsh 模块与 env 体检共用）
// ---------------------------------------------------------------------------

/**
 * 读取 web profile 的 package.json。
 * @returns {any|null} 解析失败 / 文件不存在一律 null
 */
export function readDshWebManifest() {
  const text = readTextSafe(DSH_WEB_MANIFEST);
  if (text === null) return null;
  try {
    const obj = JSON.parse(text);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

/**
 * 插件市场（dshmarket）在 web profile 里的安装状态。
 *
 * 「已装」以 node_modules/<包名>/package.json 的 version 为准（pnpm 装完即存在）；
 * 「已登记」看 profile 清单的 dsh.profile.bundles —— dsh 的 plugin 命令会在 pnpm
 * 成功后把声明了 dsh.bundle 的依赖补进 bundles，两者都齐才真正作为一层生效。
 *
 * @returns {{installed:boolean, declared:boolean, version:string|null, bundles:string[],
 *            profileDir:string, manifest:string}}
 */
export function readDshMarketState() {
  const manifest = readDshWebManifest();
  const declared = !!(manifest && manifest.dependencies
    && Object.prototype.hasOwnProperty.call(manifest.dependencies, DSH_MARKET_PACKAGE));
  const bundleList = manifest && manifest.dsh && manifest.dsh.profile
    && Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
  const bundles = bundleList.filter((b) => typeof b === 'string');

  const pkgDir = path.join(DSH_WEB_PROFILE_DIR, 'node_modules', ...DSH_MARKET_PACKAGE.split('/'));
  let version = null;
  const pkgText = readTextSafe(path.join(pkgDir, 'package.json'));
  if (pkgText !== null) {
    try {
      const pkg = JSON.parse(pkgText);
      if (pkg && typeof pkg.version === 'string') version = pkg.version;
    } catch { /* 版本读不到不影响「已安装」判定 */ }
  }

  return {
    installed: version !== null || exists(pkgDir),
    declared,
    version,
    bundles,
    profileDir: DSH_WEB_PROFILE_DIR,
    manifest: DSH_WEB_MANIFEST,
  };
}
