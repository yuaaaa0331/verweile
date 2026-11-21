// audioKeepAlive.js — 音频保活（默认关闭）。
// 目的：用一段静音音频 + 心跳计时器，尽量让页面在前台/短暂切后台时
// 不被立即挂起。模块内单例，只有一个音频实例。
// 诚实边界（见 AUDIO_KEEPALIVE_HONESTY）：
// - 播放成功 ≠ 保活成功；iOS 锁屏 / 后台的实际效果未验证，真机待测。
// - 必须用户手势后启动；autoplay 被拒时返回明确错误，不静默假装成功。
// - 中断后状态如实变为 interrupted，恢复时不自动偷偷重建生成、不重复生成消息。
// - 音频保活、Service Worker、本地定时器都不能充当后台常驻服务。
// - 不上传录音；与普通语音播放互斥时先停保活。

export const AUDIO_KEEPALIVE_HONESTY =
  '播放成功 ≠ 保活成功：这段静音音频只是在播，iOS 锁屏/后台是否真能保活未验证，需真机实测。音频保活不能充当后台常驻服务，页面关闭后即失效。';

export const KEEPALIVE_SETTINGS_KEY = 'audioKeepAlive';
export const DEFAULT_KEEPALIVE_SETTINGS = { enabled: false, heartbeatSec: 30 };

// 一段 1 秒静音 WAV（44.1kHz 16-bit 单声道），base64 data URL；不依赖外部文件。
export const SILENT_WAV_DATA_URL =
  'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

export const KEEPALIVE_STATES = ['idle', 'starting', 'playing', 'paused', 'interrupted', 'denied'];

/**
 * 依赖注入（便于 Node 测试与浏览器复用）：
 * - createAudio(): 返回 { play(): Promise, pause(), src, loop }（通常是 new Audio()）
 * - timers: { setInterval, clearInterval }（默认全局）
 * - channelFactory: () => BroadcastChannel（多标签页选主用；不给则不协调）
 * - now: () => ms
 * - onStateChange(state, prev)
 */
export class AudioKeepAlive {
  constructor(deps = {}) {
    this.createAudio = deps.createAudio || (() => {
      if (typeof Audio === 'undefined') throw new Error('当前环境没有 Audio');
      const a = new Audio(SILENT_WAV_DATA_URL);
      a.loop = true;
      return a;
    });
    this.timers = deps.timers || { setInterval: globalThis.setInterval.bind(globalThis), clearInterval: globalThis.clearInterval.bind(globalThis) };
    this.channelFactory = deps.channelFactory || null;
    this.now = deps.now || (() => Date.now());
    this.onStateChange = deps.onStateChange || null;
    this.heartbeatSec = deps.heartbeatSec || DEFAULT_KEEPALIVE_SETTINGS.heartbeatSec;
    this.state = 'idle';
    this.lastHeartbeatAt = null;
    this.heartbeatCount = 0;
    this.error = null;
    this.audio = null;
    this.timerId = null;
    this.isLeader = true;
    this.tabId = deps.tabId || `tab_${Math.random().toString(36).slice(2, 9)}`;
    this.channel = null;
    this._stoppedByVoice = false;
  }

  getState() {
    return {
      state: this.state,
      lastHeartbeatAt: this.lastHeartbeatAt,
      heartbeatCount: this.heartbeatCount,
      error: this.error,
      isLeader: this.isLeader,
    };
  }

  _setState(next, error = null) {
    const prev = this.state;
    this.state = next;
    this.error = error;
    if (prev !== next) this.onStateChange?.(next, prev);
  }

