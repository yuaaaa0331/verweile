import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryBackend, DB_VERSION, ensureWakeStores, B_GROUP_SETTINGS_KEYS } from '../js/storage.js';
import {
  InAppNotifier, renderNotifySettingsSection as renderNotifySettings,
  saveUnread, loadUnread, NOTIFY_UNREAD_KEY,
} from '../js/inAppNotify.js';
import { AudioKeepAlive, renderKeepAliveSettingsSection as renderKeepAliveSettings } from '../js/audioKeepAlive.js';
import {
  capabilityStatus, detectIOSPush, renderPushSettingsSection as renderPushSettings,
} from '../js/pushNotify.js';
import {
  validateIconPng, readPngSize, validateIconPackFiles, exportIconPack,
  renderIconSettingsSection as renderIconSettings, ICON_SIZES,
} from '../js/customIcon.js';
import {
  WakeEngine, createMemoryWakeStore, parseWakeToolCall, validateSceneTiming,
  validateWakeWhen, checkDue, renderWakeSettingsSection as renderWakeSettings,
  DEFAULT_WAKE_SETTINGS,
} from '../js/wakeEngine.js';

/* ---------- storage：v3→v4 ---------- */

test('迁移：v3 库升到 v4 只新增 wakeScenes / wakeAlarms / wakeReceipts，旧表不动', () => {
  assert.equal(DB_VERSION, 4);
  const created = [];
  const createdStores = {};
  const stores = new Set(['characters', 'journals', 'messages', 'settings', 'unknown', 'vectorChunks', 'experiences', 'keywordIndex']);
  const fakeDb = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (name, opts) => {
      stores.add(name);
      const idx = [];
      created.push(name);
      const s = { createIndex: (iname, kp) => idx.push([iname, kp]), _idx: idx, _keyPath: opts?.keyPath };
      createdStores[name] = s;
      return s;
    },
  };
  ensureWakeStores(fakeDb);
  assert.deepEqual(created.sort(), ['wakeAlarms', 'wakeReceipts', 'wakeScenes']);
  assert.equal(createdStores.wakeScenes._keyPath, 'id');
  assert.deepEqual(createdStores.wakeScenes._idx, [['byChar', ['charId', 'nextAt']], ['byStatus', ['status', 'nextAt']]]);
  assert.equal(createdStores.wakeAlarms._keyPath, 'id');
  assert.deepEqual(createdStores.wakeAlarms._idx, [['byChar', ['charId', 'at']]]);
  assert.equal(createdStores.wakeReceipts._keyPath, 'wakeId');
  assert.ok(stores.has('experiences'), 'v3 的 experiences 表被动了');
  created.length = 0;
  ensureWakeStores(fakeDb);
  assert.deepEqual(created, []);
});

test('MemoryBackend 有唤醒三张表，可读写；wakeReceipts 以 wakeId 为键', async () => {
  const db = new MemoryBackend();
  await db.init();
  await db.put('wakeScenes', { id: 's1', charId: 'c1', type: 'work', status: 'active' });
  await db.put('wakeAlarms', { id: 'a1', charId: 'c1', at: 123, status: 'pending' });
  await db.put('wakeReceipts', { wakeId: 'w1', charId: 'c1', completed: true });
  assert.equal((await db.get('wakeScenes', 's1')).type, 'work');
  assert.equal((await db.get('wakeAlarms', 'a1')).status, 'pending');
  assert.equal((await db.get('wakeReceipts', 'w1')).completed, true);
  assert.equal((await db.getAll('wakeReceipts')).length, 1);
  assert.deepEqual(B_GROUP_SETTINGS_KEYS, ['notifySettings', 'audioKeepAlive', 'pushSettings', 'customIcon', 'wakeSettings']);
});

/* ---------- 任务 5：站内通知 ---------- */

function fakeContainer() {
  return { innerHTML: '', querySelector: () => null };
}

