/**
 * Rime 外观解析单测（纯函数）。
 *
 * 两个坑都在这里锁住：
 *   1. 扁平（`style/color_scheme: x`）与嵌套（`style:` → `color_scheme: x`）两种写法都要认；
 *   2. **注释行不算当前值** —— `# style/color_scheme: aqua` 不能被当成生效中的皮肤。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRimeAppearance } from '../lib/rime-appearance.js';

test('扁平写法', () => {
  const a = parseRimeAppearance([
    'patch:',
    '  style/color_scheme: apathy',
    '  style/candidate_list_layout: linear',
    '  style/text_orientation: horizontal',
    '',
  ].join('\n'));
  assert.deepEqual(a, { skin: 'apathy', layout: 'linear', orientation: 'horizontal' });
});

test('嵌套写法', () => {
  const a = parseRimeAppearance([
    'patch:',
    '  style:',
    '    color_scheme: ink',
    '    candidate_list_layout: stacked',
    '    text_orientation: vertical',
    '',
  ].join('\n'));
  assert.deepEqual(a, { skin: 'ink', layout: 'stacked', orientation: 'vertical' });
});

test('注释行不算当前值；缺失回落 null', () => {
  const a = parseRimeAppearance('# style/color_scheme: aqua\npatch:\n');
  assert.equal(a.skin, null);
  assert.equal(a.layout, null);
  assert.equal(a.orientation, null);
});

test('空 / null 输入不抛错', () => {
  assert.deepEqual(parseRimeAppearance(null), { skin: null, layout: null, orientation: null });
  assert.deepEqual(parseRimeAppearance(''), { skin: null, layout: null, orientation: null });
});