  _electLeader() {
    if (!this.channelFactory) { this.isLeader = true; return true; }
    try {
      this.channel = this.channelFactory('verweile-keepalive');
      this.channel.onmessage = (e) => {
        if (e?.data?.type === 'keepalive-claim' && e.data.tabId !== this.tabId) {
          // 已有主标签页在播：后来者让位
          if (this.state === 'playing' || this.state === 'starting') this.stop('yield-to-leader');
          this.isLeader = false;
        }
        if (e?.data?.type === 'keepalive-released' && e.data.tabId !== this.tabId) this.isLeader = true;
      };
      this.channel.postMessage({ type: 'keepalive-claim', tabId: this.tabId });
    } catch { this.isLeader = true; }
    return this.isLeader;
  }

  /**
   * 启动保活。必须在用户手势里调用：opts.userGesture 为 false 时直接拒绝，
   * 不尝试播放、不假装成功。返回 { ok, state } 或 { ok:false, reason, state }。
   */
  async start(opts = {}) {
    if (this.state === 'playing' || this.state === 'starting') return { ok: true, state: this.state };
    if (!opts.userGesture) {
      this._setState('denied', '需要用户手势后启动：请点一下“开启保活”按钮再试。');
      return { ok: false, reason: this.error, state: this.state };
    }
    if (!this._electLeader() && !opts.force) {
      return { ok: false, reason: '已有另一标签页在保活，本页让位。', state: this.state };
    }
    this._setState('starting');
    try {
      if (!this.audio) {
        this.audio = this.createAudio();
        this.audio.src = SILENT_WAV_DATA_URL;
        this.audio.loop = true;
      }
      await this.audio.play();
    } catch (e) {
      const name = e?.name || '';
      const reason = name === 'NotAllowedError'
        ? '浏览器拒绝自动播放：请在点击手势里再点一次“开启保活”。'
        : `音频启动失败：${e?.message || String(e)}`;
      this._setState('denied', reason);
      return { ok: false, reason, state: this.state };
    }
    this._setState('playing');
    this.lastHeartbeatAt = this.now();
    this.heartbeatCount = 0;
    this.timerId = this.timers.setInterval(() => this._heartbeat(), this.heartbeatSec * 1000);
    return { ok: true, state: this.state };
  }

  _heartbeat() {
    if (this.state !== 'playing') return;
    this.lastHeartbeatAt = this.now();
    this.heartbeatCount += 1;
  }

  /** 供测试 / 集成手动触发一次心跳（与定时器同一逻辑）。 */
  tickHeartbeat() { this._heartbeat(); return this.getState(); }

  /** 手动恢复（中断/暂停后由用户点按钮恢复，不自动重建）。与 start 同一路径。 */
  async resume(opts = {}) {
    if (this.state === 'playing') return { ok: true, state: this.state };
    this._stoppedByVoice = false;
    return this.start(opts);
  }

  stop(reason) {
    if (this.timerId !== null) { this.timers.clearInterval(this.timerId); this.timerId = null; }
    try { this.audio?.pause(); } catch { /* ignore */ }
    try { this.channel?.postMessage({ type: 'keepalive-released', tabId: this.tabId }); } catch { /* ignore */ }
    this._setState('idle');
    return { ok: true, state: this.state, reason: reason || '已停止' };
  }

  pause(reason) {
    if (this.state !== 'playing') return this.getState();
    try { this.audio?.pause(); } catch { /* ignore */ }
    if (this.timerId !== null) { this.timers.clearInterval(this.timerId); this.timerId = null; }
    this._setState('paused', reason || '已暂停');
    return this.getState();
  }

  /** 页面隐藏 / 音频被系统中断：状态如实变为 interrupted，不自动重建。 */
  handleInterruption(reason) {
    if (this.state === 'playing' || this.state === 'starting') {
      if (this.timerId !== null) { this.timers.clearInterval(this.timerId); this.timerId = null; }
      try { this.audio?.pause(); } catch { /* ignore */ }
      this._setState('interrupted', reason || '音频被系统中断，需用户手动恢复。');
    }
    return this.getState();
  }

  /** visibilitychange 的处理入口：hidden 时记中断，visible 时不自动恢复。 */
  handleVisibility(hidden) {
    if (hidden) return this.handleInterruption('页面切到后台，音频中断。');
    return this.getState(); // 恢复前台不自动重建，需用户手动点恢复
  }