test('notifyInApp 入口形状：{charId, avatar, name, summary, messageId}，未读照计', () => {
  const opened = [];
  const n = new InAppNotifier({ onOpenChat: (c, m) => opened.push([c, m]) });
  const r = n.notifyInApp({ charId: 'c1', avatar: 'a.png', name: '阿澈', summary: '在吗？', messageId: 'm9' }, 'c2');
  assert.equal(r.shown, true);
  assert.equal(r.banner.nickname, '阿澈');
  assert.equal(r.banner.summary, '在吗？');
  assert.equal(r.banner.messageId, 'm9');
  assert.equal(n.getUnread('c1'), 1);
  // 当前正在看的聊天：不弹窗，但未读照计
  const r2 = n.notifyInApp({ charId: 'c1', name: '阿澈', summary: '又一句', messageId: 'm10' }, 'c1');
  assert.equal(r2.shown, false);
  assert.equal(n.getUnread('c1'), 2);
  assert.equal(n.openBanner(r.banner.id).ok, true);
  assert.deepEqual(opened, [['c1', 'm9']]);
});

test('未读持久化：saveUnread / loadUnread 走 settings 表 notifyUnread 键', async () => {
  const db = new MemoryBackend();
  const n = new InAppNotifier();
  n.notify({ id: 'm1', charId: 'c1', nickname: 'A', content: 'hi' }, 'c2');
  n.notify({ id: 'm2', charId: 'c1', nickname: 'A', content: 'hi2' }, 'c2');
  n.notify({ id: 'm3', charId: 'c2', nickname: 'B', content: 'hi' }, 'c1');
  await saveUnread(db, n);
  const saved = await db.get('settings', NOTIFY_UNREAD_KEY);
  assert.deepEqual(saved.value, { c1: 2, c2: 1 });
  const n2 = new InAppNotifier();
  assert.equal(await loadUnread(db, n2), 3);
  assert.equal(n2.getUnread('c1'), 2);
  n2.markRead('c1');
  assert.equal(n2.getTotalUnread(), 1);
  // 脏快照：负数/非数字不恢复
  n2.restoreUnread({ c2: -5, c3: 'xx', c4: 2 });
  assert.equal(n2.getUnread('c4'), 2);
  assert.equal(n2.getUnread('c2'), 0);
});

test('通知设置区渲染：含横幅/提示音/振动/隐藏摘要/未读标记', () => {
  const c = fakeContainer();
  const html = renderNotifySettings(c, { settings: { hideSummary: true } });
  assert.match(html, /站内通知/);
  assert.match(html, /notify-banner/);
  assert.match(html, /notify-hide-summary/);
  assert.match(html, /有新消息/);
  assert.equal(c.innerHTML, html);
});

/* ---------- 任务 6：音频保活 ---------- */

function stubAudio({ rejectPlay = false } = {}) {
  return {
    src: '', loop: false, played: false,
    async play() { if (rejectPlay) { const e = new Error('play() failed'); e.name = 'NotAllowedError'; throw e; } this.played = true; },
    pause() { this.played = false; },
  };
}
function fakeTimers() {
  const fns = new Map(); let n = 0;
  return { fns, setInterval(fn) { const id = ++n; fns.set(id, fn); return id; }, clearInterval(id) { fns.delete(id); } };
}

test('音频状态机：启动→中断→手动恢复→停止；恢复不是自动重建', async () => {
  let plays = 0;
  const audio = stubAudio();
  const origPlay = audio.play.bind(audio);
  audio.play = async () => { plays += 1; await origPlay(); };
  const timers = fakeTimers();
  const k = new AudioKeepAlive({ createAudio: () => audio, timers, now: () => 1000 });
  assert.equal((await k.start({ userGesture: true })).ok, true);
  assert.equal(plays, 1);
  k.handleVisibility(true); // 切后台 → 中断
  assert.equal(k.getState().state, 'interrupted');
  assert.equal(timers.fns.size, 0);
  assert.equal(k.handleVisibility(false).state, 'interrupted'); // 回前台不自动恢复
  assert.equal(plays, 1);
  const r = await k.resume({ userGesture: true }); // 用户手动点恢复
  assert.equal(r.ok, true);
  assert.equal(k.getState().state, 'playing');
  assert.equal(plays, 2);
  k.stop();
  assert.equal(k.getState().state, 'idle');
  assert.equal(timers.fns.size, 0);
});

test('音频设置区渲染：含诚实说明、启动/恢复/停止按钮', () => {
  const c = fakeContainer();
  const k = new AudioKeepAlive({ createAudio: () => stubAudio(), timers: fakeTimers(), now: () => 0 });
  const html = renderKeepAliveSettings(c, { settings: { enabled: false }, keepAlive: k });
  assert.match(html, /音频保活/);
  assert.match(html, /播放成功 ≠ 保活成功/);
  assert.match(html, /keepalive-start/);
  assert.match(html, /keepalive-resume/);
  assert.match(html, /keepalive-stop/);
  assert.match(html, /未开启/);
});

