// glass-clear-css.test.mjs — 液态玻璃精修（CSS 侧）的参数映射断言。
// 只读 styles.css 做静态断言，不碰 DOM / IndexedDB / JS。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');

test('单一事实来源：文件里只有一个 :root', () => {
  const count = (css.match(/^:root \{/gm) || []).length;
  assert.equal(count, 1, `应恰好 1 个 :root，实测 ${count}`);
});

test('clear 材质默认值在 0.03–0.08 / 4–8px 区间内', () => {
  assert.ok(css.includes('--glass-blur-amt: 6px'), '模糊默认应为 6px');
  assert.ok(css.includes('--glass-bg: rgba(255, 255, 255, .05)'), '玻璃底色应为 .05');
  assert.ok(css.includes('--glass-border: rgba(255, 255, 255, .20)'), '描边应为 .20');
  assert.ok(css.includes('--glass-bg-strong: rgba(255, 255, 255, .55)'), '无 backdrop-filter 降级底色应为 .55');
  assert.ok(css.includes('--bubble-ai: rgba(255, 255, 255, .22)'), 'AI 气泡应为 .22');
  assert.ok(css.includes('--bubble-me: rgba(221, 221, 221, .35)'), '我方气泡应为 .35');
});

test('旧的厚重白值已清除', () => {
  for (const dead of [
    'blur(22px)', '#eaeaeaeb', '#fffffff0', '#ffffffc0', '#ffffffb0',
    'rgba(255, 255, 255, .62)', 'rgba(255, 255, 255, .7)',
    'rgba(255, 255, 255,.16)', '--glass-blur-amt: 12px',
  ]) assert.ok(!css.includes(dead), `不应残留 ${dead}`);
});

test('WebGL 态 CSS 清零：透明底 + 无 backdrop-filter', () => {
  const m = css.match(/\.glass\.gl-webgl \{[^}]*\}/);
  assert.ok(m, '应有 .glass.gl-webgl 规则');
  assert.ok(m[0].includes('background: transparent'), 'WebGL 态背景应为 transparent');
  assert.ok(m[0].includes('backdrop-filter: none'), 'WebGL 态应无 backdrop-filter');
  const b = css.match(/\.bubble\.glass\.gl-webgl \{[^}]*\}/);
  assert.ok(b && b[0].includes('background: transparent'), 'WebGL 态气泡背景也应为 transparent');
});

test('按组件分别调强度：大卡片最轻 4px / .04，气泡 6px', () => {
  assert.ok(css.includes('.group.glass, .char-card.glass, .hero-card.glass, .post.glass'), '应有大卡片分组规则');
  assert.ok(css.includes('blur(4px)'), '大卡片模糊应为 4px');
  assert.ok(css.includes('rgba(255, 255, 255, .04)'), '大卡片白底应为 .04');
  assert.ok(css.includes('backdrop-filter: blur(6px)'), '气泡模糊应为 6px');
});

test('减嵌套：子元素不再叠整套玻璃', () => {
  const m = css.match(/\.m-ico\.glass, \.post-action\.glass, \.chip\.glass, \.tag-now\.glass \{[^}]*\}/);
  assert.ok(m, '应有子元素去玻璃化规则');
  assert.ok(m[0].includes('backdrop-filter: none'), '子元素应无 backdrop-filter');
  assert.ok(m[0].includes('box-shadow: none'), '子元素应无投影');
});

test('subpage 与 modal 已减薄', () => {
  assert.ok(css.includes('rgba(238, 238, 238, .50)'), 'subpage 背景应为 .50');
  assert.ok(css.includes('.modal-card.glass { background: rgba(255, 255, 255, .55)'), 'modal 背景应为 .55');
});

test('深色 tone 可读性：浅色字 + 占位符提亮', () => {
  assert.ok(css.includes('[data-tone=dark]{color-scheme:dark;--ink:#f0f0f0;'), 'dark 下 --ink 应为浅色');
  assert.ok(css.includes('[data-tone=dark] #input::placeholder { color: #c9c9c9; }'), 'dark 下 placeholder 应提亮');
  assert.ok(css.includes('[data-tone=dark] .brand-caption { color: #e8e8e8;'), 'dark 下 brand-caption 应为浅色');
  assert.ok(css.includes('rgba(34,34,34,.55)'), 'dark 下 subpage 应为 .55');
});
