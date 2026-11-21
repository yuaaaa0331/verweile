// customIcon.js — 自定义主屏幕图标。
// 上传 → canvas 正方形裁切 → 180/192/512 三档预览 → 应用名称 →
// 服务端保存：512×512 白底 master 图 POST 到 /api/custom-icon，服务端存图
// 并返回版本化 URL（/api/custom-icon/icon-<时间戳>.png）；页面内
// apple-touch-icon 链接同步更新，版本存 localStorage，下次首绘前恢复。
// data URL / Blob URL 进不了 iOS 安装流程（系统层按 URL 从网络抓图标），
// 所以图标一定走服务端 URL；iOS 主杠杆是 apple-touch-icon 的版本化 link。
// “下载图标包”仍保留本地导出 PNG（180 apple-touch-icon、192、512、512 maskable）。
// 源图与名称存 IndexedDB settings（键见 CUSTOM_ICON_SETTINGS_KEY，
// 图为 data URL 小图）；大图不进 settings，避免撑爆存储。
// 诚实说明（见 CUSTOM_ICON_HONESTY，界面必须原样展示）：
// 保存后刷新页面、删除主屏幕旧图标并重新添加到主屏幕即可看到新图标；
// 已安装的旧图标不会自动变；换图不用重新部署；
// Safari 与主屏幕 Web App 存储分开（偏好设置存在各自存储里，不互通）。

export const CUSTOM_ICON_SETTINGS_KEY = 'customIcon';
export const DEFAULT_APP_NAME = 'verweile';
export const CUSTOM_ICON_API_URL = '/api/custom-icon';
export const CUSTOM_ICON_VERSION_KEY = 'verweile.customIcon.version';
export const MAX_ICON_FILE_BYTES = 5 * 1024 * 1024;
export const ACCEPTED_ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const ICON_SIZES = [
  { size: 180, purpose: 'apple-touch-icon', file: 'apple-touch-icon.png' },
  { size: 192, purpose: 'any', file: 'icon-192.png' },
  { size: 512, purpose: 'any', file: 'icon-512.png' },
  { size: 512, purpose: 'maskable', file: 'icon-512-maskable.png' },
];

export const CUSTOM_ICON_HONESTY = [
  '保存后刷新页面，再从主屏幕删除旧图标、重新“添加到主屏幕”，就能看到新图标；',
  '已安装的旧图标不会自动变，要删掉重加。换图不用重新部署。',
  '透明底图片会先烤成白底再上传（iOS 会把透明按黑色合成）。',
  'Safari 与主屏幕 Web App 的存储是分开的：偏好设置存在各自的存储里，',
  '在 Safari 里改的设置不会自动同步到主屏幕版，反之亦然。',
].join('');

export const ICON_REDEPLOY_TEXT =
  '图标已保存。刷新页面后，删除主屏幕旧图标并重新“添加到主屏幕”，就能看到新图标；换图不用重新部署。';

/** 版本化图标 URL：version 形如 `icon-<时间戳>.png`。 */
export function buildCustomIconVersionedUrl(version) {
  return `${CUSTOM_ICON_API_URL}/${version}`;
}

async function readIconErrorReason(res) {
  try {
    const data = await res.json();
    if (data && (data.reason || data.message || data.error)) return String(data.reason || data.message || data.error);
  } catch { /* 不是 JSON，走 text */ }
  try {
    const text = await res.text();
    if (text) return text.slice(0, 200);
  } catch { /* 忽略 */ }
  return `服务端返回 ${res.status}`;
}

/**
 * 上传 512×512 白底 master PNG 到服务端。成功返回 { version, url }
 *（version 形如 `icon-<时间戳>.png`，url 为版本化 URL）。
 * 失败抛错（带服务端 reason）。fetchImpl 可注入（Node 测试用 stub fetch）。
 * 注意：函数上线前服务端未部署时站内保存会 404——调用方必须 try/catch。
 */
export async function uploadCustomIcon(pngBlob, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(CUSTOM_ICON_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'image/png' },
    body: pngBlob,
  });
  if (!res.ok) throw new Error(`图标上传失败：${await readIconErrorReason(res)}`);
  const data = await res.json();
  if (!data?.version) throw new Error('图标上传失败：服务端没有返回版本号。');
  return { version: data.version, url: data.url || buildCustomIconVersionedUrl(data.version) };
}

