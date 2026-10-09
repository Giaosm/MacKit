/**
 * cask 应用版本判定单测（纯函数，不联网）。
 *
 * 用例表全部来自**本机真实数据**（两个事故现场）：
 *   · codebuddy-cn：cask `4.12.1.39217423,757a5b2f`，而应用 CFBundleVersion 恰好等于短版本 4.12.1；
 *   · wechat      ：cask `4.1.15.22,270102`，逗号后那一截才是应用 build；
 *   · input-source-pro：cask 与应用都是 2.13.1（不该被藏起来的「真落后」要能列出）。
 * 两个方向都要守住：**不误吞**（应用旧了必须列出来）与**不误报**（应用已到位就别让 brew 降级）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appcastLatestVersion, githubRepoFromCaskUrl, sameAsCask } from '../lib/cask-version.js';

test('sameAsCask：codebuddy-cn 形态（build 被拼在逗号之前那截）', () => {
  assert.equal(sameAsCask('4.12.1', '39217423', '4.12.1.39217423,757a5b2f'), true);
  // 它的 CFBundleVersion 实际等于短版本（等于没有可用 build）→ 走约定 C 的前三段判定
  assert.equal(sameAsCask('4.12.1', '4.12.1', '4.12.1.39217423,757a5b2f'), true);
});

test('sameAsCask：wechat 形态（build 就是逗号之后那截）', () => {
  assert.equal(sameAsCask('4.1.15', '270102', '4.1.15.22,270102'), true);
  assert.equal(sameAsCask('4.1.15', '270100', '4.1.15.22,270102'), false);  // build 不同 → 真落后
});

test('sameAsCask：不误吞（应用旧了必须列出）', () => {
  assert.equal(sameAsCask('1.2', '', '1.2.5'), false);          // ★ 2026-10-08 修掉的那个漏报
  assert.equal(sameAsCask('1.2', '1.2', '1.2.5'), false);
  assert.equal(sameAsCask('2.13.0', '', '2.13.1'), false);
  assert.equal(sameAsCask('2.13', '', '2.13.1'), false);
});

test('sameAsCask：不误报（同一版要判等，否则 brew 升级会降级）', () => {
  assert.equal(sameAsCask('2.13.1', '2.13.1', '2.13.1'), true);
  assert.equal(sameAsCask('2.13.1', '1169', '2.13.1'), false);  // 有真 build 且与 cask 拼法对不上 → 宁可多提
  assert.equal(sameAsCask('1.2.0', '', '1.2'), true);           // 容忍尾部补零
  assert.equal(sameAsCask('4.12.1.1', '4.12.1.1', '4.12.1'), true);  // 应用段数更多（其实更新）→ 隐藏以避免降级
  assert.equal(sameAsCask('', '', '1.0'), false);               // 读不到应用版本 → 不判定为「同一版」
});

test('githubRepoFromCaskUrl：只认 releases 路径', () => {
  assert.equal(githubRepoFromCaskUrl('https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.5.7/x.dmg'), 'clash-verge-rev/clash-verge-rev');
  assert.equal(githubRepoFromCaskUrl('https://inputsource.pro/stable/Input%20Source%20Pro%202.13.1.dmg'), null);
  assert.equal(githubRepoFromCaskUrl('https://github.com/owner/repo'), null);
  assert.equal(githubRepoFromCaskUrl(null), null);
});

test('appcastLatestVersion：取最新稳定版，跳过 beta 通道', () => {
  const xml = [
    '<?xml version="1.0"?><rss><channel>',
    '<item><sparkle:shortVersionString>2.13.1</sparkle:shortVersionString><sparkle:version>1169</sparkle:version></item>',
    '<item sparkle:shortVersionString="2.14.0"><sparkle:version>1200</sparkle:version></item>',
    '<item><sparkle:channel>beta</sparkle:channel><sparkle:shortVersionString>3.0.0-beta</sparkle:shortVersionString></item>',
    '</channel></rss>',
  ].join('');
  assert.equal(appcastLatestVersion(xml), '2.14.0');
  assert.equal(appcastLatestVersion('<rss><channel><item><sparkle:shortVersionString>1.0</sparkle:shortVersionString></item></channel></rss>'), '1.0');
  assert.equal(appcastLatestVersion(''), null);
  assert.equal(appcastLatestVersion(null), null);
  assert.equal(appcastLatestVersion('<rss><channel><item><title>2.0</title></item></channel></rss>'), null);
});
