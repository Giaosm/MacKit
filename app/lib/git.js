/**
 * MacKit · Git 全局配置 / 钥匙串凭据（唯一实现）
 *
 * 为什么单独成模块（2026-09-18 收敛）：
 *   - 「执行 git 并吞异常」原先写了三份：backup.runGit / sysinit.safeGit / env.runQuiet 的
 *     git 分支，三段的 try/catch 兜底逐字相同；
 *   - `GIT_KEYS` 白名单在 sysinit.js 与 backup.js 各写一份（后者的注释自认「与 sysinit.js 一致」）；
 *   - 钥匙串凭据的读取在 env.tokenExists 与 backup.readGithubCredential 各写一份，
 *     写入时的 stdin 拼装又在 sysinit.store_token 与 backup 的恢复步骤里各写一遍。
 * 以上全部收敛到本文件，其余模块直接引用，不再各自复制。
 *
 * 纪律：子进程一律经 lib/exec.js（全项目唯一子进程出口），本文件不直接 spawn；
 *       Token 只经 stdin 传递给 `git credential-osxkeychain store`，绝不进日志 / 文件。
 */

import * as exec from './exec.js';

/** 允许读写的 Git 全局配置键（白名单，防止任意键注入） */
export const GIT_KEYS = Object.freeze([
  'user.name', 'user.email', 'safe.directory', 'http.proxy', 'https.proxy', 'credential.helper',
]);

/** 只读探测的统一超时 */
const TIMEOUT_MS = 30_000;
/** 钥匙串读写的统一超时（可能弹系统授权，留宽一点） */
const KEYCHAIN_TIMEOUT_MS = 10_000;

/**
 * 执行一条 git 命令（失败不抛错，回落 `{ code:-1, … }`）。
 * @param {string[]} args
 * @param {import('./exec.js').RunOpts} [opts]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function run(args, opts = {}) {
  return exec.runSafe('git', args, { timeoutMs: TIMEOUT_MS, ...opts });
}

/**
 * 读取一条 git 全局配置。
 * @param {string} key
 * @returns {Promise<string|null>} 未设置时返回 null
 */
export async function config(key) {
  const res = await run(['config', '--global', '--get', key], { timeoutMs: KEYCHAIN_TIMEOUT_MS });
  if (res.code !== 0) return null;
  const val = res.stdout.trim();
  return val.length > 0 ? val : null;
}

/** 钥匙串凭据查询用的固定 stdin（protocol / host 两行 + 空行结束）。 */
const CREDENTIAL_QUERY = 'protocol=https\nhost=github.com\n\n';

/**
 * 解析 `git credential-osxkeychain get` 的输出（纯函数）。
 * @param {string} stdout
 * @returns {{username:string, token:string}|null}
 */
function parseCredentialOutput(stdout) {
  const get = (k) => {
    const m = new RegExp(`^${k}=(.*)$`, 'm').exec(String(stdout || ''));
    return m ? m[1] : null;
  };
  const username = get('username');
  const password = get('password');
  return username && password ? { username, token: password } : null;
}

/**
 * 读取钥匙串里的 GitHub 凭据（不存在 / 读取失败 → null；绝不抛错）。
 * @returns {Promise<{username:string, token:string}|null>}
 */
export async function readCredential() {
  const res = await run(['credential-osxkeychain', 'get'], {
    stdin: CREDENTIAL_QUERY, timeoutMs: KEYCHAIN_TIMEOUT_MS,
  });
  return parseCredentialOutput(res.stdout);
}

/**
 * 钥匙串里是否已有可用的 GitHub 凭据。
 * @returns {Promise<boolean>}
 */
export async function credentialExists() {
  return (await readCredential()) !== null;
}

/**
 * 写入 GitHub 凭据到 macOS 钥匙串（等价 `git credential-osxkeychain store`）。
 * ★ Token 只经 stdin 传入，绝不进日志 / 文件；调用方负责不要把它写进 ctx.log。
 * @param {string} username
 * @param {string} token
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function storeCredential(username, token) {
  const stdin = `protocol=https\nhost=github.com\nusername=${String(username)}\npassword=${String(token)}\n\n`;
  return run(['credential-osxkeychain', 'store'], { stdin, timeoutMs: TIMEOUT_MS });
}
