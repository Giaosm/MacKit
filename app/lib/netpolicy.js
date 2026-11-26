/**
 * MacKit · 网络通道策略（**唯一事实源**）
 *
 * 设计：**全局一个通道档位**（顶部栏的下拉，选中即生效，所有模块共用）。
 * 2026-11-26 由「每个模块一个档位」收敛而来 —— 同一个开关在多个页面各调一遍没有意义，
 * 还会让新增模块漏配一个"死设置"。档位取值见 store.CHANNEL_VALUES。
 *
 * 优先级（高 → 低）：
 *   1. 调用方**显式指定**的通道 —— 例如 Homebrew 逐项升级 / 安装时用户点的「代理 / 直连」按钮，
 *      必须严格按用户点的执行，**不受全局档位影响**（用户明确要求）。
 *   2. 全局档位 `mackit.channel`：proxy_first（优先代理）/ direct_first（优先直连）。
 *   3. 档位为 auto 时 → **按目标主机自动**：走 GitHub 的代理优先，其余直连优先。
 *
 * ★ auto 为什么按主机判、而不是二选一：同一次操作里不同目标的快慢能差 100 倍 ——
 *   官方 formulae.brew.sh（GitHub Pages）直连实测 ~20KB/s、走代理 ~1.4~3.4MB/s；
 *   而 PyPI / 国内镜像直连本就很快。一个全局开关必然让其中一半走在慢通道上。
 *
 * ★ 任何档位都保留「走不通自动换另一条通道」的兜底（见 exec.runWithChannel 与
 *   brew.downloadIndex 的两段尝试）；只有用户主动取消才立即停，不换通道。
 *
 * ★ 无法按主机逐次判的调用方（例如一个子进程内部要打多个不同目标）可以显式传
 *   proxy_first / direct_first —— 模块档位始终优先于自动判定。
 */

import * as store from './store.js';

/** 档位值域（唯一事实源在 store.js 的 CHANNEL_VALUES，这里只取本地别名）。 */
const CHANNEL_VALUES = store.CHANNEL_VALUES;

/**
 * GitHub 生态主机：github.com、*.githubusercontent.com、github.io、ghcr.io（Homebrew bottle 镜像）。
 * 这些目标在国内直连普遍不可用/极慢，一律代理优先。
 */
const GITHUB_HOST_RE = /(^|\.)(github\.com|githubusercontent\.com|github\.io|ghcr\.io)$/i;

/**
 * 主机名里看不出「GitHub」、但实际就托管在 GitHub Pages 上的域名。
 *   formulae.brew.sh —— CNAME → homebrew.github.io，解析到 185.199.108-111.153
 *   （反查 cdn-185-199-*-*.github.com）。它是 brew 官方索引源，正是「直连 20KB/s」的元凶。
 * 自查：`dig +short formulae.brew.sh CNAME`
 */
const GITHUB_PAGES_HOSTS = Object.freeze(['formulae.brew.sh']);

/**
 * 目标主机 → 自动档位下的通道策略。
 * @param {string} host
 * @returns {'proxy_first'|'direct_first'}
 */
export function policyForHost(host) {
  const h = String(host || '').toLowerCase();
  if (!h) return 'direct_first';
  if (GITHUB_HOST_RE.test(h) || GITHUB_PAGES_HOSTS.includes(h)) return 'proxy_first';
  return 'direct_first';
}

/**
 * URL → 自动档位下的通道策略（URL 无法解析按直连优先，与历史行为一致）。
 * @param {string} url
 * @returns {'proxy_first'|'direct_first'}
 */
export function policyForUrl(url) {
  try { return policyForHost(new URL(url).hostname); } catch { return 'direct_first'; }
}

/**
 * 从**已读到的** MacKit 配置里取全局通道档位（非法/缺失一律回落 auto）。
 * @param {object|undefined} modCfg store.readMackit() 的结果
 * @returns {'auto'|'proxy_first'|'direct_first'}
 */
function channelFromConfig(modCfg) {
  const v = modCfg && modCfg.channel;
  return CHANNEL_VALUES.includes(v) ? v : 'auto';
}

/**
 * 最终通道策略：全局档位优先，档位为 auto 时用调用方给出的「按目标自动」策略。
 * @param {object|undefined} modCfg 已读到的配置（避免为一个档位再读一次磁盘）
 * @param {'proxy_first'|'direct_first'} autoPolicy auto 档下应采用策略
 * @returns {'proxy_first'|'direct_first'}
 */
export function resolvePolicyFrom(modCfg, autoPolicy) {
  const set = channelFromConfig(modCfg);
  if (set === 'proxy_first' || set === 'direct_first') return set;
  return autoPolicy === 'proxy_first' ? 'proxy_first' : 'direct_first';
}

/**
 * 同 {@link resolvePolicyFrom}，但自己读配置（调用方手上没有配置对象时用）。
 * @param {'proxy_first'|'direct_first'} autoPolicy
 * @returns {'proxy_first'|'direct_first'}
 */
export function resolvePolicy(autoPolicy) {
  let cfg = null;
  try { cfg = store.readMackit(); } catch { /* 读不到 → 按 auto 处理 */ }
  return resolvePolicyFrom(cfg, autoPolicy);
}

/**
 * 策略 → 具体通道（子进程要的是 'proxy' / 'direct'，不是「优先」语义）。
 * @param {'proxy_first'|'direct_first'} policy
 * @returns {'proxy'|'direct'}
 */
export function bareChannel(policy) {
  return policy === 'proxy_first' ? 'proxy' : 'direct';
}
