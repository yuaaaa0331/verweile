import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWakeToolCall, validateSceneTiming, validateWakeWhen, checkDue,
  buildWakeReport, classifyUserMessage, isInDnd, cstDayKey,
  WakeEngine, createMemoryWakeStore, tryClaimLock,
  CADENCE_MIN, CADENCE_MAX, DURATION_MIN, DURATION_MAX, NOTE_MAX_READS,
  WAKE_EXPLAIN_TEXT, WAKE_MODE_TEXT,
} from '../js/wakeEngine.js';
import { ensureWakeStores } from '../js/storage.js'; // 建表唯一实现在 storage.js（v3→v4），wakeEngine 不再重复导出

const NOW = Date.parse('2026-11-21T12:00:00+08:00');

function fakeLockStore() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    removeItem: (k) => m.delete(k),
  };
}
function engine(opts = {}) {
  return new WakeEngine({ store: createMemoryWakeStore(), clock: () => NOW, lockStore: fakeLockStore(), ...opts });
}

test('工具校验边界值：cadence 上下限、duration 上下限', () => {
  assert.equal(validateSceneTiming({ cadenceMin: CADENCE_MIN }).ok, true);
  assert.equal(validateSceneTiming({ cadenceMin: CADENCE_MAX }).ok, true);
  assert.equal(validateSceneTiming({ cadenceMin: CADENCE_MIN - 1 }).ok, false);
  assert.equal(validateSceneTiming({ cadenceMin: CADENCE_MAX + 1 }).ok, false);
  assert.equal(validateSceneTiming({ durationMin: DURATION_MIN }).ok, true);
  assert.equal(validateSceneTiming({ durationMin: DURATION_MAX }).ok, true);
  assert.equal(validateSceneTiming({ durationMin: DURATION_MIN - 1 }).ok, false);
  assert.equal(validateSceneTiming({ durationMin: DURATION_MAX + 1 }).ok, false);
  const r = parseWakeToolCall({ action: 'set_repeat', sceneType: 'work', cadence_min: 4 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /cadence/);
});

test('工具解析：过期闹钟拒绝；未来闹钟通过；未知动作拒绝', () => {
  const past = parseWakeToolCall(JSON.stringify({ action: 'set_alarm', at: '2020-01-01T00:00:00Z' }));
  assert.equal(past.ok, false);
  assert.match(past.reason, /未来时间/);
  const future = parseWakeToolCall('```json\n{"action":"set_alarm","at":"2999-01-01T00:00:00Z","note":"叫我"}\n```');
  assert.equal(future.ok, true);
  assert.equal(future.action, 'set_alarm');
  const bad = parseWakeToolCall({ action: 'fly_to_moon' });
  assert.equal(bad.ok, false);
  const badJson = parseWakeToolCall('没有 JSON');
  assert.equal(badJson.ok, false);
});

test('wake_when 第一阶段一律拒绝', () => {
  assert.equal(validateWakeWhen('到家时叫我').ok, false);
  assert.match(validateWakeWhen('打开微信时叫我').reason, /第一阶段不支持/);
  assert.equal(validateWakeWhen(null).ok, true);
  assert.equal(validateWakeWhen('').ok, true);
  const r = parseWakeToolCall({ action: 'update_scene', sceneType: 'work', wake_when: '到家时叫我' });
  assert.equal(r.ok, false);
});

test('字条三次读取上限：读满 3 次后不再提供；换版本后重新计数', async () => {
  const e = engine();
  const { scene } = await e.startScene({ charId: 'c1', sceneType: 'work' });
  await e.setNote(scene.id, '下次问他那件事');
  let s = await e.store.get('wakeScenes', scene.id);
  assert.equal(e.readNote(s)?.text, '下次问他那件事');
  // 模拟三次成功完成消费
  for (let i = 0; i < NOTE_MAX_READS; i++) {
    await e.consumeNotes([{ sceneId: scene.id, version: 1 }]);
  }
  s = await e.store.get('wakeScenes', scene.id);
  assert.equal(s.note.reads, 3);
  assert.equal(e.readNote(s), null);
  // 旧版本引用不再扣次数
  await e.setNote(scene.id, '新字条');
  await e.consumeNotes([{ sceneId: scene.id, version: 1 }]); // 旧版本
  s = await e.store.get('wakeScenes', scene.id);
  assert.equal(s.note.reads, 0);
  assert.equal(s.note.version, 2);
});

test('回执去重：同一 wakeId 重试不重复发', async () => {
  const e = engine();
  let sends = 0;
  const sendFn = async () => { sends += 1; return { delivered: true }; };
  const r1 = await e.sendOnce('wake_1', sendFn);
  assert.equal(r1.delivered, true);
  assert.equal(r1.deduped, false);
  const r2 = await e.sendOnce('wake_1', sendFn);
  assert.equal(r2.deduped, true);
  assert.equal(sends, 1);
  // 回执三分开记
  const receipt = await e.store.get('wakeReceipts', 'wake_1');
  assert.equal(receipt.notified, true);
  assert.equal(receipt.completed, false); // sendOnce 只记 notified，不冒充 completed
});

test('过期安排不补发：超宽限闹钟标记过期；超有效期情境标记过期', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true });
  // 闹钟 1 小时前到期（宽限 30 分钟）→ 过期
  await e.store.put('wakeAlarms', { id: 'a_old', charId: 'c1', at: NOW - 3600 * 1000, note: '旧闹钟', status: 'pending', createdAt: NOW - 7200 * 1000 });
  // 闹钟 5 分钟前到期 → 应触发
  await e.store.put('wakeAlarms', { id: 'a_new', charId: 'c1', at: NOW - 5 * 60 * 1000, note: '新闹钟', status: 'pending', createdAt: NOW - 3600 * 1000 });
  // 情境已过有效期 → 过期
  await e.store.put('wakeScenes', { id: 's_old', charId: 'c1', type: 'work', title: '工作', facts: [], cadenceMin: 60, durationMin: 60, startedAt: NOW - 7200 * 1000, expiresAt: NOW - 1000, nextAt: NOW - 3600 * 1000, status: 'active', snoozeUntil: null, note: null, wakeWhen: null });
  const { due, expired } = await e.checkDueOnForeground(NOW);
  assert.equal(expired.some((x) => x.id === 'a_old'), true);
  assert.equal(expired.some((x) => x.id === 's_old'), true);
  assert.equal(due.length, 1);
  assert.equal(due[0].alarms[0].id, 'a_new');
  const aOld = await e.store.get('wakeAlarms', 'a_old');
  assert.equal(aOld.status, 'expired');
});