/* ---------- 任务 7：自定义图标 ---------- */

function pngBytes(width, height) {
  const b = new Uint8Array(24);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  sig.forEach((v, i) => { b[i] = v; });
  const put32 = (off, v) => { b[off] = (v >>> 24) & 255; b[off + 1] = (v >>> 16) & 255; b[off + 2] = (v >>> 8) & 255; b[off + 3] = v & 255; };
  put32(16, width);
  put32(20, height);
  return b;
}

test('图标尺寸生成：readPngSize 读 IHDR；非正方形/太小拒绝；整包校验', () => {
  assert.deepEqual(readPngSize(pngBytes(512, 512)), { ok: true, width: 512, height: 512 });
  assert.equal(readPngSize(pngBytes(180, 192)).ok, true); // 能读，不校验形状
  assert.equal(readPngSize(new Uint8Array([1, 2, 3])).ok, false);
  assert.equal(validateIconPng(pngBytes(512, 512), { minSize: 512 }).ok, true);
  assert.equal(validateIconPng(pngBytes(512, 400), { minSize: 180 }).ok, false);
  assert.equal(validateIconPng(pngBytes(100, 100), { minSize: 180 }).ok, false);
  const pack = validateIconPackFiles({
    'apple-touch-icon.png': pngBytes(180, 180),
    'icon-192.png': pngBytes(192, 192),
    'icon-512.png': pngBytes(512, 512),
    'icon-512-maskable.png': pngBytes(512, 512),
  });
  assert.equal(pack.ok, true);
  const badPack = validateIconPackFiles({ 'icon-512.png': pngBytes(256, 256) });
  assert.equal(badPack.ok, false);
  assert.ok(badPack.errors.some((e) => e.includes('缺少')));
  assert.ok(badPack.errors.some((e) => e.includes('icon-512.png')));
  assert.deepEqual(ICON_SIZES.map((s) => `${s.size}/${s.purpose}`), ['180/apple-touch-icon', '192/any', '512/any', '512/maskable']);
});

test('图标导出：四档尺寸 + maskable 齐全（stub canvas）', () => {
  const calls = [];
  const factory = (size) => ({
    canvas: { toDataURL: () => `data:image/png;base64,size${size}` },
    ctx: { drawImage: (...a) => calls.push([size, ...a]) },
  });
  const r = exportIconPack(factory, { width: 400, height: 200 }, 'verweile');
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.file), ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-512-maskable.png']);
  assert.equal(calls.length, 4);
  // 400×200 源图：居中裁 200×200（x=100,y=0），不拉伸
  // calls[i] = [size, sourceImage, sx, sy, s, s, dx, dy, size, size]
  assert.deepEqual(calls[0].slice(2, 6), [100, 0, 200, 200]);
});

test('图标设置区渲染：含诚实说明、上传、应用名称、恢复默认', () => {
  const c = fakeContainer();
  const html = renderIconSettings(c, { settings: { appName: 'verweile', dataUrl: null } });
  assert.match(html, /主屏幕图标/);
  assert.match(html, /换图不用重新部署/);
  assert.match(html, /icon-file/);
  assert.match(html, /icon-appname/);
  assert.match(html, /icon-restore/);
  assert.match(html, /重新部署/);
});

/* ---------- 任务 8：系统推送 ---------- */

test('iOS 推送能力检测：Safari 直开不支持；主屏幕 Web App + 16.4 才支持', () => {
  assert.equal(detectIOSPush({ isIOS: false }).supported, null);
  const safari = detectIOSPush({ isIOS: true, isStandalone: false, iosVersion: 17 });
  assert.equal(safari.supported, false);
  assert.match(safari.reason, /添加到主屏幕/);
  const old = detectIOSPush({ isIOS: true, isStandalone: true, iosVersion: 16.2 });
  assert.equal(old.supported, false);
  assert.match(old.reason, /16\.4/);
  const ok = detectIOSPush({ isIOS: true, isStandalone: true, iosVersion: 17, hasServiceWorker: true, hasPushManager: true, permission: 'granted' });
  assert.equal(ok.supported, true);
  const denied = detectIOSPush({ isIOS: true, isStandalone: true, iosVersion: 17, hasServiceWorker: true, hasPushManager: true, permission: 'denied' });
  assert.equal(denied.supported, false);
  assert.match(denied.reason, /拒绝/);
});

