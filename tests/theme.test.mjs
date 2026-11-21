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
  assert.equal(THEME_DEFAULTS.glass, 6);
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
  assert.equal(p.blur, 0); // glass 6 -> max(0, 6-6)*0.32（clear 材质零模糊起步）
  assert.equal(p.edge, 8);
  assert.equal(p.shine, 2);
  assert.equal(p.tint, 0);
  assert.equal(p.light, 0.55); // light 55 -> /100
  assert.equal(p.depth, 0.42); // depth 42 -> /100
  assert.equal(p.dispersion, 0);
  assert.equal(p.wobble, 3);
  assert.equal(p.refract, 32);
  // lightAngle 224° -> 约 -2.38 rad（与原型默认 lightAngle -2.38 一致）
  assert.ok(Math.abs(p.lightAngle - (-2.38)) < 0.01, `lightAngle ${p.lightAngle}`);
  // 边界：glass 6 以下 blur 为 0
  assert.equal(glassParamsFor({ ...THEME_DEFAULTS, glass: 6 }).blur, 0);
  // 旧默认 glass 12 的映射保留：1.92（老用户已存值不重置时仍按此映射）
  assert.equal(glassParamsFor({ ...THEME_DEFAULTS, glass: 12 }).blur, 1.92);
});

test('LiquidGlass.DEFAULT_PARAMS 与主题默认一致（clear 精修后）', () => {
  assert.deepEqual(LiquidGlass.DEFAULT_PARAMS, {
    refract: 32, blur: 0, edge: 8, shine: 2, wobble: 3, tint: 0,
    lightAngle: -2.38, light: 0.55, dispersion: 0, depth: 0.42,
  });
});

test('LiquidGlass 着色器包含 clear 精修：输出 mask 不透明 + 亮度钳制 +0.06 + 边缘辉光上限 0.18', () => {
  const src = readFileSync(resolve(root, 'js/liquidGlass.js'), 'utf8');
  // 输出 alpha 即 mask（不透明），不再乘 0.52（画布与页面背板重影已除）
  assert.ok(src.includes('gl_FragColor = vec4(col.rgb, mask);'), '输出应为 vec4(col.rgb, mask)');
  assert.ok(!src.includes('mask * 0.52'), '不应残留 mask * 0.52');
  // 硬亮度钳制：玻璃不能比背后背景亮太多（+0.06 / -0.16）
  assert.ok(src.includes('clamp(col.rgb - baseCol, vec3(-0.16), vec3(0.06))'), '缺少亮度硬钳制 +0.06');
  assert.ok(!src.includes('vec3(0.10)'), '不应残留旧钳制 +0.10');
  // 边缘辉光上限 0.18（无热点）
  assert.ok(src.includes('clamp(edgeGlint, 0.0, 0.18)'), '缺少 edgeGlint 上限 0.18');
  assert.ok(!src.includes('clamp(edgeGlint, 0.0, 0.45)'), '不应残留 0.45 上限');
  // PDF 公式：上下辉光系数 0.66 / 0.48
  assert.ok(src.includes('upperLeft * 0.66 + lowerRight * 0.48'), '缺少 PDF 辉光公式');
});

test('styles.css：clear 轻玻璃默认值', () => {
  const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
  assert.ok(css.includes('--glass-blur-amt: 6px'), '玻璃模糊应为 6px');
  assert.ok(css.includes('--glass-bg: rgba(255, 255, 255, .05)'), '玻璃底色应为 .05');
  assert.ok(css.includes('--bg-veil: .12'), '遮罩应为 .12');
  assert.ok(css.includes('--bubble-ai: rgba(255, 255, 255, .22)'), 'AI 气泡应为 22% 透明');
  assert.ok(!css.includes('0 32px'), '不应残留 32px 大阴影');
  assert.ok(css.includes('backdrop-filter: blur(6px) saturate(1.1)'), 'AI 气泡应有 6px 模糊');
});
