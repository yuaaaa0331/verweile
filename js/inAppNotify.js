// inAppNotify.js — 站内通知（横幅 + 未读标记）。
// 纯逻辑 + 描述子（不直接操作 DOM）：集成方（app.js）按返回的 banner
// 描述子渲染横幅、绑定点击。Node 测试用注入的 env 验证降级逻辑。
// 规则：仅在用户不在该聊天页时显示；提示音/振动/摘要隐私可设置；
// 能力不支持时静默跳过并返回降级说明，不假装已提醒。

export const NOTIFY_SETTINGS_KEY = 'notifySettings';
export const DEFAULT_NOTIFY_SETTINGS = {
  bannerEnabled: true,
  soundEnabled: true,
  vibrationEnabled: true,
  hideSummary: false, // 为 true 时摘要只显示“有新消息”
  unreadBadgeEnabled: true,
};

/** 仅在用户不在该聊天页时显示（纯函数）。 */
export function shouldShow(currentCharId, msgCharId) {
  if (!msgCharId) return false;
  return currentCharId !== msgCharId;
}

/** 摘要：隐藏模式只显示“有新消息”，不泄露内容。 */
export function formatSummary(msg, settings = {}) {
  if (settings.hideSummary) return '有新消息';
  const text = String(msg?.content || msg?.text || '').trim();
  if (!text) return msg?.type === 'image' ? '[图片]' : msg?.type === 'sticker' ? '[贴纸]' : '有新消息';
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

/**
 * 能力检测（注入 env，便于测试与诚实降级）：
 * env = { supportsVibration, supportsSound, playSound(), vibrate(pattern) }
 * 返回 { sound, vibration, degraded: string[] }。
 */
export function detectNotifyCapabilities(env = {}) {
  const degraded = [];
  const sound = env.supportsSound !== false;
  const vibration = env.supportsVibration === true;
  if (!sound) degraded.push('当前设备/浏览器不支持提示音，已跳过声音。');
  if (!vibration) degraded.push('当前设备/浏览器不支持振动，已跳过振动。');
  return { sound, vibration, degraded };
}

export class InAppNotifier {
  constructor(opts = {}) {
    this.settings = { ...DEFAULT_NOTIFY_SETTINGS, ...(opts.settings || {}) };
    this.env = opts.env || {};
    this.unread = new Map(); // charId -> count
    this.banners = []; // 未关闭的 banner 描述子
    this.onBanner = opts.onBanner || null; // (banner) => void，集成方渲染
    this.onOpenChat = opts.onOpenChat || null;
  }

  getUnread(charId) { return this.unread.get(charId) || 0; }
  getTotalUnread() { let n = 0; for (const v of this.unread.values()) n += v; return n; }
  markRead(charId) { this.unread.delete(charId); }
  markAllRead() { this.unread.clear(); }

  /**
   * 新消息到达时调用。msg = { id, charId, avatar, nickname, content, type }。
   * 返回 { shown, banner|null, degraded[] }。
   * 不在该聊天页才显示横幅；未读计数照常累加。
   */
  notify(msg, currentCharId) {
    const degraded = [];
    if (!msg?.charId) return { shown: false, banner: null, degraded: ['消息缺少角色 id，未显示通知。'] };
    this.unread.set(msg.charId, this.getUnread(msg.charId) + 1);
    if (!this.settings.bannerEnabled) return { shown: false, banner: null, degraded: ['站内横幅已关闭，只计未读。'] };
    if (!shouldShow(currentCharId, msg.charId)) return { shown: false, banner: null, degraded: [] };
    const caps = detectNotifyCapabilities(this.env);
    degraded.push(...caps.degraded);
    if (this.settings.soundEnabled && caps.sound) {
      try { this.env.playSound?.(); } catch { degraded.push('提示音播放失败，已跳过。'); }
    }
    if (this.settings.vibrationEnabled && caps.vibration) {
      try { this.env.vibrate?.(100); } catch { degraded.push('振动调用失败，已跳过。'); }
    }
    const banner = {
      id: `banner_${msg.id || Date.now()}`,
      messageId: msg.id || null,
      charId: msg.charId,
      avatar: msg.avatar || '',
      nickname: msg.nickname || '对方',
      summary: formatSummary(msg, this.settings),
      createdAt: Date.now(),
    };
    this.banners.push(banner);
    this.onBanner?.(banner);
    return { shown: true, banner, degraded };
  }

  /** 点击横幅：进对应聊天，并清掉该角色未读。返回目标。 */
  openBanner(bannerId) {
    const i = this.banners.findIndex((b) => b.id === bannerId);
    if (i === -1) return { ok: false, reason: '横幅不存在或已关闭' };
    const [banner] = this.banners.splice(i, 1);
    this.markRead(banner.charId);
    this.onOpenChat?.(banner.charId, banner.messageId);
    return { ok: true, charId: banner.charId, messageId: banner.messageId };
  }

  dismissBanner(bannerId) {
    const i = this.banners.findIndex((b) => b.id === bannerId);
    if (i === -1) return { ok: false, reason: '横幅不存在或已关闭' };
    this.banners.splice(i, 1);
    return { ok: true };
  }

  /**
   * 接线入口（任务 5 指定形状）：notifyInApp({ charId, avatar, name, summary, messageId })。
   * name → nickname，summary 有则直接用作摘要（无则按 content 规则生成）。
   * currentCharId 为当前正在看的聊天角色 id（可空 = 不在任何聊天页）。
   */
  notifyInApp(input, currentCharId) {
    const msg = {
      id: input?.messageId || input?.id || null,
      charId: input?.charId || null,
      avatar: input?.avatar || '',
      nickname: input?.name || input?.nickname || '对方',
      content: input?.summary ?? input?.content ?? '',
      type: input?.type || 'text',
    };
    const r = this.notify(msg, currentCharId);
    if (input?.summary != null && r.banner) r.banner.summary = String(input.summary);
    return r;
  }

  /** 未读计数快照（纯对象，可直接存 settings）。 */
  unreadSnapshot() { return Object.fromEntries(this.unread); }
  /** 从快照恢复未读计数（只接受非负整数）。 */
  restoreUnread(snapshot) {
    this.unread.clear();
    for (const [k, v] of Object.entries(snapshot || {})) {
      const n = Number(v);
      if (k && Number.isFinite(n) && n > 0) this.unread.set(k, Math.floor(n));
    }
    return this.getTotalUnread();
  }
}

/** 未读计数持久化：settings 表 key 'notifyUnread'，值 { charId: count }。 */
export const NOTIFY_UNREAD_KEY = 'notifyUnread';
export async function saveUnread(backend, notifier) {
  await backend.put('settings', { key: NOTIFY_UNREAD_KEY, value: notifier.unreadSnapshot() });
}
export async function loadUnread(backend, notifier) {
  const saved = await backend.get('settings', NOTIFY_UNREAD_KEY).catch(() => null);
  if (saved?.value) notifier.restoreUnread(saved.value);
  return notifier.getTotalUnread();
}

/**
 * 设置区渲染（由总协调员接进 app.js 设置页，不直接改 app.js）。
 * container：设置分组容器元素；deps：{ settings, onSave(settings), toast? }。
 * 无 DOM 时（Node 测试用假 container）只写 innerHTML 并返回 html，不绑定事件。
 */
export function renderNotifySettingsSection(container, deps = {}) {
  const s = { ...DEFAULT_NOTIFY_SETTINGS, ...(deps.settings || {}) };
  const html = `
      <h3>站内通知</h3>
      <p class="muted">其他聊天收到新消息时，在顶部显示轻量横幅（头像、昵称、内容摘要），点横幅进入对应聊天；正在看的聊天不重复弹窗。</p>
      <div class="setting-row"><span class="setting-label">显示站内横幅</span><label class="switch"><input type="checkbox" id="notify-banner" ${s.bannerEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="setting-row"><span class="setting-label">提示音<small>设备不支持时自动跳过</small></span><label class="switch"><input type="checkbox" id="notify-sound" ${s.soundEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="setting-row"><span class="setting-label">振动<small>设备不支持时自动跳过</small></span><label class="switch"><input type="checkbox" id="notify-vibration" ${s.vibrationEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="setting-row"><span class="setting-label">隐藏消息摘要<small>只显示“有新消息”，不泄露内容</small></span><label class="switch"><input type="checkbox" id="notify-hide-summary" ${s.hideSummary ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="setting-row"><span class="setting-label">显示未读标记</span><label class="switch"><input type="checkbox" id="notify-badge" ${s.unreadBadgeEnabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="actions-row"><button class="primary" id="notify-save">保存通知设置</button></div>`;
  if (container) container.innerHTML = html;
  const q = (id) => container?.querySelector?.(`#${id}`);
  q('notify-save')?.addEventListener?.('click', async () => {
    const next = {
      bannerEnabled: q('notify-banner')?.checked ?? s.bannerEnabled,
      soundEnabled: q('notify-sound')?.checked ?? s.soundEnabled,
      vibrationEnabled: q('notify-vibration')?.checked ?? s.vibrationEnabled,
      hideSummary: q('notify-hide-summary')?.checked ?? s.hideSummary,
      unreadBadgeEnabled: q('notify-badge')?.checked ?? s.unreadBadgeEnabled,
    };
    await deps.onSave?.(next);
    deps.toast?.('通知设置已保存');
  });
  return html;
}
