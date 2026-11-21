// customIcon.js — 自定义主屏幕图标。
// 上传 → canvas 正方形裁切 → 180/192/512 三档预览 → 应用名称 →
// “下载图标包”导出 PNG（180 apple-touch-icon、192、512、512 maskable）。
// 源图与名称存 IndexedDB settings（键见 CUSTOM_ICON_SETTINGS_KEY，
// 图为 data URL 小图）；大图不进 settings，避免撑爆存储。
// 诚实说明（见 CUSTOM_ICON_HONESTY，界面必须原样展示）：
// 纯前端改不了已安装 PWA 图标；安装图标必须走部署文件；
// 设置后需重新部署并重新添加到主屏幕，已安装图标不会自动替换；
// Safari 与主屏幕 Web App 存储分开（图标文件走部署文件两边共用，
// 偏好设置存在各自存储里）。

export const CUSTOM_ICON_SETTINGS_KEY = 'customIcon';
export const DEFAULT_APP_NAME = 'verweile';
export const MAX_ICON_FILE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const ICON_SIZES = [
  { size: 180, purpose: 'apple-touch-icon', file: 'apple-touch-icon.png' },
  { size: 192, purpose: 'any', file: 'icon-192.png' },
  { size: 512, purpose: 'any', file: 'icon-512.png' },
  { size: 512, purpose: 'maskable', file: 'icon-512-maskable.png' },
];

export const CUSTOM_ICON_HONESTY = [
  '纯前端改不了已安装的 PWA 图标：主屏幕图标来自部署时的 manifest 与 apple-touch-icon 文件。',
  '设置新图标后，需要重新部署，并从主屏幕删除旧图标、重新“添加到主屏幕”，已安装的图标不会自动替换。',
  'Safari 与主屏幕 Web App 的存储是分开的：图标文件走部署文件两边共用，但偏好设置存在各自的存储里，',
  '在 Safari 里改的设置不会自动同步到主屏幕版，反之亦然。',
].join('');

export const ICON_REDEPLOY_TEXT =
  '图标已保存到设置。要让它成为主屏幕图标：1）重新部署；2）删除主屏幕旧图标；3）重新添加到主屏幕。';

/** 校验上传文件：类型 + 大小。返回 { ok } 或 { ok:false, reason }。 */
export function validateIconFile(file) {
  if (!file) return { ok: false, reason: '没有选择图片文件。' };
  if (!ACCEPTED_ICON_TYPES.includes(file.type)) {
    return { ok: false, reason: `不支持的图片类型：${file.type || '未知'}（支持 PNG / JPEG / WebP）。` };
  }
  if (file.size > MAX_ICON_FILE_BYTES) {
    return { ok: false, reason: `图片超过 5MB（实际 ${(file.size / 1024 / 1024).toFixed(1)}MB），请换一张小图。` };
  }
  return { ok: true };
}

/** 正方形居中裁切区域（纯函数）：取短边居中裁，不拉伸、不留白。 */
export function computeCropRect(width, height) {
  const side = Math.min(width, height);
  return { x: Math.round((width - side) / 2), y: Math.round((height - side) / 2), size: side };
}

/** 校验应用名称：1–30 字，去首尾空格。 */
export function validateAppName(name) {
  const n = String(name || '').trim();
  if (!n) return { ok: false, reason: '应用名称不能为空。' };
  if (n.length > 30) return { ok: false, reason: '应用名称最多 30 字。' };
  return { ok: true, name: n };
}

/**
 * 读 PNG 尺寸（纯函数，无依赖）：解析 PNG 文件头 IHDR（第 16–23 字节为
 * 大端宽/高）。bytes 为 Uint8Array/ArrayBuffer/普通数组均可。
 * 返回 { ok, width, height } 或 { ok:false, reason }。
 */
export function readPngSize(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || !PNG_SIG.every((v, i) => b[i] === v)) {
    return { ok: false, reason: '不是有效的 PNG 文件。' };
  }
  const width = (b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19];
  const height = (b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23];
  if (!width || !height) return { ok: false, reason: 'PNG 尺寸读取失败。' };
  return { ok: true, width, height };
}

/**
 * 校验一张导出的图标 PNG：须为正方形、边长达到要求。
 * 返回 { ok } 或 { ok:false, reason }。
 */
export function validateIconPng(bytes, { minSize = 180 } = {}) {
  const size = readPngSize(bytes);
  if (!size.ok) return size;
  if (size.width !== size.height) {
    return { ok: false, reason: `图标须为正方形（实际 ${size.width}×${size.height}）。` };
  }
  if (size.width < minSize) {
    return { ok: false, reason: `图标边长至少 ${minSize}px（实际 ${size.width}px）。` };
  }
  return { ok: true, width: size.width, height: size.height };
}

