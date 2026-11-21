// theme.js — 外观主题（背景 / 文字与气泡配色 / 玻璃材质参数）。
// 按原型 uwu-liao-tian-ui-yuan-xing 移植，Clear 材质默认值：
// 光源强度 55%、雾化 6px、遮罩 12%、折射 32、深度 42、色散 0、波动 3。
// 主题只存在 IndexedDB 的 settings 表（key 'appearance'），是本机偏好，
// 不进备份导出、不随备份导入；不改动任何聊天数据结构。
// 预设背景是 Canvas 渐变纹理（原型照片资产不在源码里），上传自己的图走 dataURL。
import { LiquidGlass } from './liquidGlass.js';

/** 气泡文字色自动适配：底色亮于阈值用深字，否则用浅字（原型 contrastInk）。 */
export function contrastInk(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return lum > 0.62 ? '#303030' : '#f7f7f7';
}

export function hexA(hex, a) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${a})`;
}

/** hex 颜色的相对亮度（0–1），用于 tone 推导与 ink 翻转判断。 */
export function hexLuminance(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** data-tone 明暗分界：平均亮度低于 0.5 判暗。实测：深色壁纸 0.094、黑白漫画线稿 0.285、
 * 浅色壁纸 0.949、预设 none #e9e9e9 约 0.91、night #181818 约 0.09——0.5 能干净分开。 */
export const TONE_LUMA_THRESHOLD = 0.5;

/** 按壁纸实际平均亮度（不要只看调色板）决定 tone；深色配色本身也判暗。 */
export function deriveTone(luma, paletteDark) {
  return paletteDark || (typeof luma === 'number' && luma < TONE_LUMA_THRESHOLD) ? 'dark' : 'light';
}

/** RGBA 像素数组的平均亮度（0–1），与 deriveTone / 蒙层烘焙共用同一公式。 */
export function averageLuminanceFromData(data) {
  if (!data || !data.length) return 0.5;
  let sum = 0;
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / n / 255;
}

/** 蒙层烘焙后的采样亮度：与可见层 .bg-layer::after 同一条 overlay 公式
 *（浅 tone 盖 rgba(245,245,245,veil)，深 tone 盖 rgba(0,0,0,veil)）。 */
export function veilBakedLuminance(luma, veil, tone) {
  const v = Math.min(1, Math.max(0, veil));
  return tone === 'dark' ? luma * (1 - v) : luma * (1 - v) + (245 / 255) * v;
}

/** cover 数学（与 liquidGlass.js shader tap() 一致）：背景以 cover 铺满视图时
 * 的缩放与偏移，用于烘焙画布的绘制与单测。 */
export function coverTransform(viewW, viewH, imgW, imgH) {
  const scale = Math.max(viewW / imgW, viewH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  return { scale, drawW, drawH, offsetX: (viewW - drawW) / 2, offsetY: (viewH - drawH) / 2 };
}

export const PALETTES = {
  pearl: { name: '冷白', note: 'PEARL', ink: '#292929', me: '#dddddd', ai: '#ffffff', bg: 'none', dark: false },
  mist: { name: '雾灰', note: 'MIST', ink: '#303030', me: '#c6c6c6', ai: '#eeeeee', bg: 'mist', dark: false },
  silver: { name: '银黑', note: 'SILVER', ink: '#eeeeee', me: '#555555', ai: '#363636', bg: 'silver', dark: true },
  night: { name: '深黑', note: 'NOIR', ink: '#f0f0f0', me: '#383838', ai: '#242424', bg: 'night', dark: true },
};
export const THEME_DEFAULTS = {
  palette: 'pearl', bubbleStyle: 'liquid', bubbleGlass: false, bg: 'none', bgCustom: null, veil: 12, glass: 6,
  refract: 32, wobble: 3, depth: 42, dispersion: 0,
  lightAngle: 224, light: 55,
  ink: '#292929', me: '#dddddd', ai: '#ffffff',
};
export const INK_SWATCHES = ['#292929', '#505050', '#777777', '#d6d6d6', '#f2f2f2'];
export const ME_SWATCHES = ['#ffffff', '#e8e8e8', '#cccccc', '#9c9c9c', '#575757', '#292929'];
export const AI_SWATCHES = ['#ffffff', '#f1f1f1', '#e1e1e1', '#a6a6a6', '#555555', '#242424'];

/** 主题 → 引擎参数的映射（原型 applyGlassParams；edge/shine/tint 固定为薄清值）。 */
export function glassParamsFor(t) {
  return {
    refract: t.refract,
    blur: Math.max(0, t.glass - 6) * 0.32,
    edge: 8, shine: 2, tint: 0,
    lightAngle: ((t.lightAngle + 180) % 360 - 180) * Math.PI / 180,
    light: t.light / 100,
    dispersion: t.dispersion,
    depth: t.depth / 100,
    wobble: t.wobble,
  };
}

// 预设背景：CSS 渐变（.bg-layer 用）+ Canvas 纹理（玻璃采样用）。
const BG_PRESETS = {
  none: { name: '冷白柔光', texture: { base: '#e9e9e9', blobs: [[.1,.2,.9,'rgba(255, 255, 255,.9)'],[.95,.5,.75,'rgba(151, 151, 151,.30)'],[.3,.85,.6,'rgba(255, 255, 255,.8)']] } },
  mist: { name: '雾灰光影', texture: { base: '#d2d2d2', blobs: [[.2,.1,.8,'rgba(255, 255, 255,.7)'],[1,.6,.8,'rgba(111, 111, 111,.25)']] } },
  silver: { name: '银黑微光', texture: { base: '#3c3c3c', blobs: [[.2,.2,.9,'rgba(158, 158, 158,.42)'],[.9,.8,.6,'rgba(8, 8, 8,.6)']] } },
  night: { name: '深黑月光', texture: { base: '#181818', blobs: [[.1,.15,.85,'rgba(111, 111, 111,.26)'],[.9,.7,.9,'rgba(0, 0, 0,.9)']] } },
  // Legacy background IDs remain valid for saved preferences, now monochrome.
  sky: { name: '白昼', texture: { base: '#e8e8e8', blobs: [[.5,.3,.9,'rgba(255, 255, 255,.7)']] } },
  garden: { name: '细雨', texture: { base: '#d7d7d7', blobs: [[.1,.5,.9,'rgba(255, 255, 255,.6)']] } },
  room: { name: '薄暮', texture: { base: '#c9c9c9', blobs: [[.6,.3,.9,'rgba(255, 255, 255,.6)']] } },
};

const SLIDERS = [
  { key: 'veil', label: '背景柔和', min: 0, max: 85, step: 1, unit: '%' },
  { key: 'glass', label: '雾化 Frost', min: 0, max: 34, step: 1, unit: 'px' },
  { key: 'refract', label: '折射', min: 0, max: 60, step: 1, unit: '' },
  { key: 'depth', label: '深度 Depth', min: 0, max: 100, step: 1, unit: '' },
  { key: 'dispersion', label: '色散 Dispersion', min: 0, max: 30, step: 1, unit: '' },
  { key: 'lightAngle', label: '光源角度', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'light', label: '光源强度', min: 20, max: 160, step: 1, unit: '%' },
  { key: 'wobble', label: '内部波动', min: 0, max: 40, step: 1, unit: '' },
];

/** 旧偏好迁移 + 越界夹取（纯函数，可单测）。
 * 已存值（glass 12 / veil 12 / refract 32 / depth 42 / wobble 3 等）都在新范围
 *（Frost 最小值现为 0）内，直接保留、不重置为默认——老用户升级后不回厚白；
 * 只把越界旧值夹进新范围，并打 themeVersion: 2 标记已迁移。 */
export function clampTheme(t) {
  const out = { ...THEME_DEFAULTS, ...(t || {}) };
  if (!PALETTES[out.palette]) out.palette = 'pearl';
  if (!['liquid', 'soft', 'ink'].includes(out.bubbleStyle)) out.bubbleStyle = 'liquid';
  // 液态玻璃气泡开关（接线轮新增）：默认关闭 = iMessage 式清晰材质；
  // 开启时 #app 加 .bubble-glass，气泡改走轻薄玻璃样式（见 styles.css）。
  out.bubbleGlass = out.bubbleGlass === true;
  for (const s of SLIDERS) {
    const v = Number(out[s.key]);
    out[s.key] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : THEME_DEFAULTS[s.key];
  }
  if (!BG_PRESETS[out.bg] && out.bg !== 'custom') out.bg = 'none';
  if (out.bg === 'custom' && !out.bgCustom) out.bg = 'none';
  for (const k of ['ink', 'me', 'ai']) {
    if (typeof out[k] !== 'string' || !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(out[k])) out[k] = THEME_DEFAULTS[k];
  }
  out.themeVersion = 2;
  return out;
}

export const ThemeStore = (() => {
  let theme = { ...THEME_DEFAULTS };
  let backend = null;
  let saveTimer = null;
  const textureCache = new Map();
  let customImage = null;
  // 已烘焙蒙层的采样纹理缓存（key 含背景 / 自定义图版本 / 蒙层 / tone）；tone 由 applyVars 推导后存这里。
  const bakedCache = new Map();
  let customRev = 0;
  let derivedTone = 'light';

  function makeGradientTexture(palette) {
    const canvas = document.createElement('canvas');
    canvas.width = 880;
    canvas.height = 1860;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = palette.base;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    for (const [fx, fy, fr, color] of palette.blobs) {
      const x = fx * canvas.width;
      const y = fy * canvas.height;
      const r = fr * canvas.width;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, color);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    // Broad monochrome light ribbons give the refraction a visible, quiet source.
    const dark = parseInt(palette.base.slice(1, 3), 16) < 100;
    for (let i = 0; i < 5; i++) {
      ctx.save(); ctx.translate(440, 930); ctx.rotate(-.38); ctx.translate(-440, -930);
      const x = 40 + i * 235;
      const ribbon = ctx.createLinearGradient(x, 0, x + 180, 0);
      ribbon.addColorStop(0, 'rgba(255,255,255,0)');
      ribbon.addColorStop(.65, dark ? 'rgba(220,220,225,.055)' : 'rgba(255,255,255,.30)');
      ribbon.addColorStop(.8, dark ? 'rgba(0,0,0,.05)' : 'rgba(110,110,120,.045)');
      ribbon.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = ribbon; ctx.fillRect(x, -1000, 180, 4000); ctx.restore();
    }
    return canvas;
  }

  function textureForBackground() {
    if (theme.bg === 'custom' && customImage) return customImage;
    const preset = BG_PRESETS[theme.bg] || BG_PRESETS.none;
    const key = theme.bg;
    if (!textureCache.has(key)) textureCache.set(key, makeGradientTexture(preset.texture));
    return textureCache.get(key);
  }

  /** 背景源（预设渐变画布或自定义图）采样到 ≤64px 的平均亮度；读不到返回 null。 */
  function luminanceOfSource(source) {
    try {
      const w = source.naturalWidth || source.width;
      const h = source.naturalHeight || source.height;
      if (!w || !h) return null;
      const tw = 64;
      const th = Math.max(1, Math.round(64 * h / w));
      const c = document.createElement('canvas');
      c.width = tw; c.height = th;
      const ctx = c.getContext('2d');
      ctx.drawImage(source, 0, 0, tw, th);
      return averageLuminanceFromData(ctx.getImageData(0, 0, tw, th).data);
    } catch {
      return null;
    }
  }

  function currentBackgroundLuminance() {
    return luminanceOfSource(textureForBackground());
  }

  /** 把当前蒙层烘进一张 880×1860 画布（cover 绘制 + overlay），供引擎采样；
   * 可见层仍用未烘焙的原图 + CSS ::after 蒙层，两边亮度一致。 */
  function bakeVeilCanvas(source, veil, tone) {
    const canvas = document.createElement('canvas');
    canvas.width = 880;
    canvas.height = 1860;
    const ctx = canvas.getContext('2d');
    const sw = source.naturalWidth || source.width;
    const sh = source.naturalHeight || source.height;
    if (sw && sh) {
      const t = coverTransform(880, 1860, sw, sh);
      ctx.drawImage(source, t.offsetX, t.offsetY, t.drawW, t.drawH);
    }
    if (veil > 0) {
      ctx.fillStyle = tone === 'dark' ? `rgba(0, 0, 0, ${veil})` : `rgba(245, 245, 245, ${veil})`;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    return canvas;
  }

  /** 引擎采样纹理：已烘焙蒙层。背景 / 蒙层 / tone / 自定义图变化时重烘（key 包含四者）。 */
  function sampleTextureForBackground() {
    const veil = theme.veil / 100;
    const key = `${theme.bg}|${theme.bg === 'custom' ? customRev : ''}|${veil}|${derivedTone}`;
    if (!bakedCache.has(key)) {
      if (bakedCache.size > 12) bakedCache.clear();
      bakedCache.set(key, bakeVeilCanvas(textureForBackground(), veil, derivedTone));
    }
    return bakedCache.get(key);
  }

  function applyBackground() {
    const app = document.getElementById('app');
    const layer = document.getElementById('bg-layer');
    if (!app || !layer) return;
    app.classList.add('has-bg');
    if (theme.bg === 'custom' && theme.bgCustom) {
      layer.style.backgroundImage = `url(${JSON.stringify(theme.bgCustom)})`;
    } else {
      layer.style.backgroundImage = `url(${textureForBackground().toDataURL()})`;
    }
    LiquidGlass.setBackground(sampleTextureForBackground());
  }

  function applyVars() {
    const root = document.documentElement.style;
    root.setProperty('--bg-veil', String(theme.veil / 100));
    root.setProperty('--glass-blur-amt', `${theme.glass}px`);
    // tone 按壁纸实际平均亮度推导（不是只看调色板）：默认 pearl + 深色壁纸时翻转为 dark，
    // 这样 styles.css 已有的 [data-tone=dark] 规则（--ink-2/--ink-3 等浅色）才会生效。
    // data-tone 挂在 documentElement 上，正是 styles.css [data-tone=dark] 规则所期望的元素。
    const paletteDark = !!PALETTES[theme.palette]?.dark;
    const bgLuma = currentBackgroundLuminance();
    derivedTone = deriveTone(bgLuma, paletteDark);
    // --ink 是唯一不在 [data-tone=dark] CSS 规则里的主文字色：dark tone 且 ink 本身深时翻成浅色；
    // 深色配色自带的浅 ink 不动。--ink-2/--ink-3（.top-status、chip 文字、.char-card-sub、
    // .m-desc/.m-count、.tab 未选中、placeholder、.auto-row、.toggle-t、.time-divider/.msg-meta、
    // .brand-caption）走 CSS 的 dark 规则翻转。
    const inkIsDark = hexLuminance(theme.ink) < 0.5;
    root.setProperty('--ink', derivedTone === 'dark' && inkIsDark ? '#f0f0f0' : theme.ink);
    document.documentElement.dataset.palette = theme.palette;
    document.documentElement.dataset.bubbleStyle = theme.bubbleStyle;
    document.documentElement.dataset.tone = derivedTone;
    document.documentElement.dataset.chatWallpaper = theme.bg === 'none' ? 'plain' : 'image';
    // Opaque chat colors respect custom swatches; standard palettes use monochrome iMessage values.
    const preset = PALETTES[theme.palette] || PALETTES.pearl;
    const chatMe = theme.me !== preset.me ? theme.me : derivedTone === 'dark' ? '#dedee0' : theme.palette === 'mist' ? '#565658' : '#3a3a3c';
    const chatAi = theme.ai !== preset.ai ? theme.ai : derivedTone === 'dark' ? '#303032' : theme.palette === 'mist' ? '#dedee1' : '#e9e9eb';
    root.setProperty('--chat-sent', chatMe);
    root.setProperty('--chat-received', chatAi);
    root.setProperty('--chat-sent-ink', contrastInk(chatMe));
    root.setProperty('--chat-received-ink', contrastInk(chatAi));
    root.setProperty('--bubble-me-solid', theme.me);
    root.setProperty('--bubble-ai-solid', theme.ai);
    root.setProperty('--bubble-me', hexA(theme.me, theme.bubbleStyle === 'liquid' ? .35 : .94));
    // blend 的底色是气泡背后实际看到的颜色：深 tone 时按深底算——
    // 哪怕配色本身是 pearl（浅底 #eeeeee），深色壁纸推导出的 dark tone
    // 下气泡背后也是深色壁纸，blend 仍按浅底算会把气泡字误判成深字
    // （pearl + 深色壁纸时 AI 气泡字曾是 #303030，糊在深色壁纸上）。
    // 只改 blend 的 backdrop 假设，不覆盖 --bubble-*-ink 本身：
    // soft/ink 样式（alpha .92/.94，blend 几乎不起作用）与用户自定义色
    // 仍走同一条 contrastInk 路径。
    const background = derivedTone === 'dark' ? '#292929'
      : (PALETTES[theme.palette]?.dark ? '#292929' : '#eeeeee');
    const blend = (hex, alpha) => {
      let h = hex.slice(1); if (h.length === 3) h = [...h].map(c => c + c).join('');
      return '#' + [0, 2, 4].map(i => Math.round(parseInt(h.slice(i, i + 2), 16) * alpha + parseInt(background.slice(i + 1, i + 3), 16) * (1 - alpha)).toString(16).padStart(2, '0')).join('');
    };
    root.setProperty('--bubble-me-ink', contrastInk(blend(theme.me, theme.bubbleStyle === 'liquid' ? .35 : .94)));
    root.setProperty('--bubble-ai', hexA(theme.ai, theme.bubbleStyle === 'liquid' ? .22 : .92));
    root.setProperty('--bubble-ai-ink', contrastInk(blend(theme.ai, theme.bubbleStyle === 'liquid' ? .22 : .92)));
  }

  function apply() {
    applyVars();
    applyBackground();
    // 气泡玻璃开关立即生效，不用刷新：开关状态挂在 #app 的 class 上，
    // styles.css 里 #app.bubble-glass .bubble 覆盖默认清晰材质。
    document.getElementById('app')?.classList.toggle('bubble-glass', theme.bubbleGlass === true);
    LiquidGlass.setParams(glassParamsFor(theme));
  }

  function save() {
    if (!backend) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      backend.put('settings', { key: 'appearance', value: { ...theme } }).catch(() => {});
    }, 300);
  }

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function sliderRow(def) {
    const row = el('div', 'slider-row');
    const head = el('div', 'slider-head');
    head.appendChild(el('span', '', def.label));
    const val = el('span', 'slider-val', `${theme[def.key]}${def.unit}`);
    head.appendChild(val);
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(theme[def.key]);
    input.setAttribute('aria-label', def.label);
    input.addEventListener('input', () => {
      update({ [def.key]: Number(input.value) });
      val.textContent = `${input.value}${def.unit}`;
    });
    row.append(head, input);
    return row;
  }

  function colorRow(label, key, swatches) {
    const box = el('div', 'color-row');
    box.appendChild(el('div', 'color-label', label));
    const row = el('div', 'swatch-row');
    for (const c of swatches) {
      const b = el('button', 'swatch' + (theme[key] === c ? ' active' : ''));
      b.style.background = c;
      b.setAttribute('aria-label', `${label} ${c}`);
      b.addEventListener('click', () => {
        update({ [key]: c });
        renderAppearanceInto(currentContainer);
      });
      row.appendChild(b);
    }
    const picker = document.createElement('input');
    picker.type = 'color';
    picker.className = 'color-picker';
    picker.value = theme[key];
    picker.setAttribute('aria-label', `${label}自定义`);
    picker.addEventListener('input', () => update({ [key]: picker.value }));
    row.appendChild(picker);
    box.appendChild(row);
    return box;
  }

  let currentContainer = null;

  function renderAppearanceInto(container) {
    if (!container) return;
    currentContainer = container;
    container.innerHTML = '';
    const intro = el('p', 'muted', '背景、文字与气泡颜色、玻璃材质都在这里调，改完立即生效并自动保存到本机。');
    container.appendChild(intro);
    const presetsCard = el('div', 'card palette-card');
    presetsCard.appendChild(el('h3', '', '黑白之间'));
    presetsCard.appendChild(el('p', 'muted', '选择整套配色，气泡也可以单独调整。'));
    const palettes = el('div', 'palette-grid');
    for (const [id, p] of Object.entries(PALETTES)) {
      const button = el('button', 'palette-option' + (theme.palette === id ? ' active' : ''));
      button.setAttribute('aria-pressed', String(theme.palette === id));
      const sample = el('span', 'palette-sample'); sample.dataset.tone = id;
      sample.appendChild(el('i')); sample.appendChild(el('i'));
      button.append(sample, el('span', '', p.name), el('small', '', p.note));
      button.addEventListener('click', () => { update({ palette: id, bg: p.bg, ink: p.ink, me: p.me, ai: p.ai, bgCustom: null }); renderAppearanceInto(container); });
      palettes.appendChild(button);
    }
    presetsCard.appendChild(palettes);
    const styles = el('div', 'bubble-options');
    for (const [id, name] of [['liquid', '轻透'], ['soft', '柔雾'], ['ink', '墨色']]) {
      const b = el('button', theme.bubbleStyle === id ? 'active' : '', name);
      b.setAttribute('aria-pressed', String(theme.bubbleStyle === id));
      b.addEventListener('click', () => { update({ bubbleStyle: id }); renderAppearanceInto(container); }); styles.appendChild(b);
    }
    presetsCard.append(el('h3', '', '玻璃气泡外观'), styles);
    // 液态玻璃气泡开关（默认关闭 = iMessage 式清晰材质；开启为可选的轻薄玻璃样式）。
    const glassRow = el('div', 'setting-row');
    const glassLabel = el('span', 'setting-label', '液态玻璃气泡');
    glassLabel.appendChild(el('small', '', '可选样式'));
    const glassToggle = el('label', 'switch');
    const glassBox = document.createElement('input');
    glassBox.type = 'checkbox';
    glassBox.checked = theme.bubbleGlass === true;
    glassBox.addEventListener('change', () => { update({ bubbleGlass: glassBox.checked }); });
    glassToggle.append(glassBox, el('span', 'switch-track'));
    glassRow.append(glassLabel, glassToggle);
    presetsCard.append(glassRow, el('p', 'muted', '关闭时使用 iMessage 实色气泡；开启后使用轻薄玻璃，上方三种外观随之生效。'));
    const sample = el('div', 'bubble-preview');
    sample.append(el('span', 'preview-in', '在这里，多停留一会儿。'), el('span', 'preview-out', 'Take your time.'));
    presetsCard.appendChild(sample); container.appendChild(presetsCard);

    const bgCard = el('div', 'card');
    bgCard.appendChild(el('h3', '', '背景图'));
    const bgGrid = el('div', 'bg-grid');
    for (const id of Object.keys(BG_PRESETS)) {
      const b = el('button', 'bg-preset' + (theme.bg === id ? ' active' : ''));
      b.textContent = BG_PRESETS[id].name;
      b.addEventListener('click', () => {
        update({ bg: id });
        renderAppearanceInto(container);
      });
      bgGrid.appendChild(b);
    }
    const uploadBtn = el('button', 'bg-preset', '从相册上传…');
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.className = 'file-input-hidden';
    fileInput.addEventListener('change', () => {
      const f = fileInput.files?.[0];
      fileInput.value = '';
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result || '');
        const img = new Image();
        img.onload = () => {
          customImage = img;
          customRev++;
          update({ bg: 'custom', bgCustom: dataUrl });
          renderAppearanceInto(container);
        };
        img.onerror = () => {};
        img.src = dataUrl;
      };
      reader.readAsDataURL(f);
    });
    uploadBtn.addEventListener('click', () => fileInput.click());
    bgGrid.append(uploadBtn, fileInput);
    bgCard.appendChild(bgGrid);
    container.appendChild(bgCard);

    const colorCard = el('div', 'card');
    colorCard.appendChild(el('h3', '', '文字与气泡'));
    colorCard.appendChild(colorRow('全局文字', 'ink', INK_SWATCHES));
    colorCard.appendChild(colorRow('我方气泡', 'me', ME_SWATCHES));
    colorCard.appendChild(colorRow('对方气泡', 'ai', AI_SWATCHES));
    colorCard.appendChild(el('p', 'muted', '气泡里的文字颜色会按底色明暗自动适配，不用手动调。'));
    container.appendChild(colorCard);

    const glassCard = el('div', 'card');
    glassCard.appendChild(el('h3', '', '玻璃材质'));
    for (const s of SLIDERS) glassCard.appendChild(sliderRow(s));
    glassCard.appendChild(el('p', 'muted', '折射采样来自当前背景。色散默认为 0，保持纯净的黑白灰；可按喜好调节。'));
    container.appendChild(glassCard);

    const actions = el('div', 'actions-row');
    const resetBtn = el('button', '', '恢复默认外观');
    resetBtn.addEventListener('click', () => {
      reset();
      renderAppearanceInto(container);
    });
    actions.appendChild(resetBtn);
    container.appendChild(actions);
  }

  function update(patch) {
    theme = clampTheme({ ...theme, ...patch });
    apply();
    save();
  }

  function reset() {
    theme = { ...THEME_DEFAULTS };
    customImage = null;
    apply();
    save();
  }

  return {
    getTheme() { return { ...theme }; },
    getDefaults() { return { ...THEME_DEFAULTS }; },
    BG_PRESETS,
    SLIDERS,
    clampTheme,

    /** backend：IndexedDB 后端（持久化用）；saved：之前存过的 appearance 记录。 */
    init(be, saved) {
      backend = be || null;
      theme = clampTheme(saved || {});
      if (theme.bg === 'custom' && theme.bgCustom) {
        const img = new Image();
        img.onload = () => {
          customImage = img;
          customRev++;
          apply(); // 自定义图到齐后重推 tone 与蒙层烘焙
        };
        img.src = theme.bgCustom;
      }
      apply();
    },

    update,
    reset,
    apply,
    saveNow() {
      clearTimeout(saveTimer);
      if (backend) backend.put('settings', { key: 'appearance', value: { ...theme } }).catch(() => {});
    },
    renderAppearance(container) { renderAppearanceInto(container); },
  };
})();
