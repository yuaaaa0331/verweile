// glass-clear-engine.test.mjs — 液态玻璃 Clear 精修（2026-11-20）的引擎侧验证。
// 只测 js/liquidGlass.js 与 js/theme.js 的纯逻辑 + shader 源码断言，不碰 DOM / IndexedDB。
// WebGL 实机渲染（折射观感、帧率、发热）本沙箱起不来，由验证方在实浏览器补验。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LiquidGlass } from '../js/liquidGlass.js';
import {
  glassParamsFor, THEME_DEFAULTS, clampTheme, hexLuminance,
  averageLuminanceFromData, veilBakedLuminance, deriveTone,
  coverTransform, TONE_LUMA_THRESHOLD,
} from '../js/theme.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineSrc = readFileSync(resolve(root, 'js/liquidGlass.js'), 'utf8');

const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

// ---------- 1. 输出不透明 ----------
test('shader 输出 alpha 即 mask（不透明），不再乘 0.52', () => {
  assert.ok(engineSrc.includes('gl_FragColor = vec4(col.rgb, mask);'), '输出应为 vec4(col.rgb, mask)');
  assert.ok(!engineSrc.includes('mask * 0.52'), '不应残留 mask * 0.52（画布与页面背板重影）');
});

// ---------- 2. 高光做薄 ----------
test('shader：全表面斜向高光已改为边缘局部左上 wash，边缘辉光上限收紧', () => {
  assert.ok(engineSrc.includes('upperLeft * rim * rim'), 'wash 应只在左上边缘窄带（rim²）');
  assert.ok(!engineSrc.includes('pow(grad, 1.6)'), '不应残留全表面 grad 高光');
  assert.ok(engineSrc.includes('clamp(edgeGlint, 0.0, 0.18)'), '边缘辉光上限应为 0.18（旧 0.45）');
  assert.ok(!engineSrc.includes('clamp(edgeGlint, 0.0, 0.45)'), '不应残留 0.45 上限');
  // 方向性保留：左上 0.66 / 右下 0.48
  assert.ok(engineSrc.includes('upperLeft * 0.66 + lowerRight * 0.48'), '方向性 0.66/0.48 应保留');
});

test('高光实测上限：wash 与边缘辉光均比旧值大幅降低', () => {
  const p = glassParamsFor(THEME_DEFAULTS);
  // wash 最大值 = u_shine(=shine/100) * u_light * 1（upperLeft=1, rim=1）* 0.02；旧值 0.06*0.55*0.08=0.00264
  const washMax = (p.shine / 100) * p.light * 0.02;
  assert.ok(approx(washMax, 0.00022, 1e-9), `washMax 应为 0.00022，实测 ${washMax}`);
  assert.ok(washMax < 0.001, 'wash 上限应 < 0.001');
  // 边缘辉光最大值 = clamp 上限 0.18 * u_edge(=edge/100)；旧审计上限 0.45*0.15=0.0675
  const edgeMax = 0.18 * (p.edge / 100);
  assert.ok(approx(edgeMax, 0.0144, 1e-9), `edgeMax 应为 0.0144，实测 ${edgeMax}`);
  assert.ok(edgeMax < 0.02, '边缘辉光上限应 < 0.02（旧 0.0675）');
});

// ---------- 3. 折射场中心安静 + 色散/tint 默认 0 + 钳制收紧 ----------
test('shader：折射场中心值 0.03、波动基础 0.05、钳制 +0.06/-0.16、无增饱和', () => {
  assert.ok(engineSrc.includes('float field = 0.03 + 0.97'), 'field 基础应为 0.03（旧 0.16）');
  assert.ok(!engineSrc.includes('0.16 + 0.84'), '不应残留 field 0.16');
  assert.ok(engineSrc.includes('(0.05 + 0.95 * rim)'), '波动基础应为 0.05（旧 0.30）');
  assert.ok(!engineSrc.includes('(0.30 + 0.70 * rim)'), '不应残留波动 0.30');
  assert.ok(engineSrc.includes('clamp(col.rgb - baseCol, vec3(-0.16), vec3(0.06))'), '亮度钳制应为 +0.06/-0.16（旧 +0.10）');
  assert.ok(!engineSrc.includes('1.03'), '不应残留 mix(luma, rgb, 1.03) 增饱和');
});