test('推送设置区渲染：未配置时只写“未配置”，不写“可用”', () => {
  const c = fakeContainer();
  const html = renderPushSettings(c, {
    settings: { enabled: false, vapidPublicKey: '', pushServiceUrl: '' },
    env: { hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'default', configured: false, tested: false },
  });
  assert.match(html, /系统推送/);
  assert.match(html, /前端运行模式/);
  assert.match(html, /未配置/);
  assert.doesNotMatch(html, /系统推送<\/span><b>可用/);
  assert.match(html, /push-vapid/);
  assert.match(html, /push-service-url/);
  assert.match(html, /私钥只放服务器/);
  const caps = capabilityStatus({ hasServiceWorker: true, hasPushManager: true, hasNotification: true, permission: 'granted', configured: true, tested: true });
  assert.equal(caps.push, '可用');
});

test('sw.js：版本化缓存 + index.html 网络优先 + 绝不碰 IndexedDB', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const sw = readFileSync(resolve(root, 'sw.js'), 'utf8');
  assert.match(sw, /verweile-v\$\{VERSION\}/);
  assert.match(sw, /VERSION = '3'/);
  assert.match(sw, /caches\.delete/); // 只清旧版本缓存
  assert.doesNotMatch(sw, /indexedDB|deleteDatabase/);
  assert.match(sw, /notificationclick/);
  assert.match(sw, /Promise\.allSettled/); // manifest 缺失不拖垮全部缓存
});

/* ---------- 任务 9：主动唤醒 ---------- */

function engine(opts = {}) {
  return new WakeEngine({ store: createMemoryWakeStore(), clock: () => opts.now ?? Date.parse('2026-11-21T12:00:00+08:00'), lockStore: opts.lockStore ?? null, ...opts });
}

test('唤醒校验边界：无效时间/频率/过期一律拒绝', () => {
  assert.equal(validateSceneTiming({ cadenceMin: 4 }).ok, false);
  assert.equal(validateSceneTiming({ cadenceMin: 241 }).ok, false);
  assert.equal(validateSceneTiming({ cadenceMin: 5 }).ok, true);
  assert.equal(validateSceneTiming({ cadenceMin: 240 }).ok, true);
  assert.equal(validateSceneTiming({ durationMin: 9 }).ok, false);
  assert.equal(validateSceneTiming({ durationMin: 1441 }).ok, false);
  assert.equal(validateSceneTiming({ durationMin: 10 }).ok, true);
  assert.equal(validateWakeWhen('到家时叫我').ok, false);
  assert.equal(validateWakeWhen('').ok, true);
  assert.equal(validateWakeWhen(null).ok, true);
  const past = parseWakeToolCall({ action: 'set_alarm', at: '2020-01-01T00:00:00Z' }, Date.parse('2026-11-21T12:00:00+08:00'));
  assert.equal(past.ok, false);
  const badJson = parseWakeToolCall('不是 json');
  assert.equal(badJson.ok, false);
  const badSnooze = parseWakeToolCall({ action: 'snooze', minutes: 721 });
  assert.equal(badSnooze.ok, false);
  assert.equal(parseWakeToolCall({ action: 'snooze', minutes: 720 }).ok, true);
  const badRepeat = parseWakeToolCall({ action: 'set_repeat', sceneType: 'work', cadence_min: 3, duration_min: 60 });
  assert.equal(badRepeat.ok, false);
  const badWhen = parseWakeToolCall({ action: 'update_scene', sceneType: 'work', wake_when: '打开微信时叫我' });
  assert.equal(badWhen.ok, false);
  const good = parseWakeToolCall('```json\n{"action":"set_alarm","at":"2027-01-01T00:00:00Z","note":"起床"}\n```', Date.parse('2026-11-21T12:00:00+08:00'));
  assert.equal(good.ok, true);
  assert.equal(good.params.note, '起床');
});