test('checkDue 纯函数：未到时间不触发；snooze 中的情境不触发', () => {
  const scenes = [
    { id: 's1', status: 'active', nextAt: NOW - 1000, expiresAt: NOW + 3600 * 1000, snoozeUntil: null },
    { id: 's2', status: 'active', nextAt: NOW - 1000, expiresAt: NOW + 3600 * 1000, snoozeUntil: NOW + 3600 * 1000 },
    { id: 's3', status: 'active', nextAt: NOW + 3600 * 1000, expiresAt: NOW + 7200 * 1000, snoozeUntil: null },
  ];
  const { dueScenes } = checkDue(scenes, [], NOW);
  assert.deepEqual(dueScenes.map((s) => s.id), ['s1']);
});

test('用户发言时唤醒让位：checkDueOnForeground 跳过；handleWakeOutcome 取消', async () => {
  const e = engine();
  await e.saveSettings({ enabled: true });
  await e.store.put('wakeAlarms', { id: 'a1', charId: 'c1', at: NOW - 1000, note: '', status: 'pending', createdAt: NOW - 1000 });
  e.setUserTyping(true);
  assert.equal(e.isUserTyping(), true);
  const r = await e.checkDueOnForeground(NOW);
  assert.equal(r.due.length, 0);
  assert.equal(r.skipped, 'user-typing');
  const out = await e.handleWakeOutcome('wake_x', { decision: 'send', message: 'hi' });
  assert.equal(out.ok, false);
  assert.equal(out.decision, 'cancelled');
  const c = e.cancelWake('wake_y', '测试取消');
  assert.equal(c.cancelled, true);
});

test('多标签页认领互斥：同一 wakeId 只有一个持有者', async () => {
  const shared = fakeLockStore();
  const e1 = engine({ lockStore: shared, holderId: 'tab-A' });
  const e2 = engine({ lockStore: shared, holderId: 'tab-B' });
  const c1 = await e1.claimWake('wake_shared', NOW);
  assert.equal(c1.ok, true);
  const c2 = await e2.claimWake('wake_shared', NOW);
  assert.equal(c2.ok, false);
  assert.match(c2.reason, /另一标签页/);
  // 过期 claim 可回收
  const c3 = await e2.claimWake('wake_shared', NOW + 6 * 60 * 1000);
  assert.equal(c3.ok, true);
  // tryClaimLock 纯函数同样互斥
  assert.equal(tryClaimLock(shared, 'k1', 'h1', NOW).ok, true);
  assert.equal(tryClaimLock(shared, 'k1', 'h2', NOW).ok, false);
});

