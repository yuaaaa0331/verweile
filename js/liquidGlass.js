// liquidGlass.js — 可复用的液态玻璃引擎（WebGL）。
// 按原型 uwu-liao-tian-ui-yuan-xing 与《液态玻璃技术方案 v3》移植：
// 单个 WebGL 上下文绘制全部玻璃元素，同一张背景纹理按元素位置采样，
// 折射集中在边缘窄带、中心安静，色散与染色默认均为 0。
// Clear 材质默认值（2026-11-20 精修）：光强 55%、边缘高光上限 0.18、
// 输出 alpha 即 mask（不透明，无画布重影）、亮度钳制 +0.06 / -0.16。
// WebGL 不可用或上下文丢失时返回 false，调用方保留 CSS 玻璃（.glass），
// 布局与交互不变。本模块不碰 DOM 之外的任何应用状态；不依赖 app.js。

export const LiquidGlass = (() => {
  const VERT_SRC = `
attribute vec2 a_pos;
uniform vec4 u_rect;
uniform vec2 u_view;
varying vec2 v_px;
void main() {
  v_px = u_rect.xy + a_pos * u_rect.zw;
  vec2 clip = (v_px / u_view) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
}`;

  const FRAG_SRC = `
precision highp float;
varying vec2 v_px;
uniform vec2 u_view;
uniform vec4 u_rect;
uniform float u_radius;
uniform sampler2D u_bg;
uniform vec2 u_img;
uniform float u_refract;
uniform float u_blur;
uniform float u_edge;
uniform float u_shine;
uniform float u_wobble;
uniform float u_tintAmt;
uniform float u_light;
uniform float u_lightAngle;
uniform float u_dispersion;
uniform float u_depth;
uniform float u_time;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}
vec4 tap(vec2 px) {
  float s = max(u_view.x / u_img.x, u_view.y / u_img.y);
  vec2 d = u_img * s;
  vec2 o = (u_view - d) * 0.5;
  vec2 uv = (px - o) / d;
  uv.y = 1.0 - uv.y;
  return texture2D(u_bg, uv);
}
vec4 sampleBg(vec2 px, float blur) {
  vec4 col = tap(px) * 0.20;
  for (int i = 0; i < 8; i++) {
    float a = 6.2831853 * float(i) / 8.0;
    col += tap(px + vec2(cos(a), sin(a)) * blur) * 0.10;
  }
  return col;
}
float wrapAngle(float a) {
  return mod(a + 3.14159265, 6.2831853) - 3.14159265;
}
void main() {
  vec2 size = u_rect.zw;
  vec2 c = u_rect.xy + size * 0.5;
  vec2 p = v_px - c;
  float sd = sdRoundBox(p, size * 0.5, u_radius);
  float aa = 1.4;
  float mask = 1.0 - smoothstep(-aa, aa, sd);
  if (mask <= 0.003) discard;
  vec2 q = p / size + 0.5;
  float edgeDist = -sd;
  float minHalf = min(size.x, size.y) * 0.5;
  float rim = pow(1.0 - clamp(edgeDist / (minHalf * (0.55 + 0.75 * u_depth)), 0.0, 1.0), 2.0);
  vec2 hn = p / (size * 0.5);
  float radial = length(hn);
  vec2 dir = radial > 0.0001 ? hn / radial : vec2(0.0);
  float field = 0.03 + 0.97 * max(rim, smoothstep(0.2, 1.05, radial) * 0.55);
  vec2 refr = dir * u_refract * field;
  vec2 wave = vec2(sin(p.y * 0.020 + u_time * 1.25), cos(p.x * 0.016 - u_time * 1.05)) * u_wobble * (0.05 + 0.95 * rim);
  vec2 sp = v_px + refr + wave;
  vec4 col;
  if (u_blur > 0.05) {
    col = sampleBg(sp, u_blur);
  } else {
    float ca = (dot(refr, dir) * 0.055 + length(wave) * 0.12) * min(u_dispersion, 1.0);
    col = vec4(tap(sp + dir * ca).r, tap(sp).g, tap(sp - dir * ca).b, 1.0);
  }
  col.rgb = mix(col.rgb, vec3(1.0), u_tintAmt);
  vec2 dsp = dir * u_dispersion * (0.35 + 0.65 * field);
  col.r = mix(col.r, tap(sp + dsp).r, 0.55);
  col.b = mix(col.b, tap(sp - dsp).b, 0.55);
  float hairline = exp(-pow((edgeDist + 0.55) / 0.62, 2.0));
  float ang = atan(p.y, p.x);
  float dA1 = wrapAngle(ang - u_lightAngle);
  float dA2 = wrapAngle(ang - (u_lightAngle + 3.14159265));
  float upperLeft = exp(-pow(dA1 / 0.60, 2.0));
  float lowerRight = exp(-pow(dA2 / 0.62, 2.0));
  // 薄高光：只在左上边缘窄带内快速渐隐（rim²），不再铺满整个表面。
  float wash = upperLeft * rim * rim;
  col.rgb += u_shine * u_light * wash * 0.02;
  float edgeGlint = hairline * (upperLeft * 0.66 + lowerRight * 0.48) * u_light;
  col.rgb = mix(col.rgb, vec3(1.0), clamp(edgeGlint, 0.0, 0.18) * u_edge);
  float botShade = smoothstep(0.55, 1.0, q.y) * exp(-edgeDist / 7.0);
  col.rgb *= 1.0 - botShade * 0.05;
  vec3 baseCol = tap(v_px).rgb;
  col.rgb = baseCol + clamp(col.rgb - baseCol, vec3(-0.16), vec3(0.06));
  gl_FragColor = vec4(col.rgb, mask);
}`;

  // Clear 材质默认值（与 theme.js glassParamsFor(THEME_DEFAULTS) 一致）。
  const DEFAULT_PARAMS = {
    refract: 32, blur: 0, edge: 8, shine: 2, wobble: 3, tint: 0,
    lightAngle: -2.38, light: 0.55, dispersion: 0, depth: 0.42,
  };

  // 按组件分的玻璃强度（与 styles.css 的 class 分类一致）：单行气泡最轻，
  // 多行气泡次之，顶栏 / 底栏 / 弹窗 / 大卡片各有强度，不再一套固定值走天下。
  // 数值是相对主题参数的乘子（0–1）。
  const GLASS_INTENSITY = {
    'bubble-single': { refract: 0.35, blur: 0.5, edge: 0.5, shine: 0.3, wobble: 0.3, depth: 0.6 },
    'bubble-multi': { refract: 0.6, blur: 0.7, edge: 0.7, shine: 0.5, wobble: 0.5, depth: 0.8 },
    chip: { refract: 0.4, blur: 0.5, edge: 0.6, shine: 0.4, wobble: 0.2, depth: 0.6 },
    pill: { refract: 0.5, blur: 0.6, edge: 0.6, shine: 0.4, wobble: 0.2, depth: 0.7 },
    tabbar: { refract: 0.7, blur: 0.8, edge: 0.8, shine: 0.6, wobble: 0.3, depth: 0.9 },
    topbar: { refract: 0.8, blur: 0.9, edge: 0.9, shine: 0.7, wobble: 0.4, depth: 1.0 },
    input: { refract: 0.5, blur: 0.6, edge: 0.6, shine: 0.4, wobble: 0.2, depth: 0.7 },
    strip: { refract: 0.5, blur: 0.6, edge: 0.6, shine: 0.4, wobble: 0.2, depth: 0.7 },
    sheet: { refract: 0.9, blur: 1.0, edge: 1.0, shine: 0.8, wobble: 0.4, depth: 1.0 },
    card: { refract: 0.7, blur: 0.8, edge: 0.8, shine: 0.6, wobble: 0.3, depth: 0.9 },
    'sub-head': { refract: 0.7, blur: 0.8, edge: 0.8, shine: 0.6, wobble: 0.3, depth: 0.9 },
    small: { refract: 0.35, blur: 0.5, edge: 0.5, shine: 0.3, wobble: 0.2, depth: 0.6 },
    default: { refract: 1, blur: 1, edge: 1, shine: 1, wobble: 1, depth: 1 },
  };

  /** 按元素 class + 气泡高度定强度分类（纯函数，可单测）。heightPx 为 CSS 像素高度。 */
  function classifyGlassElement(el, heightPx) {
    const c = el.classList;
    const has = (...names) => names.some((n) => c.contains(n));
    if (has('bubble')) return heightPx < 60 ? 'bubble-single' : 'bubble-multi';
    if (has('chip')) return 'chip';
    if (has('pill')) return 'pill';
    if (has('tabbar')) return 'tabbar';
    if (has('chat-head')) return 'topbar';
    if (has('input-shell')) return 'input';
    if (has('status-strip')) return 'strip';
    if (has('sheet-card', 'status-sheet', 'modal-card')) return 'sheet';
    if (has('char-card', 'group', 'post', 'card')) return 'card';
    if (has('sub-head')) return 'sub-head';
    if (has('m-ico', 'post-action')) return 'small';
    return 'default';
  }

  /** 整画布清除（幽灵块根因修复）：必须先关 scissor（并复位到整块画布），
   * 再 clear，否则 clear 只清上一帧最后一个元素的 scissor 矩形，
   * 元素移动 / 尺寸变化 / 被移除 / 切页后旧位置残留永不清掉。 */
  function clearGlassCanvas(gl, width, height) {
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    if (width && height) gl.scissor(0, 0, width, height);
    return true;
  }

  const state = {
    canvas: null, gl: null, prog: null, uniforms: {}, texture: null,
    imgSize: [1, 1], params: { ...DEFAULT_PARAMS },
    elements: new Set(), dpr: 1, animEnabled: true, animTime: 0,
    needsRender: true, rafId: 0, running: false, ok: false,
    pendingBg: null, onContextLost: null, lastFrame: 0,
    io: null, ro: null,
  };

  function compile(gl, type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error(`液态玻璃 shader 编译失败：${log}`);
    }
    return sh;
  }

  function readRadius(el) {
    const cs = getComputedStyle(el);
    const raw = cs.borderTopLeftRadius || '0px';
    const w = el.offsetWidth || 1;
    const h = el.offsetHeight || 1;
    if (raw.indexOf('%') !== -1) {
      return (parseFloat(raw) / 100) * Math.min(w, h);
    }
    return parseFloat(raw) || 0;
  }

  function draw(now) {
    const { gl, canvas } = state;
    if (!gl || !canvas) return;
    const dt = Math.min(0.05, (now - state.lastFrame) / 1000 || 0);
    state.lastFrame = now;
    if (document.hidden) return;
    if (state.animEnabled) {
      if (state.params.wobble > 0) state.animTime += dt;
    } else if (!state.needsRender) {
      return;
    }
    state.needsRender = false;
    const dpr = state.dpr;
    const cw = canvas.width;
    const ch = canvas.height;
    if (!cw || !ch) return;
    gl.viewport(0, 0, cw, ch);
    clearGlassCanvas(gl, cw, ch);
    gl.useProgram(state.prog);
    const u = state.uniforms;
    gl.uniform2f(u.u_view, cw, ch);
    gl.uniform2f(u.u_img, state.imgSize[0], state.imgSize[1]);
    gl.uniform1f(u.u_time, state.animTime);
    const p = state.params;
    gl.uniform1f(u.u_tintAmt, p.tint / 100);
    gl.uniform1f(u.u_light, p.light);
    gl.uniform1f(u.u_lightAngle, p.lightAngle);
    gl.uniform1f(u.u_dispersion, p.dispersion * dpr * 0.22);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    gl.uniform1i(u.u_bg, 0);
    const canvasRect = canvas.getBoundingClientRect();
    for (const el of state.elements) {
      if (el._lgVisible === false || !el.isConnected || getComputedStyle(el).visibility === 'hidden') continue;
      if (el.classList.contains('bubble') && document.documentElement.dataset.bubbleStyle !== 'liquid') continue;
      if (el.closest('.subpage:not(.open)')) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      const x = (r.left - canvasRect.left) * dpr;
      const yTop = (r.top - canvasRect.top) * dpr;
      const w = r.width * dpr;
      const h = r.height * dpr;
      const radius = Math.min(readRadius(el), Math.min(r.width, r.height) / 2) * dpr;
      // 按组件强度覆盖：同一帧里不同元素用不同的折射 / 模糊 / 边缘 / 波动。
      const k = GLASS_INTENSITY[classifyGlassElement(el, r.height)] || GLASS_INTENSITY.default;
      gl.uniform1f(u.u_refract, p.refract * dpr * 0.55 * k.refract);
      gl.uniform1f(u.u_blur, p.blur * dpr * 0.55 * k.blur);
      gl.uniform1f(u.u_edge, (p.edge / 100) * k.edge);
      gl.uniform1f(u.u_shine, (p.shine / 100) * k.shine);
      gl.uniform1f(u.u_wobble, (state.animEnabled ? p.wobble * dpr * 0.10 : 0) * k.wobble);
      gl.uniform1f(u.u_depth, Math.min(1, p.depth * k.depth));
      gl.uniform4f(u.u_rect, x, yTop, w, h);
      gl.uniform1f(u.u_radius, radius);
      // scissor：元素矩形外扩 2px（覆盖抗锯齿边缘），y 轴翻转。
      const sx = Math.max(0, Math.floor(x - 2));
      const sy = Math.max(0, Math.floor(ch - (yTop + h) - 2));
      const sw = Math.min(cw - sx, Math.ceil(w + 4));
      const sh = Math.min(ch - sy, Math.ceil(h + 4));
      // Clip the shared refraction canvas to scroll containers and the active view.
      let clipL = sx, clipR = sx + sw, clipB = sy, clipT = sy + sh;
      for (let parent = el.parentElement; parent && parent !== canvas.parentElement; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (/(auto|scroll|hidden|clip)/.test(style.overflow + style.overflowY + style.overflowX)) {
          const pr = parent.getBoundingClientRect();
          clipL = Math.max(clipL, (pr.left - canvasRect.left) * dpr);
          clipR = Math.min(clipR, (pr.right - canvasRect.left) * dpr);
          clipB = Math.max(clipB, ch - (pr.bottom - canvasRect.top) * dpr);
          clipT = Math.min(clipT, ch - (pr.top - canvasRect.top) * dpr);
        }
      }
      if (clipR <= clipL || clipT <= clipB) continue;
      gl.scissor(Math.floor(clipL), Math.floor(clipB), Math.ceil(clipR - clipL), Math.ceil(clipT - clipB));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  function loop(now) {
    if (!state.running) return;
    if (!state.frameAt || now - state.frameAt >= 32 || state.needsRender) { draw(now); state.frameAt = now; }
    state.rafId = requestAnimationFrame(loop);
  }

  function resizeCanvas() {
    const { canvas, gl } = state;
    if (!canvas || !gl) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.dpr = dpr;
    const w = Math.round(canvas.clientWidth * dpr);
    const h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    state.needsRender = true;
  }

  function attachOne(el) {
    if (!el || state.elements.has(el)) return;
    state.elements.add(el);
    el._lgVisible = true;
    if (state.ok) el.classList.add('gl-webgl');
    if (state.io) state.io.observe(el);
    if (state.ro) state.ro.observe(el);
    state.needsRender = true;
  }

  function uploadBackground(source) {
    const { gl } = state;
    if (!gl || !source) return;
    const w = source.naturalWidth || source.width;
    const h = source.naturalHeight || source.height;
    if (!w || !h) return;
    gl.bindTexture(gl.TEXTURE_2D, state.texture);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch (e) {
      return;
    }
    state.imgSize = [w, h];
    state.needsRender = true;
  }

  return {
    VERT_SRC,
    FRAG_SRC,
    DEFAULT_PARAMS,
    GLASS_INTENSITY,
    classifyGlassElement,
    clearGlassCanvas,
    get supported() { return state.ok; },

    /** 初始化。canvas：页面里的 <canvas id="gl-canvas">。失败返回 false（调用方保留 CSS 玻璃）。 */
    init(opts = {}) {
      const canvas = opts.canvas || document.getElementById('gl-canvas');
      if (!canvas) return false;
      state.canvas = canvas;
      state.onContextLost = typeof opts.onContextLost === 'function' ? opts.onContextLost : null;
      if (typeof opts.animEnabled === 'boolean') state.animEnabled = opts.animEnabled;
      const gl = canvas.getContext('webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: 'high-performance',
      }) || canvas.getContext('experimental-webgl', {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: 'high-performance',
      });
      if (!gl) { canvas.dataset.renderer = 'css'; return false; }
      try {
        const vs = compile(gl, gl.VERTEX_SHADER, VERT_SRC);
        const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
        const prog = gl.createProgram();
        gl.attachShader(prog, vs);
        gl.attachShader(prog, fs);
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('液态玻璃 program 链接失败');
        state.prog = prog;
        state.gl = gl;
        const names = ['u_rect', 'u_view', 'u_radius', 'u_bg', 'u_img', 'u_refract', 'u_blur', 'u_edge', 'u_shine', 'u_wobble', 'u_tintAmt', 'u_light', 'u_lightAngle', 'u_dispersion', 'u_depth', 'u_time'];
        for (const n of names) state.uniforms[n] = gl.getUniformLocation(prog, n);
        const buf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
        const loc = gl.getAttribLocation(prog, 'a_pos');
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        // 1×1 白色占位纹理；真实背景由 setBackground 随后传入。
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
        state.texture = tex;
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.enable(gl.SCISSOR_TEST);
      } catch (e) {
        canvas.dataset.renderer = 'css';
        console.warn(e.message);
        return false;
      }
      canvas.dataset.renderer = 'webgl';
      state.ok = true;
      resizeCanvas();
      if (state.pendingBg) {
        const bg = state.pendingBg;
        state.pendingBg = null;
        uploadBackground(bg);
      }
      state.io = new IntersectionObserver((entries) => {
        for (const en of entries) {
          en.target._lgVisible = en.intersectionRatio > 0.01;
          state.needsRender = true;
        }
      }, { threshold: 0.01 });
      state.ro = new ResizeObserver(() => { state.needsRender = true; });
      for (const el of state.elements) {
        el.classList.add('gl-webgl');
        state.io.observe(el);
        state.ro.observe(el);
      }
      canvas.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        canvas.dataset.renderer = 'css';
        state.ok = false;
        state.running = false;
        cancelAnimationFrame(state.rafId);
        for (const el of state.elements) el.classList.remove('gl-webgl');
        if (state.onContextLost) state.onContextLost();
      });
      window.addEventListener('resize', () => { resizeCanvas(); });
      window.addEventListener('orientationchange', () => { resizeCanvas(); });
      document.addEventListener('scroll', () => { state.needsRender = true; }, true);
      document.addEventListener('visibilitychange', () => { state.needsRender = true; });
      state.running = true;
      state.lastFrame = performance.now();
      state.rafId = requestAnimationFrame(loop);
      return true;
    },

    prune() {
      let removed = false;
      for (const el of state.elements) if (!el.isConnected) {
        state.elements.delete(el); state.io?.unobserve(el); state.ro?.unobserve(el);
        removed = true;
      }
      // 集合变化后下一帧整画布重清（clearGlassCanvas 已保证 scissor 安全），旧位置不残留。
      if (removed) state.needsRender = true;
    },
    attach(el) { attachOne(el); },
    attachAll(root) {
      const scope = root || document;
      scope.querySelectorAll('.glass').forEach((el) => attachOne(el));
    },
    detach(el) {
      if (!el || !state.elements.has(el)) return;
      state.elements.delete(el);
      el.classList.remove('gl-webgl');
      if (state.io) state.io.unobserve(el);
      if (state.ro) state.ro.unobserve(el);
      state.needsRender = true;
    },

    /** 背景源：HTMLImageElement 或 HTMLCanvasElement。init 之前调用会被缓存。 */
    setBackground(source) {
      if (!source) return;
      if (!state.gl) { state.pendingBg = source; return; }
      uploadBackground(source);
    },

    /** 部分更新引擎参数（主题滑杆用）。 */
    setParams(patch) {
      Object.assign(state.params, patch || {});
      state.needsRender = true;
    },
    getParams() { return { ...state.params }; },

    setAnim(enabled) {
      state.animEnabled = !!enabled;
      state.needsRender = true;
    },
    refresh() { state.needsRender = true; resizeCanvas(); },

    dispose() {
      state.running = false;
      cancelAnimationFrame(state.rafId);
      if (state.io) state.io.disconnect();
      if (state.ro) state.ro.disconnect();
      for (const el of state.elements) el.classList.remove('gl-webgl');
      state.elements.clear();
      state.ok = false;
      state.gl = null;
    },
  };
})();