test('DEFAULT_PARAMS 与主题统一：色散 0、tint 0，其余与 glassParamsFor(默认)一致', () => {
  assert.deepEqual(LiquidGlass.DEFAULT_PARAMS, {
    refract: 32, blur: 0, edge: 8, shine: 2, wobble: 3, tint: 0,
    lightAngle: -2.38, light: 0.55, dispersion: 0, depth: 0.42,
  });
});

test('glassParamsFor(默认)：edge 8 / shine 2 / tint 0，blur/折射/深度不变', () => {
  const p = glassParamsFor(THEME_DEFAULTS);
  assert.equal(p.edge, 8);
  assert.equal(p.shine, 2);
  assert.equal(p.tint, 0);
  assert.equal(p.blur, 0); // 默认 glass 6 -> max(0, 6-6)*0.32（clear 材质零模糊起步）
  assert.equal(glassParamsFor({ ...THEME_DEFAULTS, glass: 12 }).blur, 1.92); // 旧默认 glass 12 的映射保留
  assert.equal(p.refract, 32);
  assert.equal(p.depth, 0.42);
  assert.equal(p.dispersion, 0);
  assert.equal(p.wobble, 3);
  assert.equal(p.light, 0.55);
});

// ---------- 5. 幽灵块根因：scissor 安全的 clear ----------
function mockGL() {
  const calls = [];
  return {
    calls,
    SCISSOR_TEST: 0x0c11,
    COLOR_BUFFER_BIT: 0x4000,
    disable: (c) => calls.push(['disable', c]),
    enable: (c) => calls.push(['enable', c]),
    clearColor: (...a) => calls.push(['clearColor', ...a]),
    clear: (m) => calls.push(['clear', m]),
    scissor: (...a) => calls.push(['scissor', ...a]),
  };
}

function assertClearOrder(calls) {
  const idx = (name) => calls.findIndex((c) => c[0] === name);
  assert.ok(idx('disable') !== -1, 'clear 前必须 disable(SCISSOR_TEST)');
  assert.ok(idx('disable') < idx('clear'), 'disable 必须在 clear 之前');
  assert.ok(idx('enable') > idx('clear'), 'clear 后应恢复 enable(SCISSOR_TEST)');
  const s = calls.find((c) => c[0] === 'scissor');
  assert.ok(s, 'clear 后 scissor 应复位到整画布');
  assert.deepEqual(s.slice(1), [0, 0, 390, 844]);
}

test('clearGlassCanvas：clear 前 scissor 已关、clear 后复位整画布', () => {
  const gl = mockGL();
  assert.equal(LiquidGlass.clearGlassCanvas(gl, 390, 844), true);
  assertClearOrder(gl.calls);
});

test('旧顺序会失败：不清 scissor 就 clear（幽灵块的根因）', () => {
  // 旧 draw() 的顺序：viewport → clearColor → clear（scissor 仍是上一帧最后一个元素的矩形）
  const legacyCalls = [['clearColor', 0, 0, 0, 0], ['clear', 0x4000]];
  assert.throws(() => assertClearOrder(legacyCalls), /clear 前必须 disable/);
});

// ---------- 6. 按组件分别调强度 ----------
const fakeEl = (...classes) => ({ classList: { contains: (n) => classes.includes(n) } });

