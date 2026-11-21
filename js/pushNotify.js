// pushNotify.js — 系统推送（Service Worker + Web Push 前端侧）。
// 能力诚实原则：仅已实际配置并测试的能力返回“可用”，其余返回
// “未配置/不支持”并附原因。未配置后台推送服务时返回前端运行模式说明，
// 不假装能后台推送。
// 规则：
// - requestPermission() 只在用户点击时调用，不反复请求；拒绝后展示说明。
// - notifyAfterPersist(msg)：消息先持久化再通知；调用方保证已保存，
//   本函数校验 msg.persisted（或 msg.id + 已保存标记），未保存拒绝通知。
// - 通知点击跳转只定位已有消息 id，不生成新消息。

export const PUSH_SETTINGS_KEY = 'pushSettings';
export const DEFAULT_PUSH_SETTINGS = {
  enabled: false,
  vapidPublicKey: '', // 由用户在部署时填入（见 server/wake-push-service/README.md）
  pushServiceUrl: '', // 可选后台推送服务地址；为空 = 未配置
};

export const FRONTEND_PUSH_MODE_TEXT =
  '当前是前端运行模式：未配置后台推送服务，页面关闭后收不到系统推送；站内横幅只在页面打开时显示。配置可选的 wake-push-service 并部署后，系统推送才可用。';

/**
 * 能力标签（注入 env，便于测试）：
 * env = { hasServiceWorker, hasPushManager, hasNotification, permission,
 *         configured (是否已填 VAPID + 服务地址), tested (是否部署后实测通过) }
 * 只有 configured && tested 才算“可用”。
 */
export function capabilityStatus(env = {}) {
  const caps = {
    serviceWorker: env.hasServiceWorker ? '可用' : '不支持',
    pushManager: env.hasPushManager ? '可用' : '不支持',
    notification: env.hasNotification ? '可用' : '不支持',
    permission: env.permission || 'default',
    push: '未配置',
  };
  const reasons = [];
  if (!env.hasServiceWorker) reasons.push('当前浏览器不支持 Service Worker。');
  if (!env.hasPushManager) reasons.push('当前浏览器不支持 PushManager。');
  if (!env.hasNotification) reasons.push('当前浏览器不支持 Notification。');
  if (env.permission === 'denied') reasons.push('通知权限已被拒绝，需在浏览器设置里手动开启。');
  if (!env.configured) {
    reasons.push('未配置后台推送服务（VAPID 公钥 / 推送服务地址为空）。');
  } else if (!env.tested) {
    caps.push = '未验证';
    reasons.push('已配置但未在部署后实测，暂按不可用处理。');
  } else {
    caps.push = '可用';
  }
  return { ...caps, configured: !!env.configured, tested: !!env.tested, mode: env.configured && env.tested ? 'backend' : 'frontend', reasons };
}

/** 注册 Service Worker（注入 navigatorLike，便于测试）。 */
export async function registerServiceWorker(navigatorLike, url = '/sw.js') {
  const nav = navigatorLike || (typeof navigator !== 'undefined' ? navigator : null);
  if (!nav?.serviceWorker?.register) {
    return { ok: false, reason: '当前浏览器不支持 Service Worker 注册。' };
  }
  try {
    const reg = await nav.serviceWorker.register(url);
    return { ok: true, registration: reg, scope: reg?.scope || url };
  } catch (e) {
    return { ok: false, reason: `Service Worker 注册失败：${e?.message || String(e)}` };
  }
}

/** 查询订阅状态（注入 registration）。 */
export async function getSubscriptionState(registration) {
  if (!registration?.pushManager?.getSubscription) return { subscribed: false, reason: 'PushManager 不可用。' };
  try {
    const sub = await registration.pushManager.getSubscription();
    return { subscribed: !!sub, subscription: sub || null };
  } catch (e) {
    return { subscribed: false, reason: `查询订阅失败：${e?.message || String(e)}` };
  }
}

/**
 * 用户主动授权入口：只在用户点击时调用。
 * NotificationLike 注入（默认全局 Notification）。
 * 拒绝后返回说明，不反复请求。
 */
