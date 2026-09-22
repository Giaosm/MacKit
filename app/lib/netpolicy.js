/**
 * MacKit · 网络通道策略（**唯一事实源**，2026-09-22 新增）
 *
 * 设计：**每个模块一个通道档位**（在模块顶部的小下拉里选，选中即生效），该模块下所有联网行为
 * 都走这个档位。档位取值与存储见 store.CHANNEL_VALUES / CHANNEL_KEYS。
 *
 * 优先级（高 → 低）：
 *   1. 调用方**显式指定**的通道 —— 例如 Homebrew 逐项升级 / 安装时用户点的「代理 / 直连」按钮，
 *      必须严格按用户点的执行，**不受模块档位影响**（用户明确要求）。
 *   2. 模块档位 `<module>Channel`：proxy_first（优先代理）/ direct_first（优先直连）。
 *   3. 档位为 auto 时 → **按目标主机自动**：走 GitHub 的代理优先，其余直连优先。
 *
 * ★ auto 为什么按主机判、而不是二选一：同一次操作里不同目标的快慢能差 100 倍 ——
 *   官方 formulae.brew.sh（GitHub Pages）直连实测 ~20KB/s、走代理 ~1.4~3.4MB/s；
 *   而 PyPI / 国内镜像直连本就很快。一个全局开关必然让其中一半走在慢通道上。
 *
 * ★ 任何档位都保留「走不通自动换另一条通道」的兜底（见 exec.runWithChannel 与
 *   brew.downloadIndex 的两段尝试）；只有用户主动取消才立即停，不换通道。
 *
 * ★ 多目标的模块（音乐：musicdl 一个子进程会打多个音源）无法按主机逐次判，其 auto 落在
 *   直连优先 —— 它的目标基本都是国内音源，这也是它一直以来的行为。
 */

import * as store from './store.js';

/** 档位值域（唯一事实源在 store.js，这里转发，避免两处各写一份）。 */
export const CHANNEL_VALUES = store.CHANNEL_VALUES;

/** 有通道档位的模块（只有真联网的模块才给开关，避免出现「设置了却不生效」的死设置）。 */
export const CHANNEL_MODULES = Object.freeze(['brew', 'music', 'rime', 'selfupdate']);

/** 档位 → 展示名（前端下拉与后端日志共用一套文案）。 */
export const CHANNEL_LABELS = Object.freeze({
  auto: '自动（按目标）',
  proxy_first: '优先代理',
  direct_first: '优先直连',
});

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
 * 从**已读到的** MacKit 配置对象里取某模块的通道档位（非法/缺失一律回落 auto）。
 * @param {object|undefined} modCfg store.readMackit() 的结果
 * @param {string} moduleId
 * @returns {'auto'|'proxy_first'|'direct_first'}
 */
export function channelFromConfig(modCfg, moduleId) {
  const v = modCfg && modCfg[`${moduleId}Channel`];
  return CHANNEL_VALUES.includes(v) ? v : 'auto';
}

/**
 * 读某模块的通道档位（自己读配置的便捷版）。
 * @param {string} moduleId
 * @returns {'auto'|'proxy_first'|'direct_first'}
 */
export function readModuleChannel(moduleId) {
  try { return channelFromConfig(store.readMackit(), moduleId); } catch { return 'auto'; }
}

/**
 * 最终通道策略：模块档位优先，档位为 auto 时用调用方给出的「按目标自动」策略。
 * @param {object|undefined} modCfg 已读到的配置（避免为一个档位再读一次磁盘）
 * @param {string} moduleId brew|music|rime|selfupdate
 * @param {'auto'|'proxy_first'|'direct_first'} autoPolicy 该模块在 auto 档下应采用的策略
 * @returns {'proxy_first'|'direct_first'}
 */
export function resolvePolicyFrom(modCfg, moduleId, autoPolicy) {
  const set = channelFromConfig(modCfg, moduleId);
  if (set === 'proxy_first' || set === 'direct_first') return set;
  return autoPolicy === 'proxy_first' ? 'proxy_first' : 'direct_first';
}

/**
 * 同 {@link resolvePolicyFrom}，但自己读配置（调用方手上没有配置对象时用）。
 * @param {string} moduleId
 * @param {'auto'|'proxy_first'|'direct_first'} autoPolicy
 * @returns {'proxy_first'|'direct_first'}
 */
export function resolvePolicy(moduleId, autoPolicy) {
  let cfg = null;
  try { cfg = store.readMackit(); } catch { /* 读不到 → 按 auto 处理 */ }
  return resolvePolicyFrom(cfg, moduleId, autoPolicy);
}

/**
 * 策略 → 具体通道（子进程要的是 'proxy' / 'direct'，不是「优先」语义）。
 * @param {'proxy_first'|'direct_first'} policy
 * @returns {'proxy'|'direct'}
 */
export function bareChannel(policy) {
  return policy === 'proxy_first' ? 'proxy' : 'direct';
}

export default {
  CHANNEL_VALUES, CHANNEL_MODULES, CHANNEL_LABELS,
  policyForHost, policyForUrl, channelFromConfig, readModuleChannel, resolvePolicyFrom, resolvePolicy, bareChannel,
};
