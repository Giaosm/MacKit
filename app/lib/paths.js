/**
 * MacKit · 路径常量唯一来源
 *
 * 依据《MacKit-架构设计.md》§8.5：全项目的文件/可执行文件路径必须在此定义并导出，
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
/** app/lib/ */
export const LIB_DIR = path.join(APP_DIR, 'lib');
/** app/web/ */
export const WEB_DIR = path.join(APP_DIR, 'web');
/** app/MacKit.command */
export const LAUNCHER = path.join(APP_DIR, 'MacKit.command');

// ---------------------------------------------------------------------------
// 用户家目录与 ~/.mackit 数据目录
// ---------------------------------------------------------------------------
/** 用户家目录 */
export const HOME = os.homedir();
/** ~/.mackit */
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
// 配置事实源（原脚本共用，格式不变）
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
 * 原先 store / brew / env / rime / sysinit / backup 各写了一份逐字相同的实现，
 * 2026-09-16 统一到这里（与上面的 exists() 同类：都是无副作用的文件辅助）。
 * @param {string} p
 * @returns {string|null}
 */
export function readTextSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
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
/** curl 可执行文件 */
export const CURL_BIN = firstExisting(['/usr/bin/curl'], '/usr/bin/curl');
/** open 可执行文件 */
export const OPEN_BIN = firstExisting(['/usr/bin/open'], '/usr/bin/open');
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
  ['/opt/homebrew/bin/node'],
  process.execPath
);

/**
 * PATH 前置段（子进程注入用）。
 * 复刻原脚本"brew 在 /opt/homebrew/bin"的现实；exec.js 会把它拼到 PATH 最前。
 */
export const PATH_PREFIX = ['/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/**
 * 幂等创建 MacKit 数据目录：MACKIT_DIR / LOGS_DIR / HISTORY_DIR / CACHE_DIR。
 * 已存在则不报错；创建失败抛出 IO_ERROR 语义的异常由调用方处理。
 */
export function ensureDirs() {
  for (const dir of [MACKIT_DIR, LOGS_DIR, HISTORY_DIR, CACHE_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 默认 Web 服务端口（占用则顺延） */
export const DEFAULT_PORT = 18080;

/** 本机回环地址（全局唯一绑定地址） */
export const LOOPBACK = '127.0.0.1';

/** 代理主机（原脚本 PROXY_HOST 常量） */
export const PROXY_HOST = '127.0.0.1';

export default {
  APP_DIR,
  LIB_DIR,
  WEB_DIR,
  LAUNCHER,
  HOME,
  MACKIT_DIR,
  CONFIG_JSON,
  RUNTIME_JSON,
  LOGS_DIR,
  HISTORY_DIR,
  CACHE_DIR,
  WEBDAV_JSON,
  BREWGO_CONFIG,
  RC_ZSH,
  RC_BASH,
  RC_ZPROFILE,
  RC_BASH_PROFILE,
  SHELL_KIND,
  SHELL_RC,
  RIME_DIR,
  RIME_CUSTOM,
  RIME_SQUIRREL,
  RIME_BUILD_SQUIRREL,
  RIME_MAIN_SCHEMA,
  RIME_MAIN_DICT,
  RIME_CN_DICTS,
  RIME_EN_DICTS,
  RIME_BUILD_DEFAULT,
  RIME_DEFAULT_CUSTOM,
  PLUM_DIR,
  SQUIRREL_BIN,
  BREW_BIN,
  GIT_BIN,
  XATTR_BIN,
  SECURITY_BIN,
  OSASCRIPT_BIN,
  CURL_BIN,
  OPEN_BIN,
  BASH_BIN,
  NODE_BIN,
  BREW_PREFIX,
  PATH_PREFIX,
  DEFAULT_PORT,
  LOOPBACK,
  PROXY_HOST,
  exists,
  ensureDirs,
};