export async function requestPermission(NotificationLike) {
  const N = NotificationLike || (typeof Notification !== 'undefined' ? Notification : null);
  if (!N?.requestPermission) return { ok: false, permission: 'unsupported', reason: '当前浏览器不支持通知权限申请。' };
  if (N.permission === 'granted') return { ok: true, permission: 'granted' };
  if (N.permission === 'denied') {
    return { ok: false, permission: 'denied', reason: '通知权限已被拒绝，请在浏览器设置里手动开启后重试。本次不会再弹出申请。' };
  }
  try {
    const result = await N.requestPermission();
    if (result === 'granted') return { ok: true, permission: 'granted' };
    return { ok: false, permission: result, reason: result === 'denied' ? '你拒绝了通知权限，可在浏览器设置里重新开启。' : '通知权限申请未完成。' };
  } catch (e) {
    return { ok: false, permission: 'default', reason: `申请通知权限失败：${e?.message || String(e)}` };
  }
}

/**
 * 订阅推送（需已授权 + 已配置 VAPID）。subscription 须发给后台服务保存；
 * 本函数只做订阅动作，不上传聊天正文与 API 密钥。
 */
export async function subscribePush(registration, vapidPublicKey) {
  if (!vapidPublicKey) return { ok: false, reason: '未配置 VAPID 公钥，无法订阅推送。' };
  if (!registration?.pushManager?.subscribe) return { ok: false, reason: 'PushManager 不可用。' };
  try {
    const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidPublicKey });
    return { ok: true, subscription: sub };
  } catch (e) {
    return { ok: false, reason: `订阅推送失败：${e?.message || String(e)}` };
  }
}

/**
 * 消息先持久化再通知：msg 须带 persisted: true（调用方保证已保存）。
 * 未保存直接拒绝，不先通知后补存。
 */