test('classifyGlassElement：按 class + 气泡高度分类', () => {
  const c = LiquidGlass.classifyGlassElement;
  assert.equal(c(fakeEl('bubble'), 45), 'bubble-single');
  assert.equal(c(fakeEl('bubble'), 59), 'bubble-single');
  assert.equal(c(fakeEl('bubble'), 60), 'bubble-multi');
  assert.equal(c(fakeEl('bubble'), 120), 'bubble-multi');
  assert.equal(c(fakeEl('chip')), 'chip');
  assert.equal(c(fakeEl('pill')), 'pill');
  assert.equal(c(fakeEl('tabbar')), 'tabbar');
  assert.equal(c(fakeEl('chat-head')), 'topbar');
  assert.equal(c(fakeEl('input-shell')), 'input');
  assert.equal(c(fakeEl('status-strip')), 'strip');
  assert.equal(c(fakeEl('sheet-card')), 'sheet');
  assert.equal(c(fakeEl('status-sheet')), 'sheet');
  assert.equal(c(fakeEl('modal-card')), 'sheet');
  assert.equal(c(fakeEl('char-card')), 'card');
  assert.equal(c(fakeEl('group')), 'card');
  assert.equal(c(fakeEl('post')), 'card');
  assert.equal(c(fakeEl('sub-head')), 'sub-head');
  assert.equal(c(fakeEl('m-ico')), 'small');
  assert.equal(c(fakeEl('glass')), 'default');
});

test('GLASS_INTENSITY：单行气泡最轻，顶栏/弹窗/卡片依次加重', () => {
  const k = LiquidGlass.GLASS_INTENSITY;
  assert.ok(k['bubble-single'].refract < k['bubble-multi'].refract, '单行气泡折射应轻于多行');
  assert.ok(k['bubble-multi'].refract < k.sheet.refract, '气泡折射应轻于弹窗');
  assert.ok(k['bubble-single'].blur < k.topbar.blur, '单行气泡模糊应轻于顶栏');
  assert.ok(k.chip.refract < k.tabbar.refract, 'chip 应轻于底栏');
  assert.ok(k.sheet.refract <= 1 && k.sheet.edge <= 1, '乘子不超过 1');
  for (const [name, v] of Object.entries(k)) {
    for (const f of ['refract', 'blur', 'edge', 'shine', 'wobble', 'depth']) {
      assert.ok(v[f] > 0 && v[f] <= 1, `${name}.${f} 应在 (0,1] 内，实测 ${v[f]}`);
    }
  }
});

// ---------- 4 & 7. 蒙层烘焙与 tone 推导（纯函数） ----------
test('averageLuminanceFromData：黑/白/中灰像素', () => {
  assert.ok(approx(averageLuminanceFromData(new Uint8ClampedArray([255, 255, 255, 255])), 1));
  assert.ok(approx(averageLuminanceFromData(new Uint8ClampedArray([0, 0, 0, 255])), 0));
  assert.ok(approx(averageLuminanceFromData(new Uint8ClampedArray([128, 128, 128, 255])), 128 / 255));
  assert.equal(averageLuminanceFromData(new Uint8ClampedArray(0)), 0.5);
});

test('deriveTone：三张实测壁纸 + 预设底色 + 深色配色', () => {
  assert.equal(TONE_LUMA_THRESHOLD, 0.5);
  assert.equal(deriveTone(0.285, false), 'dark'); // 黑白漫画线稿 wall-complex.jpg 实测 0.285
  assert.equal(deriveTone(0.094, false), 'dark'); // 深色壁纸 wall-dark.png 实测 0.094
  assert.equal(deriveTone(0.949, false), 'light'); // 浅色壁纸 wall-light.png 实测 0.949
  assert.equal(deriveTone(hexLuminance('#e9e9e9'), false), 'light'); // 预设 none 底色
  assert.equal(deriveTone(hexLuminance('#d2d2d2'), false), 'light'); // 预设 mist 底色
  assert.equal(deriveTone(hexLuminance('#3c3c3c'), false), 'dark'); // 预设 silver 底色
  assert.equal(deriveTone(hexLuminance('#181818'), false), 'dark'); // 预设 night 底色
  assert.equal(deriveTone(0.9, true), 'dark'); // 深色配色本身判暗
  assert.equal(deriveTone(null, false), 'light'); // 读不到亮度时回落到 light，不误翻转
});

