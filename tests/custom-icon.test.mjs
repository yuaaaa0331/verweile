import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIconFile, computeCropRect, validateAppName, exportIconPack,
  previewSpecs, buildCustomIconRecord, restoreDefaultIcon,
  ICON_SIZES, CUSTOM_ICON_HONESTY, DEFAULT_APP_NAME,
} from '../js/customIcon.js';

function stubCanvasFactory() {
  const calls = [];
  return {
    calls,
    factory(size) {
      const canvas = { width: size, height: size, toDataURL: () => `data:image/png;base64,${size}` };
      const ctx = { drawImage: (...args) => calls.push({ size, args }) };
      return { canvas, ctx };
    },
  };
}

test('图标尺寸：导出包含 180 / 192 / 512 / 512 maskable 四档', () => {
  assert.deepEqual(ICON_SIZES.map((s) => `${s.size}:${s.purpose}`), ['180:apple-touch-icon', '192:any', '512:any', '512:maskable']);
  const { factory, calls } = stubCanvasFactory();
  const r = exportIconPack(factory, { width: 800, height: 600 }, 'verweile');
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 4);
  assert.deepEqual(r.files.map((f) => f.size), [180, 192, 512, 512]);
  assert.deepEqual(r.files.map((f) => f.file), ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png']);
  assert.equal(r.files[0].dataUrl, 'data:image/png;base64,180');
  // 每档都按正方形裁切绘制，不拉伸
  assert.equal(calls.length, 4);
  for (const c of calls) {
    assert.equal(c.args[3], 600); // 裁切边 = 短边
    assert.equal(c.args[4], 600);
    assert.equal(c.args[5], 0);
    assert.equal(c.args[7], c.size);
  }
});

test('正方形裁切：取短边居中，不拉伸', () => {
  assert.deepEqual(computeCropRect(800, 600), { x: 100, y: 0, size: 600 });
  assert.deepEqual(computeCropRect(600, 800), { x: 0, y: 100, size: 600 });
  assert.deepEqual(computeCropRect(500, 500), { x: 0, y: 0, size: 500 });
  const { factory } = stubCanvasFactory();
  const r = exportIconPack(factory, { width: 400, height: 900 }, 'v');
  assert.equal(r.ok, true);
  const specs = previewSpecs({ width: 400, height: 900 });
  assert.deepEqual(specs.map((s) => s.size), [180, 192, 512]);
  assert.deepEqual(specs[0].crop, { x: 0, y: 250, size: 400 });
});

test('上传校验：类型与 5MB 上限', () => {
  assert.equal(validateIconFile({ type: 'image/png', size: 1024 }).ok, true);
  assert.equal(validateIconFile({ type: 'image/webp', size: 1024 }).ok, true);
  assert.equal(validateIconFile({ type: 'image/gif', size: 1024 }).ok, false);
  assert.equal(validateIconFile({ type: 'image/png', size: 6 * 1024 * 1024 }).ok, false);
  assert.equal(validateIconFile(null).ok, false);
});

test('应用名称：空名拒绝，超长拒绝', () => {
  assert.equal(validateAppName('verweile').ok, true);
  assert.equal(validateAppName('  verweile  ').name, 'verweile');
  assert.equal(validateAppName('').ok, false);
  assert.equal(validateAppName('a'.repeat(31)).ok, false);
  const { factory } = stubCanvasFactory();
  assert.equal(exportIconPack(factory, { width: 100, height: 100 }, '').ok, false);
  assert.equal(exportIconPack(factory, null, 'v').ok, false);
});

test('保存与恢复默认：记录形状与诚实说明', () => {
  const rec = buildCustomIconRecord({ dataUrl: 'data:image/png;base64,xx', appName: '我的 verweile' });
  assert.equal(rec.key, 'customIcon');
  assert.equal(rec.appName, '我的 verweile');
  const def = restoreDefaultIcon();
  assert.equal(def.appName, DEFAULT_APP_NAME);
  assert.equal(def.dataUrl, null);
  assert.match(CUSTOM_ICON_HONESTY, /纯前端改不了已安装的 PWA 图标/);
  assert.match(CUSTOM_ICON_HONESTY, /需要重新部署，并从主屏幕删除旧图标、重新“添加到主屏幕”/);
  assert.match(CUSTOM_ICON_HONESTY, /Safari 与主屏幕 Web App 的存储是分开的/);
});