test('applyWakeToolCall：校验后执行 set_alarm / snooze / end_scene（按角色隔离）', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true });
  const now = Date.parse('2026-11-21T12:00:00+08:00');
  const alarm = await e.applyWakeToolCall(parseWakeToolCall({ action: 'set_alarm', at: '2026-11-21T13:00:00+08:00', note: '开会' }, now), 'c1', now);
  assert.equal(alarm.ok, true);
  assert.equal(alarm.alarm.note, '开会');
  const sc = await e.startScene({ charId: 'c1', sceneType: 'work', nowMs: now });
  assert.equal(sc.ok, true);
  await e.startScene({ charId: 'c2', sceneType: 'work', nowMs: now });
  const snoozed = await e.applyWakeToolCall(parseWakeToolCall({ action: 'snooze', minutes: 60 }), 'c1', now);
  assert.equal(snoozed.ok, true);
  assert.equal(snoozed.snoozed, 1); // 只暂缓 c1 的，不动 c2 的
  const ended = await e.applyWakeToolCall(parseWakeToolCall({ action: 'end_scene', sceneType: 'work' }), 'c1', now);
  assert.equal(ended.ok, true);
  assert.equal(ended.scene.charId, 'c1');
  const remaining = (await e.store.getAll('wakeScenes')).filter((s) => s.status === 'active');
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].charId, 'c2');
  // 未校验的原始输入直接调 apply → 拒绝
  assert.equal((await e.applyWakeToolCall({ action: 'set_alarm', params: { at: 1 } }, 'c1', now)).ok, false);
  // update_scene：改节奏后 nextAt 顺延
  const upd = await e.applyWakeToolCall(parseWakeToolCall({ action: 'update_scene', sceneType: 'work', cadence_min: 30 }), 'c2', now);
  assert.equal(upd.ok, true);
  assert.equal(upd.scene.cadenceMin, 30);
});

test('冷却/上限：冷却期内与当日达上限时门禁拒绝', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true, cooldownMin: 10, maxWakesPerDay: 50, maxMessagesPerDay: 50 });
  const now = Date.parse('2026-11-21T12:00:00+08:00');
  assert.equal((await e.canWake('c1', now)).ok, true);
  // 记一条已完成回执（1 分钟前）→ 冷却期内拒绝（日上限 50，未触顶）
  await e.store.put('wakeReceipts', { wakeId: 'w1', charId: 'c1', acceptedAt: now - 60 * 1000, completedAt: now - 60 * 1000, notifiedAt: null, accepted: true, completed: true, notified: false, error: null, day: '2026-11-21', claim: null });
  const cooled = await e.canWake('c1', now);
  assert.equal(cooled.ok, false);
  assert.match(cooled.reason, /冷却/);
  // 冷却过后（11 分钟后）→ 放行
  assert.equal((await e.canWake('c1', now + 11 * 60 * 1000)).ok, true);
  // 把日上限收紧到 1（今天已有 1 条回执）→ 当日唤醒已达上限，仍拒绝
  await e.saveSettings({ maxWakesPerDay: 1, maxMessagesPerDay: 1 });
  const capped = await e.canWake('c1', now + 11 * 60 * 1000);
  assert.equal(capped.ok, false);
  assert.match(capped.reason, /上限/);
  // 次日重置
  const nextDay = await e.canWake('c1', now + 24 * 3600 * 1000);
  assert.equal(nextDay.ok, true);
});

test('多标签页互斥：同一 wakeId 第二个标签页认领失败；过期 claim 可回收', async () => {
  const locks = new Map();
  const lockStore = { getItem: (k) => locks.get(k) ?? null, setItem: (k, v) => locks.set(k, v), removeItem: (k) => locks.delete(k) };
  const store = createMemoryWakeStore();
  const now = Date.parse('2026-11-21T12:00:00+08:00');
  const a = new WakeEngine({ store, clock: () => now, lockStore, holderId: 'tab-A' });
  const b = new WakeEngine({ store, clock: () => now, lockStore, holderId: 'tab-B' });
  assert.equal((await a.claimWake('w1', now)).ok, true);
  const second = await b.claimWake('w1', now);
  assert.equal(second.ok, false);
  assert.match(second.reason, /另一标签页|已被认领/);
  // claim 过期（6 分钟后，TTL 5 分钟）→ B 可回收
  assert.equal((await b.claimWake('w1', now + 6 * 60 * 1000)).ok, true);
  // sendOnce 去重：已 notified 不再重复发
  let sends = 0;
  await a.markReceipt('w1', 'notified', true, now);
  const dup = await a.sendOnce('w1', async () => { sends += 1; return { delivered: true }; }, now);
  assert.equal(dup.deduped, true);
  assert.equal(sends, 0);
});