test('veilBakedLuminance：烘焙后采样亮度与可见层 ::after 蒙层公式一致', () => {
  // 深 tone：0.285 盖 12% 黑 → 0.285*0.88 = 0.2508（可见层同值）
  assert.ok(approx(veilBakedLuminance(0.285, 0.12, 'dark'), 0.2508, 1e-9));
  // 浅 tone：0.91 盖 12% rgba(245,245,245) → 0.91*0.88 + 0.9608*0.12 = 0.916094
  assert.ok(approx(veilBakedLuminance(0.91, 0.12, 'light'), 0.916094, 1e-6));
  assert.ok(approx(veilBakedLuminance(0.5, 0, 'dark'), 0.5), 'veil 0 时不变');
  assert.ok(approx(veilBakedLuminance(0.5, 1, 'dark'), 0), 'veil 1 深 tone 全黑');
  assert.ok(approx(veilBakedLuminance(0.5, 1, 'light'), 245 / 255, 1e-9), 'veil 1 浅 tone 全是蒙层色');
});

test('coverTransform：与 shader tap() 一致的 cover 数学', () => {
  // 390×844 视图，880×1860 纹理：scale=max(390/880, 844/1860)=0.4538，横向微裁
  const t = coverTransform(390, 844, 880, 1860);
  assert.ok(approx(t.scale, 844 / 1860, 1e-9));
  assert.ok(approx(t.drawH, 844, 1e-9));
  assert.ok(approx(t.drawW, 880 * (844 / 1860), 1e-6));
  assert.ok(approx(t.offsetY, 0, 1e-9));
  assert.ok(t.offsetX < 0 && t.offsetX > -5, `横向应微裁，offsetX=${t.offsetX}`);
  // 同尺寸：恒等
  const id = coverTransform(390, 844, 390, 844);
  assert.ok(approx(id.scale, 1) && approx(id.offsetX, 0) && approx(id.offsetY, 0));
  // 宽图：纵向铺满、横向大裁
  const wide = coverTransform(390, 844, 1000, 500);
  assert.ok(approx(wide.scale, 844 / 500, 1e-9));
  assert.ok(approx(wide.offsetX, (390 - 1000 * (844 / 500)) / 2, 1e-6));
});

// ---------- 8. 旧偏好迁移 ----------
test('clampTheme：老用户旧值（glass 12 / veil 12 / refract 32 等）保留在新范围内', () => {
  const legacy = clampTheme({
    palette: 'pearl', bg: 'none', glass: 12, veil: 12, refract: 32,
    depth: 42, wobble: 3, dispersion: 5, light: 55, lightAngle: 224,
  });
  assert.equal(legacy.glass, 12);
  assert.equal(legacy.veil, 12);
  assert.equal(legacy.refract, 32);
  assert.equal(legacy.depth, 42);
  assert.equal(legacy.wobble, 3);
  assert.equal(legacy.dispersion, 5); // 用户自己设的色散保留
  assert.equal(legacy.themeVersion, 2);
  // 旧值映射后的实际效果：仍是同一组薄清参数
  const p = glassParamsFor(legacy);
  assert.equal(p.blur, 1.92);
  assert.equal(p.edge, 8);
  assert.equal(p.tint, 0);
});

test('clampTheme：越界旧值夹进新范围，Frost 最小值现为 0', () => {
  assert.equal(clampTheme({ glass: 40 }).glass, 34);
  assert.equal(clampTheme({ veil: 90 }).veil, 85);
  assert.equal(clampTheme({ refract: 80 }).refract, 60);
  assert.equal(clampTheme({ glass: 0 }).glass, 0);
  assert.equal(clampTheme({ glass: -3 }).glass, 0);
  assert.equal(clampTheme({ palette: 'nope' }).palette, 'pearl');
});
