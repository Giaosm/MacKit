/**
 * 网络通道策略单测（纯函数）。
 *
 * 规则就一条：**走 GitHub 生态的一律代理优先，其余直连优先**；`formulae.brew.sh` 虽是
 * 第三方域名、但托管在 GitHub Pages 上，必须显式列入（否则国家内直连 20KB/s 的老问题会回来）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { policyForHost, policyForUrl, bareChannel } from '../lib/netpolicy.js';

test('GitHub 生态 → 代理优先', () => {
  for (const h of ['github.com', 'api.github.com', 'raw.githubusercontent.com', 'homebrew.github.io', 'ghcr.io', 'objects.githubusercontent.com']) {
    assert.equal(policyForHost(h), 'proxy_first', h);
  }
});

test('formulae.brew.sh → 代理优先（GitHub Pages，主机名看不出来）', () => {
  assert.equal(policyForHost('formulae.brew.sh'), 'proxy_first');
  assert.equal(policyForUrl('https://formulae.brew.sh/api/formula.json'), 'proxy_first');
});

test('其余主机 / 无法解析 → 直连优先', () => {
  assert.equal(policyForHost('pypi.org'), 'direct_first');
  assert.equal(policyForHost('mirrors.ustc.edu.cn'), 'direct_first');
  assert.equal(policyForHost(''), 'direct_first');
  assert.equal(policyForUrl('https://mirrors.ustc.edu.cn/homebrew-bottles/api/cask.json'), 'direct_first');
  assert.equal(policyForUrl('not a url'), 'direct_first');
});

test('bareChannel：策略 → 子进程实际通道', () => {
  assert.equal(bareChannel('proxy_first'), 'proxy');
  assert.equal(bareChannel('direct_first'), 'direct');
});