  /**
   * 与普通语音播放互斥：播语音前先停保活；语音播完后由调用方决定
   * 是否手动恢复保活（本模块不自动恢复）。
   */
  yieldToVoice() {
    if (this.state === 'playing') {
      this._stoppedByVoice = true;
      this.pause('让位于语音播放');
    }
    return this.getState();
  }
  wasStoppedByVoice() { return this._stoppedByVoice; }
}

/** 模块内单例（浏览器用）；Node 测试请直接 new AudioKeepAlive(注入)。 */
let singleton = null;
export function getAudioKeepAlive(deps) {
  if (!singleton) singleton = new AudioKeepAlive(deps);
  return singleton;
}

/**
 * 设置区渲染（由总协调员接进 app.js 设置页）。
 * deps：{ settings, onSave(settings), keepAlive (AudioKeepAlive 实例), toast? }。
 * 状态行由调用方在 start/stop 后重渲染本区（或直接读 keepAlive.getState()）。
 */
export function renderKeepAliveSettingsSection(container, deps = {}) {
  const s = { ...DEFAULT_KEEPALIVE_SETTINGS, ...(deps.settings || {}) };
  const k = deps.keepAlive || null;
  const st = k?.getState() || { state: 'idle', heartbeatCount: 0, lastHeartbeatAt: null, error: null, isLeader: true };
  const stateText = { idle: '未开启', starting: '启动中…', playing: '播放中（不等于保活成功）', paused: '已暂停', interrupted: '已中断，需手动恢复', denied: '启动被拒绝' }[st.state] || st.state;
  const html = `
      <h3>音频保活</h3>
      <p class="muted b-honesty">${AUDIO_KEEPALIVE_HONESTY}</p>
      <div class="setting-row"><span class="setting-label">开启音频保活<small>默认关闭，需点“启动保活”并在手势里完成</small></span><label class="switch"><input type="checkbox" id="keepalive-enabled" ${s.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="kv"><span>当前状态</span><b id="keepalive-state">${stateText}</b></div>
      <div class="kv"><span>心跳次数</span><b>${st.heartbeatCount}</b></div>
      ${st.error ? `<p class="muted">上次错误：${String(st.error)}</p>` : ''}
      ${st.isLeader === false ? '<p class="muted">另一标签页正在保活，本页已让位。</p>' : ''}
      <div class="actions-row">
        <button class="primary" id="keepalive-start">启动保活</button>
        <button id="keepalive-resume">手动恢复</button>
        <button id="keepalive-stop">停止</button>
        <button id="keepalive-save">保存设置</button>
      </div>`;
  if (container) container.innerHTML = html;
  const q = (id) => container?.querySelector?.(`#${id}`);
  q('keepalive-save')?.addEventListener?.('click', async () => {
    await deps.onSave?.({ enabled: q('keepalive-enabled')?.checked ?? s.enabled, heartbeatSec: s.heartbeatSec });
    deps.toast?.('音频保活设置已保存');
  });
  q('keepalive-start')?.addEventListener?.('click', async () => {
    if (!k) return;
    const r = await k.start({ userGesture: true });
    deps.toast?.(r.ok ? '保活已启动（播放中）' : (r.reason || '启动失败'));
    deps.onStateChange?.(k.getState());
  });
  q('keepalive-resume')?.addEventListener?.('click', async () => {
    if (!k) return;
    const r = await k.resume({ userGesture: true });
    deps.toast?.(r.ok ? '保活已恢复' : (r.reason || '恢复失败'));
    deps.onStateChange?.(k.getState());
  });
  q('keepalive-stop')?.addEventListener?.('click', () => {
    k?.stop('用户手动停止');
    deps.toast?.('保活已停止');
    deps.onStateChange?.(k?.getState());
  });
  return html;
}