test('过期不补发：超宽限闹钟只标记过期；超宽限情境顺延不补发', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true });
  const now = Date.parse('2026-11-21T12:00:00+08:00');
  // 40 分钟前到期的闹钟（宽限 30 分钟）→ expired，不进 due
  await e.store.put('wakeAlarms', { id: 'a-old', charId: 'c1', at: now - 40 * 60 * 1000, note: '旧闹钟', status: 'pending', createdAt: now - 3600 * 1000 });
  // 40 分钟前到期的情境（未过期，有效期还剩很久）→ 不进 due，nextAt 顺延
  await e.store.put('wakeScenes', { id: 's-old', charId: 'c1', type: 'work', title: '工作', facts: [], cadenceMin: 60, durationMin: 600, startedAt: now - 3600 * 1000, expiresAt: now + 9 * 3600 * 1000, nextAt: now - 40 * 60 * 1000, status: 'active', snoozeUntil: null, note: null, wakeWhen: null });
  // 已过有效期的情境 → expired
  await e.store.put('wakeScenes', { id: 's-exp', charId: 'c1', type: 'outing', title: '外出', facts: [], cadenceMin: 30, durationMin: 60, startedAt: now - 2 * 3600 * 1000, expiresAt: now - 1000, nextAt: now - 1000, status: 'active', snoozeUntil: null, note: null, wakeWhen: null });
  const r = await e.checkDueOnForeground(now);
  assert.deepEqual(r.due, []);
  assert.equal(r.expired.length, 2);
  assert.equal((await e.store.get('wakeAlarms', 'a-old')).status, 'expired');
  assert.equal((await e.store.get('wakeScenes', 's-exp')).status, 'expired');
  const scene = await e.store.get('wakeScenes', 's-old');
  assert.equal(scene.status, 'active');
  assert.ok(scene.nextAt > now); // 顺延到现在+节奏，不补发
  // checkDue 纯函数同一结论
  const c = checkDue([scene], [], now + 1000);
  assert.deepEqual(c.dueScenes, []);
});

test('用户正在发言时唤醒回合让位；handleWakeOutcome 取消分支', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true });
  const now = Date.parse('2026-11-21T12:00:00+08:00');
  await e.store.put('wakeAlarms', { id: 'a1', charId: 'c1', at: now, note: '闹钟', status: 'pending', createdAt: now - 1000 });
  e.setUserTyping(true);
  const r = await e.checkDueOnForeground(now);
  assert.equal(r.skipped, 'user-typing');
  assert.deepEqual(r.due, []);
  assert.equal((await e.store.get('wakeAlarms', 'a1')).status, 'pending'); // 未领取、未消耗
  const out = await e.handleWakeOutcome('w9', { decision: 'send', message: 'hi' });
  assert.equal(out.ok, false);
  assert.equal(out.decision, 'cancelled');
});

test('拼接打包防冲突：ORDER 文件 + 5 个 B 模块之间无重复顶层导出名', () => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const buildSrc = readFileSync(resolve(root, 'scripts/build-preview.mjs'), 'utf8');
  const order = [...buildSrc.matchAll(/'((?:js|scripts)\/[^']+\.m?js)'/g)].map((m) => m[1]);
  const extra = ['js/inAppNotify.js', 'js/audioKeepAlive.js', 'js/pushNotify.js', 'js/customIcon.js', 'js/wakeEngine.js'];
  const seen = new Map();
  const dupes = [];
  for (const f of [...new Set([...order, ...extra])]) {
    const src = readFileSync(resolve(root, f), 'utf8');
    for (const m of src.matchAll(/^export\s+(?:async\s+function|function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
      if (seen.has(m[1])) dupes.push(`${m[1]}（${seen.get(m[1])} 与 ${f}）`);
      else seen.set(m[1], f);
    }
  }
  assert.deepEqual(dupes, []);
});

test('唤醒设置区渲染：含总开关、免打扰、冷却/上限与前端运行模式说明', () => {
  const c = fakeContainer();
  const html = renderWakeSettings(c, {
    settings: { ...DEFAULT_WAKE_SETTINGS },
    chars: [{ id: 'c1', name: '阿澈' }],
  });
  assert.match(html, /主动唤醒/);
  assert.match(html, /wake-enabled/);
  assert.match(html, /免打扰/);
  assert.match(html, /wake-cooldown/);
  assert.match(html, /wake-max-wakes/);
  assert.match(html, /前端运行模式/);
  assert.match(html, /阿澈/);
  assert.match(html, /先别发/);
});
