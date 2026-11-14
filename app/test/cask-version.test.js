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

test('sameAsCask：cask 逗号后是应用自家构建号（2026-11-14 抖音形态）', () => {
  // 实测 douyin：应用 CFBundleShortVersionString=8.8.0 / CFBundleVersion=014320，
  // cask 版本 8.8.0,7044145585217083655,540056698 —— 逗号后那套编码与 CFBundleVersion 无关，
  // 旧实现三种约定全落空 → 本体已是 8.8.0 却被列成「可更新」（界面显示「当前 8.8.0 → 可用 8.8.0」）。
  assert.equal(sameAsCask('8.8.0', '014320', '8.8.0,7044145585217083655,540056698'), true);
  // steam 形态：只有 CFBundleVersion（short 由 readAppVersion 回落成 6.1）
  assert.equal(sameAsCask('6.1', '6.1', '6.1,1791918634,984652b88a9737e3f4e77c656d9ffa67d5042c2c'), true);
  // 逗号前那截不等 → 仍是真落后，不能被吞
  assert.equal(sameAsCask('8.5.1', '014320', '8.8.0,7044145585217083655,540056698'), false);
  // 无逗号的 cask 不受这条影响（保守口径：宁可多提）
  assert.equal(sameAsCask('2.13.1', '1169', '2.13.1'), false);
});

test('sameAsCask：预发布后缀必须参与比较（2026-10-25 漏报）', () => {
  // 实测 deepseek-harness：应用 0.2.1-rc.2、cask 0.2.1-rc.3，brew 三种口径都报 outdated，
  // 但旧实现用 parseStrict 把两边都截成 [0,2,1] → 判成「已是最新」→ 永远列不出来。
  assert.equal(sameAsCask('0.2.1-rc.2', '0.2.1-rc.2', '0.2.1-rc.3'), false);  // 真落后 → 必须列出
  assert.equal(sameAsCask('0.2.1-rc.3', '0.2.1-rc.3', '0.2.1-rc.3'), true);   // 已是这一版 → 不列
  assert.equal(sameAsCask('0.2.1-rc.4', '0.2.1-rc.4', '0.2.1-rc.3'), true);   // 应用更新 → 不列（避免降级）
  // 正式版 vs 同核心的预发布：正式版更新，不该被 brew 降级到 rc
  assert.equal(sameAsCask('0.2.1', '0.2.1', '0.2.1-rc.3'), true);
  // 应用是预发布、cask 是正式版 → 应用更旧 → 列出升级
  assert.equal(sameAsCask('0.2.1-rc.1', '0.2.1-rc.1', '0.2.1'), false);
  // 复现「前三段相同但第 4 段数字不同」的通用情形
  assert.equal(sameAsCask('1.0.0.5', '1.0.0.5', '1.0.0.9'), false);
  assert.equal(sameAsCask('1.0.0.9', '1.0.0.9', '1.0.0.5'), true);
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