test('明确表达分类：关键词快路径；SLM 失败不建情境', async () => {
  const kw = await classifyUserMessage('晚安，我去睡了', null);
  assert.equal(kw.source, 'keyword');
  assert.equal(kw.deltas[0].sceneType, 'bedtime');
  const back = await classifyUserMessage('我回来了', null);
  assert.ok(back.deltas.some((d) => d.action === 'end'));
  const quiet = await classifyUserMessage('先别发消息', null);
  assert.equal(quiet.deltas[0].action, 'snooze');
  const failingSlm = async () => { throw new Error('slm down'); };
  const r = await classifyUserMessage('今天天气不错', failingSlm);
  assert.deepEqual(r.deltas, []);
  assert.equal(r.source, 'slm-failed');
  // userMessage 应用增量
  const e = engine({ slmClient: null });
  const applied = await e.userMessage('c1', 'm1', '晚安，我去睡了');
  assert.ok(applied.applied.some((a) => a.sceneType === 'bedtime'));
});

test('唤醒报告：完整/精简轮换；不含位置/App/健康推断', () => {
  const scenes = [{ id: 's1', type: 'work', title: '赶稿', facts: ['截稿明天'] }];
  const full = buildWakeReport({ trigger: '情境到了', scenes, wakeCount: 1 });
  assert.equal(full.full, true);
  const slim = buildWakeReport({ trigger: '情境到了', scenes, wakeCount: 2 });
  assert.equal(slim.full, false);
  assert.match(full.text, /赶稿/);
  assert.match(full.text, /不含位置、App 使用、健康数据/);
  assert.doesNotMatch(full.text, /到家|打开微信|心率/);
});

test('门禁：默认关闭；免打扰；每日上限按 UTC+8 自然日计', async () => {
  const e = engine();
  assert.equal(e.isBackendConfigured(), false);
  assert.match(WAKE_MODE_TEXT, /前端运行模式/);
  assert.match(WAKE_EXPLAIN_TEXT, /先别发/);
  assert.equal((await e.canWake('c1')).ok, false); // 默认关闭
  await e.saveSettings({ enabled: true, dnd: { enabled: true, start: '00:00', end: '23:59' } });
  assert.equal((await e.canWake('c1')).ok, false);
  await e.saveSettings({ dnd: { enabled: false, start: '23:00', end: '08:00' } });
  assert.equal((await e.canWake('c1')).ok, true);
  assert.equal(isInDnd({ enabled: true, start: '23:00', end: '08:00' }, Date.parse('2026-11-21T00:30:00+08:00')), true);
  assert.equal(isInDnd({ enabled: true, start: '23:00', end: '08:00' }, Date.parse('2026-11-21T12:00:00+08:00')), false);
  assert.equal(cstDayKey(Date.parse('2026-11-21T00:30:00+08:00')), '2026-11-21');
  assert.equal(cstDayKey(Date.parse('2026-11-20T23:30:00Z')), '2026-11-21'); // UTC 23:30 = CST 次日 07:30
});

test('唤醒结果三分支：send / skip / reschedule（无效工具调用拒绝）', async () => {
  const e = engine();
  const s = await e.handleWakeOutcome('w1', { decision: 'send', message: '在吗' });
  assert.equal(s.decision, 'send');
  const k = await e.handleWakeOutcome('w2', { decision: 'skip' });
  assert.equal(k.decision, 'skip');
  const bad = await e.handleWakeOutcome('w3', { decision: 'reschedule', toolCall: { action: 'set_alarm', at: '2020-01-01T00:00:00Z' } });
  assert.equal(bad.ok, false);
  const good = await e.handleWakeOutcome('w4', { decision: 'reschedule', toolCall: { action: 'snooze', minutes: 30 } });
  assert.equal(good.ok, true);
  assert.equal(good.toolCall.params.minutes, 30);
});

test('ensureWakeStores（storage.js 的唯一实现）：假 db 建表三张，不重复建', () => {
  const created = [];
  const fakeDb = {
    objectStoreNames: { _s: new Set(), contains(n) { return this._s.has(n); } },
    createObjectStore(name) { this.objectStoreNames._s.add(name); created.push(name); return { createIndex() {} }; },
  };
  ensureWakeStores(fakeDb);
  assert.deepEqual(created.sort(), ['wakeAlarms', 'wakeReceipts', 'wakeScenes']);
  ensureWakeStores(fakeDb);
  assert.equal(created.length, 3);
});