/** 取服务端图标元信息（GET /api/custom-icon/meta）。失败抛错，调用方 try/catch。 */
export async function fetchCustomIconMeta(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${CUSTOM_ICON_API_URL}/meta`);
  if (!res.ok) throw new Error(`读取图标信息失败：${await readIconErrorReason(res)}`);
  return res.json();
}

/**
 * 更新页面内全部 apple-touch-icon 链接的 href：优先按
 * id="apple-touch-icon-link"，再补 querySelectorAll('link[rel="apple-touch-icon"]')。
 * doc 可选，默认 globalThis.document（Node 测试可注入 stub document）；
 * 页面里没有相关 link 时不抛错。
 */
export function applyCustomIconUrl(url, doc = globalThis.document) {
  if (!doc) return;
  const seen = new Set();
  const applyTo = (link) => { if (link && !seen.has(link)) { seen.add(link); link.href = url; } };
  try { applyTo(doc.getElementById?.('apple-touch-icon-link')); } catch { /* 忽略 */ }
  try {
    const links = doc.querySelectorAll?.('link[rel="apple-touch-icon"]') || [];
    for (const link of links) applyTo(link);
  } catch { /* 忽略 */ }
}

/** 删除服务端自定义图标（DELETE /api/custom-icon），返回 JSON。失败抛错。 */
export async function deleteCustomIcon(fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(CUSTOM_ICON_API_URL, { method: 'DELETE' });
  if (!res.ok) throw new Error(`删除服务端图标失败：${await readIconErrorReason(res)}`);
  try { return await res.json(); } catch { return {}; }
}

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
 *         onRestoreDefault(), toast? }。文件选择与 canvas 裁切由集成方按
 * exportIconPack / previewSpecs 实现，本函数只渲染界面与按钮。
 * onSave 负责上传服务端、提示与刷新，本函数只在 onSave 抛错时吞掉异常
 * （不补成功文案）；onRestoreDefault 未传时恢复按钮回退到 onSave(restoreDefaultIcon())。
 */
export function renderIconSettingsSection(container, deps = {}) {
  const s = deps.settings || {};
  const appName = s.appName || DEFAULT_APP_NAME;
  const html = `
      <h3>主屏幕图标</h3>
      <p class="muted b-honesty">${CUSTOM_ICON_HONESTY}</p>
      <div class="field"><label>上传图标图片</label><input type="file" id="icon-file" accept="image/png,image/jpeg,image/webp"><div class="hint">支持 PNG / JPEG / WebP，5MB 以内；自动居中正方形裁切，不拉伸。透明底图片会先烤成白底再上传（iOS 会把透明按黑色合成）。</div></div>
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
    // 提示与刷新由 onSave 自己决定（上传成功才 toast 成功文案并刷新；
    // onSave 抛错时这里不补成功文案，只吞掉异常避免未处理 rejection）。
    try {
      await deps.onSave?.(buildCustomIconRecord({ dataUrl: s.dataUrl || null, appName: nameCheck.name }));
    } catch { /* onSave 已自己 toast 报错 */ }
  });
  q('icon-export')?.addEventListener?.('click', async () => {
    const r = await deps.onExportPack?.();
    if (r && !r.ok) deps.toast?.(r.reason || '导出失败');
  });
  q('icon-restore')?.addEventListener?.('click', async () => {
    // 优先走调用方的新恢复流程（删服务端图标 + 清本地版本 + 刷新）；
    // 没传 onRestoreDefault 时回退到旧行为：只重置本地设置记录。
    if (typeof deps.onRestoreDefault === 'function') {
      try { await deps.onRestoreDefault(); } catch { /* onRestoreDefault 已自己 toast 报错 */ }
      return;
    }
    await deps.onSave?.(restoreDefaultIcon());
    deps.toast?.('已恢复默认图标（已安装的旧图标不会自动变，需要删除并重新添加到主屏幕）');
  });
  return html;
}