export async function notifyAfterPersist(msg, registration) {
  if (!msg?.persisted) return { ok: false, reason: '消息尚未持久化，拒绝先通知。请先保存消息再调用 notifyAfterPersist。' };
  if (!registration?.showNotification) return { ok: false, reason: 'Service Worker 注册不可用，无法显示系统通知。' };
  const title = msg.nickname || 'verweile';
  const body = msg.hideSummary ? '有新消息' : String(msg.content || '有新消息').slice(0, 80);
  try {
    await registration.showNotification(title, {
      body,
      tag: `msg-${msg.id || ''}`,
      data: { messageId: msg.id || null, charId: msg.charId || null, url: msg.charId ? `/?char=${encodeURIComponent(msg.charId)}&msg=${encodeURIComponent(msg.id || '')}` : '/' },
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `显示通知失败：${e?.message || String(e)}` };
  }
}

/**
 * iOS 主屏幕 Web App 推送能力检测（纯函数，env 可注入测试）：
 * env = { isIOS, isStandalone, hasPushManager, hasServiceWorker, permission, iosVersion }
 * iOS 16.4+ 且以“添加到主屏幕”的 Web App 方式打开时才支持 Web Push；
 * Safari 里直接打开不支持；iOS 16.4 以下不支持。
 */
export function detectIOSPush(env = {}) {
  if (!env.isIOS) return { supported: null, reason: '非 iOS 设备，本检测不适用。' };
  if (env.iosVersion != null && Number(env.iosVersion) < 16.4) {
    return { supported: false, reason: `当前 iOS ${env.iosVersion} 不支持 Web Push，需要 iOS 16.4 或更高版本。` };
  }
  if (!env.isStandalone) {
    return { supported: false, reason: 'iOS 上只有“添加到主屏幕”后打开的 Web App 才能收系统推送，在 Safari 里直接打开不支持。' };
  }
  if (!env.hasServiceWorker || !env.hasPushManager) {
    return { supported: false, reason: '当前环境不支持 Service Worker / PushManager。' };
  }
  if (env.permission === 'denied') {
    return { supported: false, reason: '通知权限已被拒绝，需在系统设置里手动开启。' };
  }
  return { supported: true, reason: 'iOS 主屏幕 Web App，支持系统推送（仍需配置后台推送服务并实测）。' };
}

/**
 * 通知点击跳转（纯函数，供 sw.js 与测试共用）：
 * 定位已有消息 id，不生成新消息。
 */
export function resolveNotificationClick(data, clients = []) {
  const url = data?.url || '/';
  const existing = clients.find((c) => c.url && String(c.url).includes(new URL(url, 'http://x').pathname));
  if (existing) return { action: 'focus', url, clientId: existing.id || null };
  return { action: 'open', url };
}

/**
 * 设置区渲染（由总协调员接进 app.js 设置页）。
 * deps：{ settings, onSave(settings), env（能力检测入参）, onRequestPermission(),
 *         onSubscribe(), onTestPush?(), toast? }。能力文案来自 capabilityStatus，
 * 未配置/未实测时只显示“未配置/未验证”，不写“可用”。
 */
export function renderPushSettingsSection(container, deps = {}) {
  const s = { ...DEFAULT_PUSH_SETTINGS, ...(deps.settings || {}) };
  const caps = capabilityStatus(deps.env || {});
  const ios = deps.env?.isIOS ? detectIOSPush(deps.env) : null;
  const html = `
      <h3>系统推送</h3>
      <p class="muted">${FRONTEND_PUSH_MODE_TEXT}</p>
      <div class="kv"><span>Service Worker</span><b>${caps.serviceWorker}</b></div>
      <div class="kv"><span>PushManager</span><b>${caps.pushManager}</b></div>
      <div class="kv"><span>通知权限</span><b>${caps.permission}</b></div>
      <div class="kv"><span>系统推送</span><b>${caps.push}</b></div>
      ${ios ? `<p class="muted">iOS：${ios.reason}</p>` : ''}
      ${caps.reasons.map((r) => `<p class="muted">· ${r}</p>`).join('')}
      <div class="setting-row"><span class="setting-label">开启系统推送<small>需先授权并配置后台服务</small></span><label class="switch"><input type="checkbox" id="push-enabled" ${s.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
      <div class="field"><label>VAPID 公钥</label><input type="text" id="push-vapid" value="${String(s.vapidPublicKey || '').replace(/"/g, '&quot;')}" placeholder="部署 wake-push-service 后填入公钥"><div class="hint">只填公钥；私钥只放服务器 .env，绝不填到这里。</div></div>
      <div class="field"><label>推送服务地址</label><input type="text" id="push-service-url" value="${String(s.pushServiceUrl || '').replace(/"/g, '&quot;')}" placeholder="例如 https://你的域名"><div class="hint">为空 = 未配置后台推送服务，当前为前端运行模式。</div></div>
      <div class="actions-row">
        <button class="primary" id="push-save">保存推送设置</button>
        <button id="push-permission">申请通知权限</button>
        <button id="push-subscribe">订阅推送</button>
      </div>`;
  if (container) container.innerHTML = html;
  const q = (id) => container?.querySelector?.(`#${id}`);
  q('push-save')?.addEventListener?.('click', async () => {
    const next = {
      enabled: q('push-enabled')?.checked ?? s.enabled,
      vapidPublicKey: q('push-vapid')?.value?.trim() ?? s.vapidPublicKey,
      pushServiceUrl: q('push-service-url')?.value?.trim() ?? s.pushServiceUrl,
    };
    await deps.onSave?.(next);
    deps.toast?.('推送设置已保存');
  });
  q('push-permission')?.addEventListener?.('click', async () => {
    const r = await (deps.onRequestPermission?.() ?? requestPermission());
    deps.toast?.(r.ok ? '通知权限已授权' : (r.reason || '未授权'));
    deps.onStateChange?.(r);
  });
  q('push-subscribe')?.addEventListener?.('click', async () => {
    const r = await deps.onSubscribe?.();
    deps.toast?.(r?.ok ? '推送已订阅' : (r?.reason || '订阅失败'));
  });
  return html;
}
