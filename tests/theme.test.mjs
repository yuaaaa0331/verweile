// theme.test.mjs — 外观/玻璃主题（移植自原型 uwu-liao-tian-ui-yuan-xing 的亮度修正后默认值）。
// 只测纯函数与常量，不碰 DOM / IndexedDB。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { contrastInk, hexA, THEME_DEFAULTS, INK_SWATCHES, ME_SWATCHES, AI_SWATCHES, glassParamsFor } from '../js/theme.js';
import { LiquidGlass } from '../js/liquidGlass.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('contrastInk：亮色气泡配深字，暗色气泡配浅字（阈值 lum > 0.62）', () => {
  assert.equal(contrastInk('#d6ebff'), '#303030');
  assert.equal(contrastInk('#ffffff'), '#303030');
  assert.equal(contrastInk('#3a4656'), '#f7f7f7');
  assert.equal(contrastInk('#454e5a'), '#f7f7f7');
  // 3 位 hex 展开
  assert.equal(contrastInk('#fff'), '#303030');
  assert.equal(contrastInk('#000'), '#f7f7f7');
});

test('hexA：hex 转带透明度的 rgba', () => {
  assert.equal(hexA('#ffffff', 0.62), 'rgba(255,255,255,0.62)');
  assert.equal(hexA('#d6ebff', 1), 'rgba(214,235,255,1)');
});

test('THEME_DEFAULTS：verweile 默认外观', () => {
  assert.equal(THEME_DEFAULTS.light, 55);
  assert.equal(THEME_DEFAULTS.veil, 12);
  assert.equal(THEME_DEFAULTS.glass, 12);
  assert.equal(THEME_DEFAULTS.refract, 32);
  assert.equal(THEME_DEFAULTS.depth, 42);
  assert.equal(THEME_DEFAULTS.dispersion, 0);
  assert.equal(THEME_DEFAULTS.wobble, 3);
  assert.equal(THEME_DEFAULTS.lightAngle, 224);
  assert.equal(THEME_DEFAULTS.bg, 'none');
  assert.equal(THEME_DEFAULTS.ink, '#292929');
  assert.equal(THEME_DEFAULTS.me, '#dddddd');
  assert.equal(THEME_DEFAULTS.ai, '#ffffff');
});

test('内置黑白灰色板', () => {
  assert.deepEqual(INK_SWATCHES, ['#292929', '#505050', '#777777', '#d6d6d6', '#f2f2f2']);
  assert.deepEqual(ME_SWATCHES, ['#ffffff', '#e8e8e8', '#cccccc', '#9c9c9c', '#575757', '#292929']);
  assert.deepEqual(AI_SWATCHES, ['#ffffff', '#f1f1f1', '#e1e1e1', '#a6a6a6', '#555555', '#242424']);
});

test('glassParamsFor：主题值映射到 WebGL 参数', () => {
  const p = glassParamsFor(THEME_DEFAULTS);
  assert.equal(p.blur, 1.92); // glass 12 -> max(0, 12-6)*0.32
  assert.equal(p.edge, 15);
  assert.equal(p.shine, 6);
  assert.equal(p.tint, 2);
  assert.equal(p.light, 0.55); // light 55 -> /100
  assert.equal(p.depth, 0.42); // depth 42 -> /100
  assert.equal(p.dispersion, 0);
  assert.equal(p.wobble, 3);
  assert.equal(p.refract, 32);
  // lightAngle 224° -> 约 -2.38 rad（与原型默认 lightAngle -2.38 一致）
  assert.ok(Math.abs(p.lightAngle - (-2.38)) < 0.01, `lightAngle ${p.lightAngle}`);
  // 边界：glass 6 以下 blur 为 0
  assert.equal(glassParamsFor({ ...THEME_DEFAULTS, glass: 6 }).blur, 0);
});

test('LiquidGlass.DEFAULT_PARAMS 与原型引擎默认值一致', () => {
  assert.deepEqual(LiquidGlass.DEFAULT_PARAMS, {
    refract: 20, blur: 0, edge: 15, shine: 6, wobble: 8, tint: 2,
    lightAngle: -2.38, light: 0.55, dispersion: 5, depth: 0.32,
  });
});

test('LiquidGlass 着色器包含亮度修正：硬钳制 + 边缘辉光上限 + 玻璃面透明度 0.52', () => {
  const src = readFileSync(resolve(root, 'js/liquidGlass.js'), 'utf8');
  // 硬亮度钳制：玻璃不能比背后背景亮太多（+0.10 / -0.16）
  assert.ok(src.includes('clamp(col.rgb - baseCol, vec3(-0.16), vec3(0.10))'), '缺少亮度硬钳制');
  // 边缘辉光上限 0.45（无热点）
  assert.ok(src.includes('clamp(edgeGlint, 0.0, 0.45)'), '缺少 edgeGlint 上限 0.45');
  // WebGL 玻璃面最终透明度 0.52（不是早期 0.96）
  assert.ok(src.includes('mask * 0.52'), '缺少 mask * 0.52');
  // PDF 公式：上下辉光系数 0.66 / 0.48
  assert.ok(src.includes('upperLeft * 0.66 + lowerRight * 0.48'), '缺少 PDF 辉光公式');
});

test('styles.css：轻玻璃默认值（无早期厚重值）', () => {
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  assert.ok(css.includes('--glass-blur-amt: 12px'), '玻璃模糊应为 12px');
  assert.ok(css.includes('--glass-bg: rgba(255, 255, 255,.16)'), '玻璃底色应为 .16');
  assert.ok(css.includes('--bg-veil: .12'), '遮罩应为 .12');
  assert.ok(css.includes('--bubble-ai: rgba(255, 255, 255, .62)'), 'AI 气泡应为 62% 透明');
  assert.ok(!css.includes('0 32px'), '不应残留 32px 大阴影');
  assert.ok(css.includes('backdrop-filter: blur(8px) saturate(1.25)'), 'AI 气泡应有 8px 模糊');
});