/** 校验整套图标包（{ file: bytes }）：每档按 ICON_SIZES 的边长校验。 */
export function validateIconPackFiles(filesByName) {
  const errors = [];
  for (const { file, size } of ICON_SIZES) {
    const bytes = filesByName?.[file];
    if (!bytes) { errors.push(`缺少 ${file}`); continue; }
    const r = validateIconPng(bytes, { minSize: size });
    if (!r.ok) errors.push(`${file}：${r.reason}`);
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 导出图标包。canvasFactory(size) 须返回 { canvas, ctx, toDataURL(type) }，
 * 其中 ctx.drawImage(source, sx, sy, s, s, 0, 0, size, size) 由调用方
 * 的 canvas 实现提供；source 为已加载的 Image/位图（{ width, height }）。
 * 返回 [{ size, purpose, file, dataUrl }]。Node 测试用 stub canvas。
 */
export function exportIconPack(canvasFactory, sourceImage, appName = DEFAULT_APP_NAME) {
  if (!sourceImage || !Number.isFinite(sourceImage.width) || !Number.isFinite(sourceImage.height)) {
    return { ok: false, reason: '没有可用的源图。' };
  }
  const nameCheck = validateAppName(appName);
  if (!nameCheck.ok) return nameCheck;
  const crop = computeCropRect(sourceImage.width, sourceImage.height);
  const files = ICON_SIZES.map(({ size, purpose, file }) => {
    const { canvas, ctx } = canvasFactory(size);
    ctx.drawImage(sourceImage, crop.x, crop.y, crop.size, crop.size, 0, 0, size, size);
    return { size, purpose, file, dataUrl: canvas.toDataURL('image/png') };
  });
  return { ok: true, appName: nameCheck.name, files };
}

/** 三档预览用的裁切描述子（集成方按此画 <canvas> 预览）。 */
export function previewSpecs(sourceImage) {
  if (!sourceImage) return [];
  const crop = computeCropRect(sourceImage.width, sourceImage.height);
  return [180, 192, 512].map((size) => ({ size, crop }));
}

/** settings 里存的自定义图标记录形状。 */
export function buildCustomIconRecord({ dataUrl, appName, updatedAt = Date.now() }) {
  return { key: CUSTOM_ICON_SETTINGS_KEY, appName: validateAppName(appName).name || DEFAULT_APP_NAME, dataUrl, updatedAt };
}

export function restoreDefaultIcon() {
  return { key: CUSTOM_ICON_SETTINGS_KEY, appName: DEFAULT_APP_NAME, dataUrl: null, updatedAt: Date.now() };
}

/**
 * 设置区渲染（由总协调员接进 app.js 设置页）。
 * deps：{ settings（{ appName, dataUrl }）, onSave(record), onExportPack(),
 *         onRestore(), toast? }。文件选择与 canvas 裁切由集成方按
 * exportIconPack / previewSpecs 实现，本函数只渲染界面与按钮。
 */
export function renderIconSettingsSection(container, deps = {}) {
  const s = deps.settings || {};
  const appName = s.appName || DEFAULT_APP_NAME;
  const html = `
      <h3>主屏幕图标</h3>
      <p class="muted b-honesty">${CUSTOM_ICON_HONESTY}</p>
      <div class="field"><label>上传图标图片</label><input type="file" id="icon-file" accept="image/png,image/jpeg,image/webp"><div class="hint">支持 PNG / JPEG / WebP，5MB 以内；自动居中正方形裁切，不拉伸。</div></div>
      <div id="icon-preview" class="icon-preview-row">${s.dataUrl ? `<img src="${s.dataUrl}" alt="当前图标预览" width="72" height="72">` : '<p class="muted">未上传自定义图标，当前使用默认图标。</p>'}</div>
      <div class="field"><label>应用名称（主屏幕下显示的名字）</label><input type="text" id="icon-appname" value="${String(appName).replace(/"/g, '&quot;')}" maxlength="30"><div class="hint">1–30 字。</div></div>
      <div class="actions-row">
        <button class="primary" id="icon-save">保存图标设置</button>
        <button id="icon-export">下载图标包（180 / 192 / 512 / maskable）</button>
        <button id="icon-restore">恢复默认</button>
      </div>
      <p class="muted">${ICON_REDEPLOY_TEXT}</p>`;
  if (container) container.innerHTML = html;
  const q = (id) => container?.querySelector?.(`#${id}`);
  q('icon-save')?.addEventListener?.('click', async () => {
    const nameCheck = validateAppName(q('icon-appname')?.value ?? appName);
    if (!nameCheck.ok) { deps.toast?.(nameCheck.reason); return; }
    await deps.onSave?.(buildCustomIconRecord({ dataUrl: s.dataUrl || null, appName: nameCheck.name }));
    deps.toast?.(ICON_REDEPLOY_TEXT);
  });
  q('icon-export')?.addEventListener?.('click', async () => {
    const r = await deps.onExportPack?.();
    if (r && !r.ok) deps.toast?.(r.reason || '导出失败');
  });
  q('icon-restore')?.addEventListener?.('click', async () => {
    await deps.onSave?.(restoreDefaultIcon());
    deps.toast?.('已恢复默认图标（已安装的图标仍需重新部署并重新添加才会变）');
  });
  return html;
}
