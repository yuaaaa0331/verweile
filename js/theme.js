// theme.js — 外观主题（背景 / 文字与气泡配色 / 玻璃材质参数）。
// 按原型 uwu-liao-tian-ui-yuan-xing 移植，亮度修正后的默认值：
// 光源强度 55%、雾化 8px、遮罩 32%、折射 20、深度 32、色散 5、波动 8。
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

export const PALETTES = {
  pearl: { name: '冷白', note: 'PEARL', ink: '#292929', me: '#dddddd', ai: '#ffffff', bg: 'none', dark: false },
  mist: { name: '雾灰', note: 'MIST', ink: '#303030', me: '#c6c6c6', ai: '#eeeeee', bg: 'mist', dark: false },
  silver: { name: '银黑', note: 'SILVER', ink: '#eeeeee', me: '#555555', ai: '#363636', bg: 'silver', dark: true },
  night: { name: '深黑', note: 'NOIR', ink: '#f0f0f0', me: '#383838', ai: '#242424', bg: 'night', dark: true },
};
export const THEME_DEFAULTS = {
  palette: 'pearl', bubbleStyle: 'liquid', bg: 'none', bgCustom: null, veil: 12, glass: 12,
  refract: 32, wobble: 3, depth: 42, dispersion: 0,
  lightAngle: 224, light: 55,
  ink: '#292929', me: '#dddddd', ai: '#ffffff',
};
export const INK_SWATCHES = ['#292929', '#505050', '#777777', '#d6d6d6', '#f2f2f2'];
export const ME_SWATCHES = ['#ffffff', '#e8e8e8', '#cccccc', '#9c9c9c', '#575757', '#292929'];
export const AI_SWATCHES = ['#ffffff', '#f1f1f1', '#e1e1e1', '#a6a6a6', '#555555', '#242424'];

/** 主题 → 引擎参数的映射（原型 applyGlassParams；edge/shine/tint 固定）。 */
export function glassParamsFor(t) {
  return {
    refract: t.refract,
    blur: Math.max(0, t.glass - 6) * 0.32,
    edge: 15, shine: 6, tint: 2,
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
  { key: 'glass', label: '雾化 Frost', min: 6, max: 34, step: 1, unit: 'px' },
  { key: 'refract', label: '折射', min: 0, max: 60, step: 1, unit: '' },
  { key: 'depth', label: '深度 Depth', min: 0, max: 100, step: 1, unit: '' },
  { key: 'dispersion', label: '色散 Dispersion', min: 0, max: 30, step: 1, unit: '' },
  { key: 'lightAngle', label: '光源角度', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'light', label: '光源强度', min: 20, max: 160, step: 1, unit: '%' },
  { key: 'wobble', label: '内部波动', min: 0, max: 40, step: 1, unit: '' },
];

export const ThemeStore = (() => {
  let theme = { ...THEME_DEFAULTS };
  let backend = null;
  let saveTimer = null;
  const textureCache = new Map();
  let customImage = null;

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
    LiquidGlass.setBackground(textureForBackground());
  }

  function applyVars() {
    const root = document.documentElement.style;
    root.setProperty('--bg-veil', String(theme.veil / 100));
    root.setProperty('--glass-blur-amt', `${theme.glass}px`);
    root.setProperty('--ink', theme.ink);
    document.documentElement.dataset.palette = theme.palette;
    document.documentElement.dataset.bubbleStyle = theme.bubbleStyle;
    document.documentElement.dataset.tone = PALETTES[theme.palette]?.dark ? 'dark' : 'light';
    root.setProperty('--bubble-me-solid', theme.me);
    root.setProperty('--bubble-ai-solid', theme.ai);
    root.setProperty('--bubble-me', hexA(theme.me, theme.bubbleStyle === 'liquid' ? .35 : .94));
    const background = PALETTES[theme.palette]?.dark ? '#292929' : '#eeeeee';
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
    LiquidGlass.setParams(glassParamsFor(theme));
  }

  function save() {
    if (!backend) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      backend.put('settings', { key: 'appearance', value: { ...theme } }).catch(() => {});
    }, 300);
  }

  function clampTheme(t) {
    const out = { ...THEME_DEFAULTS, ...(t || {}) };
    if (!PALETTES[out.palette]) out.palette = 'pearl';
    if (!['liquid', 'soft', 'ink'].includes(out.bubbleStyle)) out.bubbleStyle = 'liquid';
    for (const s of SLIDERS) {
      const v = Number(out[s.key]);
      out[s.key] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : THEME_DEFAULTS[s.key];
    }
    if (!BG_PRESETS[out.bg] && out.bg !== 'custom') out.bg = 'none';
    if (out.bg === 'custom' && !out.bgCustom) out.bg = 'none';
    for (const k of ['ink', 'me', 'ai']) {
      if (typeof out[k] !== 'string' || !/^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(out[k])) out[k] = THEME_DEFAULTS[k];
    }
    return out;
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
    for (const [id, name] of [['liquid', '液态玻璃'], ['soft', '柔雾'], ['ink', '墨色']]) {
      const b = el('button', theme.bubbleStyle === id ? 'active' : '', name);
      b.setAttribute('aria-pressed', String(theme.bubbleStyle === id));
      b.addEventListener('click', () => { update({ bubbleStyle: id }); renderAppearanceInto(container); }); styles.appendChild(b);
    }
    presetsCard.append(el('h3', '', '气泡材质'), styles);
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

    /** backend：IndexedDB 后端（持久化用）；saved：之前存过的 appearance 记录。 */
    init(be, saved) {
      backend = be || null;
      theme = clampTheme(saved || {});
      if (theme.bg === 'custom' && theme.bgCustom) {
        const img = new Image();
        img.onload = () => {
          customImage = img;
          LiquidGlass.setBackground(img);
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
