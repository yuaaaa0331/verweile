import test from 'node:test';
import assert from 'node:assert/strict';
import { InAppNotifier, shouldShow, formatSummary, detectNotifyCapabilities } from '../js/inAppNotify.js';
import {
  capabilityStatus, registerServiceWorker, getSubscriptionState,
  requestPermission, subscribePush, notifyAfterPersist,
  resolveNotificationClick, FRONTEND_PUSH_MODE_TEXT,
} from '../js/pushNotify.js';

const MSG = { id: 'm1', charId: 'char_1', avatar: 'a.png', nickname: '阿澈', content: '在吗？想你了' };

test('shouldShow：仅在用户不在该聊天页时显示', () => {
  assert.equal(shouldShow('char_1', 'char_1'), false);
  assert.equal(shouldShow('char_2', 'char_1'), true);
  assert.equal(shouldShow(null, 'char_1'), true);
  assert.equal(shouldShow('char_1', null), false);
});

test('站内横幅：头像昵称摘要齐全；点击进聊天并清未读；可关闭', () => {
  const opened = [];
  const n = new InAppNotifier({ env: { supportsVibration: false, supportsSound: true }, onOpenChat: (c, m) => opened.push([c, m]) });
  const r = n.notify(MSG, 'char_2');
  assert.equal(r.shown, true);
  assert.equal(r.banner.nickname, '阿澈');
  assert.equal(r.banner.summary, '在吗？想你了');
  assert.equal(r.banner.messageId, 'm1');
  assert.equal(n.getUnread('char_1'), 1);
  assert.equal(n.getTotalUnread(), 1);
  assert.ok(r.degraded.some((d) => d.includes('振动'))); // 不支持振动时给降级说明
  const open = n.openBanner(r.banner.id);
  assert.equal(open.ok, true);
  assert.deepEqual(opened, [['char_1', 'm1']]);
  assert.equal(n.getUnread('char_1'), 0);

  const r2 = n.notify({ ...MSG, id: 'm2' }, 'char_2');
  assert.equal(n.dismissBanner(r2.banner.id).ok, true);
  assert.equal(n.dismissBanner(r2.banner.id).ok, false); // 已关闭不能再关
  // 在当前聊天页：不显示横幅，但未读照计
  const r3 = n.notify({ ...MSG, id: 'm3' }, 'char_1');
  assert.equal(r3.shown, false);
  assert.equal(n.getUnread('char_1'), 2);
  n.markRead('char_1');
  assert.equal(n.getUnread('char_1'), 0);
});

test('摘要隐私：隐藏模式只显示“有新消息”', () => {
  assert.equal(formatSummary(MSG, { hideSummary: true }), '有新消息');
  assert.equal(formatSummary(MSG, {}), '在吗？想你了');
  assert.equal(formatSummary({ ...MSG, content: '' }, {}), '有新消息');
  const n = new InAppNotifier({ settings: { hideSummary: true } });
  const r = n.notify(MSG, 'char_2');
  assert.equal(r.banner.summary, '有新消息');
});

test('能力检测：不支持时静默跳过并返回降级说明', () => {
  const caps = detectNotifyCapabilities({ supportsSound: false, supportsVibration: false });
  assert.equal(caps.sound, false);
  assert.equal(caps.vibration, false);
  assert.equal(caps.degraded.length, 2);
});

test('推送能力标签：未配置时返回“未配置/前端运行模式”，不谎称可用', () => {
  const s = capabilityStatus({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', configured: false, tested: false });
  assert.equal(s.push, '未配置');
  assert.equal(s.mode, 'frontend');
  assert.ok(s.reasons.some((r) => r.includes('未配置后台推送服务')));
  assert.match(FRONTEND_PUSH_MODE_TEXT, /前端运行模式/);
  // 已配置但未实测 → 未验证，不算可用
  const s2 = capabilityStatus({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'granted', configured: true, tested: false });
  assert.equal(s2.push, '未验证');
  const s3 = capabilityStatus({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'granted', configured: true, tested: true });
  assert.equal(s3.push, '可用');
  assert.equal(s3.mode, 'backend');
});

test('Service Worker 注册与订阅状态查询（stub）', async () => {
  const noSw = await registerServiceWorker({});
  assert.equal(noSw.ok, false);
  const reg = { scope: '/sw.js', pushManager: { getSubscription: async () => ({ endpoint: 'https://push.example/x' }) } };
  const ok = await registerServiceWorker({ serviceWorker: { register: async (url) => ({ ...reg, scope: url }) } }, '/sw.js');
  assert.equal(ok.ok, true);
  const st = await getSubscriptionState(reg);
  assert.equal(st.subscribed, true);
  const st2 = await getSubscriptionState({ pushManager: { getSubscription: async () => null } });
  assert.equal(st2.subscribed, false);
});

test('requestPermission 只在用户点击时调用；拒绝后给说明不反复请求', async () => {
  let calls = 0;
  const denied = { permission: 'denied', requestPermission: async () => { calls += 1; return 'denied'; } };
  const r = await requestPermission(denied);
  assert.equal(r.ok, false);
  assert.equal(r.permission, 'denied');
  assert.match(r.reason, /手动开启/);
  assert.equal(calls, 0); // 已拒绝时不再弹出申请
  const granted = { permission: 'default', requestPermission: async () => { calls += 1; return 'granted'; } };
  const r2 = await requestPermission(granted);
  assert.equal(r2.ok, true);
  assert.equal(calls, 1);
});

test('subscribePush：未配置 VAPID 拒绝订阅', async () => {
  const r = await subscribePush({ pushManager: { subscribe: async () => ({}) } }, '');
  assert.equal(r.ok, false);
  assert.match(r.reason, /VAPID/);
});

test('notifyAfterPersist：消息先持久化再通知，未保存拒绝', async () => {
  const shown = [];
  const reg = { showNotification: async (title, opts) => shown.push([title, opts]) };
  const bad = await notifyAfterPersist({ ...MSG, persisted: false }, reg);
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /尚未持久化/);
  assert.equal(shown.length, 0);
  const good = await notifyAfterPersist({ ...MSG, persisted: true }, reg);
  assert.equal(good.ok, true);
  assert.equal(shown[0][0], '阿澈');
  assert.equal(shown[0][1].data.messageId, 'm1');
  const hidden = await notifyAfterPersist({ ...MSG, persisted: true, hideSummary: true }, reg);
  assert.equal(hidden.ok, true);
  assert.equal(shown[1][1].body, '有新消息');
});

test('通知点击跳转：定位已有消息，不生成新消息', () => {
  const r = resolveNotificationClick({ url: '/?char=char_1&msg=m1' }, [{ id: 'c1', url: 'http://x/?char=char_1&msg=m1' }]);
  assert.equal(r.action, 'focus');
  const r2 = resolveNotificationClick({ url: '/?char=char_1&msg=m1' }, []);
  assert.equal(r2.action, 'open');
  assert.equal(r2.url, '/?char=char_1&msg=m1');
});
