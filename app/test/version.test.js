/**
 * 版本工具单测（零依赖，`npm test` 即 `node --test`）。
 *
 * 为什么值得留：`sameVersion` / `samePrefix` 的差别在 2026-10-08 直接导致过一次回归 ——
 * 「应用 1.2 / cask 1.2.5」被误判成同一版、升级被吞掉。纯函数用测试锁住比注释可靠。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compare, samePrefix, sameVersion, parseStrict, segments } from '../lib/version.js';

test('segments：去 v 前缀，`,` `-` `_` `+` 都是分隔符', () => {
  assert.deepEqual(segments('v1.2.3'), ['1', '2', '3']);
  assert.deepEqual(segments('1.5.7_1'), ['1', '5', '7', '1']);
  assert.deepEqual(segments('4.1.15.22,270102'), ['4', '1', '15', '22', '270102']);
  assert.deepEqual(segments(null), []);
});

test('compare：数字段按数值、缺段视为更小', () => {
  assert.equal(compare('1.10.0', '1.9.9'), 1);
  assert.equal(compare('v2.5.5', '2.5.5'), 0);
  assert.equal(compare('2.13', '2.13.1'), -1);
  assert.equal(compare('4.12.1.39217423', '4.12.1'), 1);
  assert.equal(compare('1.5.7_1', '1.5.7'), 1);
});

test('samePrefix：前缀判定（注意 1.2 是 1.2.5 的前缀）', () => {
  assert.equal(samePrefix('1.2', '1.2.5'), true);
  assert.equal(samePrefix('1.2.5', '1.2'), false);
  assert.equal(samePrefix('4.12.1.39217423', '4.12.1.39217423'), true);
});

test('sameVersion：忽略尾部补零的完整相等', () => {
  assert.equal(sameVersion('1.2', '1.2.0'), true);
  assert.equal(sameVersion('1.2', '1.2.5'), false);            // ★ 那次漏报的用例
  assert.equal(sameVersion('2.13.1', '2.13.1'), true);
  assert.equal(sameVersion('4.12.1', '4.12.1.39217423'), false);
});

test('parseStrict：严格 MAJOR.MINOR.PATCH，失败 null', () => {
  assert.deepEqual(parseStrict('4.12.1.39217423'), [4, 12, 1]);
  assert.deepEqual(parseStrict('1.2.3'), [1, 2, 3]);
  assert.equal(parseStrict('1.2'), null);
  assert.equal(parseStrict(''), null);
  assert.equal(parseStrict(null), null);
});
