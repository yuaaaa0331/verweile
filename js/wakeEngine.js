// wakeEngine.js — 主动唤醒引擎（前端运行版）。
// 机制来源：KKarsyline/wake_UP（PolyForm Noncommercial 1.0.0），
// 本文件为用自有 JS 重写的实现，未复制原项目的 Python 代码。
// 原项目只作机制参考：情境 scene（cadence/lifetime/priority 默认值）、
// 闹钟、短期字条（最多成功读三次、版本核对）、回执三分
// （accepted/completed/notified 分开记）、用户发言时唤醒回合让位。
// 明确不做：wake_when 的位置 / App / 健康条件——网页拿不到这些数据，
// 不能假装知道；相关字段一律拒绝，见 validateWakeWhen()。
// 存储：新 store 名 wakeScenes / wakeAlarms / wakeReceipts，schema 见
// WAKE_STORE_SCHEMA；建表迁移在 js/storage.js 的 ensureWakeStores（v3→v4，
// 本文件不重复定义，避免 build-preview.mjs 拼接后同名顶层函数冲突），本文件接受任何实现
// get/put/getAll/delete 的 store，默认用内存 store（createMemoryWakeStore），便于 Node 测试。
// 时间：持久化时间戳用 UTC 毫秒；自然日、免打扰时段按固定 UTC+08:00 计，
// 不跟随机器本地时区。

export const WAKE_STORE_SCHEMA = {
wakeScenes: {
keyPath: 'id',
indexes: { byChar: ['charId', 'nextAt'], byStatus: ['status', 'nextAt']},
fields: {
id: 'string', charId: 'string', type: 'scene 类型', title: 'string',
facts: 'string[]', cadenceMin: 'number（分钟）', durationMin: 'number（分钟）',
startedAt: 'number UTC ms', expiresAt: 'number UTC ms', nextAt: 'number UTC ms',
status: "'active' | 'snoozed' | 'ended' | 'expired'",
snoozeUntil: 'number|null UTC ms',
note: '{ text, version, reads} | null（字条）',
wakeWhen: 'null（第一阶段不支持，恒为 null）',
},
},
wakeAlarms: {
keyPath: 'id',
indexes: { byChar: ['charId', 'at']},
fields: {
id: 'string', charId: 'string', at: 'number UTC ms（未来时间）',
note: 'string', status: "'pending' | 'fired' | 'expired' | 'cancelled'",
createdAt: 'number UTC ms',
},
},
wakeReceipts: {
keyPath: 'wakeId',
indexes: {},
fields: {
wakeId: 'string', trigger: 'string', charId: 'string',
acceptedAt: 'number|null', completedAt: 'number|null', notifiedAt: 'number|null',
accepted: 'boolean|null（未知为 null）', completed: 'boolean',
notified: 'boolean', error: 'string|null',
claim: '{ holder, expiresAt} | null',
},
},
};

/** 供 settings store（settings 表，key='wakeSettings'）保存的设置形状。 */
export const WAKE_SETTINGS_KEY = 'wakeSettings';
export const DEFAULT_WAKE_SETTINGS = {
enabled: false, // 总开关，默认关闭
perChar: {}, // charId -> boolean，角色独立开关（未写明时视为开启）
dnd: { enabled: false, start: '23:00', end: '08:00'}, // 免打扰，按 UTC+8
cooldownMin: 10, // 两次唤醒之间最短间隔
maxWakesPerDay: 50, // 每日唤醒上限，按 UTC+8 自然日计
maxMessagesPerDay: 50, // 每日主动消息上限，按 UTC+8 自然日计
patrolIntervalMin: 15, // 巡检间隔（前端运行版仅在页面可见时检查）
};

export const CADENCE_MIN = 5;
export const CADENCE_MAX = 240;
export const DURATION_MIN = 10;
export const DURATION_MAX = 1440;
export const SNOOZE_MIN = 5;
export const SNOOZE_MAX = 720;
export const NOTE_MAX_READS = 3;
export const ALARM_GRACE_MS = 30 * 60 * 1000; // 闹钟过期宽限：超过 30 分钟不再补发
export const SCENE_GRACE_MS = 30 * 60 * 1000;
export const CLAIM_TTL_MS = 5 * 60 * 1000;
export const MAX_DELTAS_PER_MESSAGE = 3;

/** 情境类型与默认节奏/有效期/优先级（源自 wake_UP 文档默认值）。 */
export const SCENE_DEFAULTS = {
outing: { cadenceMin: 30, durationMin: 480, priority: 50, label: '外出'},
work: { cadenceMin: 60, durationMin: 600, priority: 40, label: '工作'},
bedtime: { cadenceMin: 45, durationMin: 600, priority: 55, label: '睡前'},
morning: { cadenceMin: 20, durationMin: 180, priority: 60, label: '早晨'},
active_without_chat: { cadenceMin: 30, durationMin: 240, priority: 45, label: '设备活跃未回聊'},
silence_escalation: { cadenceMin: 15, durationMin: 240, priority: 65, label: '约定未回复跟进'},
repeat: { cadenceMin: 10, durationMin: 180, priority: 70, label: '重复唤醒'},
private_play: { cadenceMin: 10, durationMin: 60, priority: 100, label: '私密游玩'},
sulking: { cadenceMin: 20, durationMin: 480, priority: 75, label: '闹别扭'},
custom: { cadenceMin: 45, durationMin: 360, priority: 35, label: '自定义'},
};
export const SCENE_TYPES = Object.keys(SCENE_DEFAULTS);

export const WAKE_EXPLAIN_TEXT = [
'主动唤醒开启后，我会在以下情况回来找你：你让我设的闹钟到了；',
'你说过正在做的事（比如出门、工作、睡前）到了该看看的时间；',
'或者你让我每隔一段时间来一次。',
'我只在你打开这个页面、它在前台时检查时间；关掉页面、锁屏或切到后台后，',
'我不会在后台一直跑，也不会补发你错过的大量旧消息。',
'你可以随时说“先别发”“晚安”“我回来了”让我暂停或结束。',
].join('');

export const WAKE_MODE_TEXT = [
'当前是前端运行模式：唤醒只在页面打开且可见时检查。',
'音频保活、Service Worker、本地定时器都不能充当后台常驻服务，',
'页面关闭或进入后台后唤醒不会继续；需要真后台请配置可选的 wake-push-service，',
'未配置时本说明保持不变，不假装有后台能力。',
].join('');

export const WAKE_HONESTY_TEXT = '唤醒检查只在前台运行；过期安排按有效期直接标记过期，绝不补发大量旧消息。位置、App 打开、健康数据本阶段一律不采集、不推断。';

export function wakeUid(prefix = 'wake') {
return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/** UTC+8 自然日键，如 '2026-11-21'。 */
export function cstDayKey(ms) {
const d = new Date(ms + 8 * 3600 * 1000);
return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** UTC+8 当天分钟数（用于免打扰时段判断）。 */
export function cstMinutesOfDay(ms) {
const d = new Date(ms + 8 * 3600 * 1000);
return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function parseHHMM(s) {
const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
if (!m) return null;
const h = Number(m[1]); const min = Number(m[2]);
if (h > 23 || min > 59) return null;
return h * 60 + min;
}

/** 免打扰判断（纯函数）：时段可跨午夜。 */
export function isInDnd(dnd, nowMs) {
if (!dnd?.enabled) return false;
const start = parseHHMM(dnd.start); const end = parseHHMM(dnd.end);
if (start === null || end === null) return false;
const cur = cstMinutesOfDay(nowMs);
if (start === end) return false;
return start < end? (cur >= start && cur < end): (cur >= start || cur < end);
}

/** 校验节奏/有效期。返回 { ok, errors[]}。 */
export function validateSceneTiming({ cadenceMin, durationMin}) {
const errors = [];
if (cadenceMin!== undefined && cadenceMin!== null) {
if (!Number.isFinite(cadenceMin) || cadenceMin < CADENCE_MIN || cadenceMin > CADENCE_MAX) {
errors.push(`cadence_min 须在 ${CADENCE_MIN}–${CADENCE_MAX} 分钟之间`);
}
}
if (durationMin!== undefined && durationMin!== null) {
if (!Number.isFinite(durationMin) || durationMin < DURATION_MIN || durationMin > DURATION_MAX) {
errors.push(`duration_min 须在 ${DURATION_MIN}–${DURATION_MAX} 分钟之间`);
}
}
return { ok: errors.length === 0, errors};
}

/**
* wake_when 第一阶段一律拒绝：网页拿不到位置 / App / 健康数据，
* 收到任何非空 wake_when 都返回拒绝，不静默忽略、不假装支持。
*/
export function validateWakeWhen(value) {
if (value === undefined || value === null || value === '') return { ok: true};
return {
ok: false,
reason: 'wake_when（位置/App/健康条件）第一阶段不支持：网页拿不到这些数据，不能假装知道。请改用闹钟或固定间隔。',
};
}

/**
* 解析模型在回复里用结构化字段提出的安排。
* 接受对象或含 JSON 的文本（支持 ```json 代码块或裸 JSON）。
* 动作：set_alarm / set_repeat / snooze / end_scene / update_scene /
* set_note / clear_note。返回 { ok, action, params} 或 { ok:false, reason}。
* 无效安排一律拒绝并给出原因，不执行。
*/
export function parseWakeToolCall(input, nowMs = Date.now()) {
let obj = input;
if (typeof input === 'string') {
const m = input.match(/```(?:json)?\s*([\s\S]*?)```/) || input.match(/(\{[\s\S]*\})/);
if (!m) return { ok: false, reason: '没有找到结构化的唤醒安排（需要一个 JSON 对象，含 action 字段）。'};
try { obj = JSON.parse(m[1]);} catch { return { ok: false, reason: '唤醒安排不是合法 JSON，拒绝执行。'};}
}
if (!obj || typeof obj!== 'object' || Array.isArray(obj)) {
return { ok: false, reason: '唤醒安排须为对象。'};
}
const action = obj.action;
const fail = (reason) => ({ ok: false, reason});
const needSceneRef = () => {
if (obj.sceneId) return { sceneId: String(obj.sceneId)};
if (obj.sceneType) {
if (!SCENE_TYPES.includes(obj.sceneType)) return null;
return { sceneType: obj.sceneType};
}
return null;
};
switch (action) {
case 'set_alarm': {
const at = Date.parse(obj.at);
if (!Number.isFinite(at)) return fail('set_alarm 需要合法的未来 ISO 时间 at。');
if (at <= nowMs) return fail('set_alarm 的时间必须是未来时间，过期闹钟拒绝。');
return { ok: true, action, params: { at, note: String(obj.note || ''), charId: obj.charId? String(obj.charId): undefined}};
}
case 'set_repeat': {
if (!SCENE_TYPES.includes(obj.sceneType)) return fail(`set_repeat 的 sceneType 不合法：${obj.sceneType}`);
const v = validateSceneTiming({ cadenceMin: obj.cadence_min, durationMin: obj.duration_min});
if (!v.ok) return fail(v.errors.join('；'));
return { ok: true, action, params: { sceneType: obj.sceneType, cadenceMin: obj.cadence_min, durationMin: obj.duration_min, title: obj.title? String(obj.title): undefined, charId: obj.charId? String(obj.charId): undefined}};
}
case 'snooze': {
const minutes = Number(obj.minutes);
if (!Number.isFinite(minutes) || minutes < SNOOZE_MIN || minutes > SNOOZE_MAX) {
return fail(`snooze 时长须在 ${SNOOZE_MIN}–${SNOOZE_MAX} 分钟之间`);
}
return { ok: true, action, params: { minutes, sceneId: obj.sceneId? String(obj.sceneId): undefined}};
}
case 'end_scene': {
const ref = needSceneRef();
if (!ref) return fail('end_scene 需要 sceneId 或合法的 sceneType。');
return { ok: true, action, params: {...ref, recreateAfterMinutes: obj.recreate_after_minutes!== undefined? Number(obj.recreate_after_minutes): undefined}};
}
case 'update_scene': {
const ref = needSceneRef();
if (!ref) return fail('update_scene 需要 sceneId 或合法的 sceneType。');
const v = validateSceneTiming({ cadenceMin: obj.cadence_min, durationMin: obj.duration_min});
if (!v.ok) return fail(v.errors.join('；'));
const ww = validateWakeWhen(obj.wake_when);
if (!ww.ok) return fail(ww.reason);
return { ok: true, action, params: {...ref, cadenceMin: obj.cadence_min, durationMin: obj.duration_min, title: obj.title? String(obj.title): undefined, facts: Array.isArray(obj.facts)? obj.facts.map(String): undefined}};
}
case 'set_note': {
if (!obj.sceneId || typeof obj.note!== 'string' ||!obj.note.trim()) return fail('set_note 需要 sceneId 与非空 note。');
return { ok: true, action, params: { sceneId: String(obj.sceneId), note: obj.note}};
}
case 'clear_note': {
if (!obj.sceneId) return fail('clear_note 需要 sceneId。');
return { ok: true, action, params: { sceneId: String(obj.sceneId)}};
}
default:
return fail(`未知的唤醒动作：${String(action)}。支持 set_alarm / set_repeat / snooze / end_scene / update_scene / set_note / clear_note。`);
}
}

// ---- 明确表达：关键词快路径 ----
const KEYWORD_RULES = [
{ re: /晚安|去睡|睡觉|睡了|我要睡/, deltas: [{ action: 'start', sceneType: 'bedtime'}]},
{ re: /出门|出去一趟|外出|出趟门/, deltas: [{ action: 'start', sceneType: 'outing'}]},
{ re: /上班|工作|学习|要忙|开会/, deltas: [{ action: 'start', sceneType: 'work'}]},
{ re: /我回来了|回来了|到家了|做完了|忙完了|下班了/, deltas: [{ action: 'end', sceneType: 'outing'}, { action: 'end', sceneType: 'work'}]},
{ re: /先别发|别来找我|别打扰|安静一会|安静会儿|别烦我/, deltas: [{ action: 'snooze', minutes: 60}]},
{ re: /每隔|隔.*分钟|每.*分钟.*一次/, deltas: [{ action: 'start', sceneType: 'repeat'}]},
];

function keywordDeltas(text) {
const out = [];
for (const rule of KEYWORD_RULES) {
if (rule.re.test(text)) out.push(...rule.deltas);
if (out.length >= MAX_DELTAS_PER_MESSAGE) break;
}
return out.slice(0, MAX_DELTAS_PER_MESSAGE);
}

function sanitizeDeltas(raw) {
if (!Array.isArray(raw)) return [];
const out = [];
for (const d of raw.slice(0, MAX_DELTAS_PER_MESSAGE)) {
if (!d || typeof d!== 'object') continue;
if (!['start', 'update', 'end', 'snooze'].includes(d.action)) continue;
if (d.action === 'snooze') {
const minutes = Number(d.minutes);
if (Number.isFinite(minutes) && minutes >= SNOOZE_MIN && minutes <= SNOOZE_MAX) out.push({ action: 'snooze', minutes});
continue;
}
if (!SCENE_TYPES.includes(d.scene_type)) continue;
const v = validateSceneTiming({ cadenceMin: d.cadence_min, durationMin: d.duration_min});
if (!v.ok) continue;
out.push({
action: d.action, sceneType: d.scene_type,
facts: Array.isArray(d.facts)? d.facts.map(String).slice(0, 10): undefined,
cadenceMin: d.cadence_min, durationMin: d.duration_min,
});
}
return out;
}

/**
* 用户消息分类：先走关键词快路径；无命中且给了 slmClient 时再调
* 总结副 API 的 SLM 分类。slmClient 须是 async ({ system, userContent}) =>
* 已解析的 JSON 对象（集成时用 auxApi.callSummaryChat 包装）。
* 分类失败时返回空 deltas，不建/不改情境。
*/
export async function classifyUserMessage(text, slmClient) {
const t = String(text || '');
const kw = keywordDeltas(t);
if (kw.length) return { deltas: kw, source: 'keyword'};
if (typeof slmClient!== 'function') return { deltas: [], source: 'none'};
try {
const res = await slmClient({
system: '你是情境分类器。只输出 JSON：{"deltas":[{"action":"start|update|end","scene_type":"outing|work|bedtime|morning|active_without_chat|silence_escalation|repeat|private_play|sulking|custom","facts":[],"cadence_min":null,"duration_min":null}],"reason":"..."}。没有明确情境变化时 deltas 为空数组。',
userContent: t,
});
return { deltas: sanitizeDeltas(res?.deltas), source: 'slm'};
} catch {
return { deltas: [], source: 'slm-failed'};
}
}

/**
* 到期检查（纯函数，可测试）。
* scenes: [{id,type,nextAt,expiresAt,status,snoozeUntil,...}]
* alarms: [{id,at,status,...}]
* 返回 { dueAlarms, dueScenes, expiredAlarms, expiredScenes}。
* 过期安排（闹钟超宽限、情境超有效期）直接进 expired，绝不补发。
*/
export function checkDue(scenes, alarms, nowMs, opts = {}) {
const alarmGrace = opts.alarmGraceMs?? ALARM_GRACE_MS;
const sceneGrace = opts.sceneGraceMs?? SCENE_GRACE_MS;
const dueAlarms = []; const expiredAlarms = [];
for (const a of alarms || []) {
if (a.status!== 'pending') continue;
if (nowMs < a.at) continue;
if (nowMs - a.at <= alarmGrace) dueAlarms.push(a);
else expiredAlarms.push(a);
}
const dueScenes = []; const expiredScenes = [];
for (const s of scenes || []) {
if (s.status!== 'active') continue;
if (s.snoozeUntil && nowMs < s.snoozeUntil) continue;
if (nowMs >= s.expiresAt) { expiredScenes.push(s); continue;}
if (nowMs >= s.nextAt && nowMs - s.nextAt <= sceneGrace) dueScenes.push(s);
else if (nowMs >= s.nextAt) {
// 超过宽限但未到有效期：跳过本轮，不补发，下次时间顺延到现在+节奏
// （调用方据此更新 nextAt；这里不把它算进 due，也不算 expired）
}
}
return { dueAlarms, dueScenes, expiredAlarms, expiredScenes};
}

/**
* 组装唤醒报告：触发原因 + 有效情境 + 字条，不含任何位置/App/健康推断。
* wakeCount 从 1 开始：第 1、6、11……次用完整报告，其余精简。
*/
export function buildWakeReport({ trigger, scenes = [], notes = [], wakeCount = 1, charId} = {}) {
const full = ((wakeCount - 1) % 5) === 0;
const sceneLines = [...scenes]
.sort((a, b) => (SCENE_DEFAULTS[b.type]?.priority || 0) - (SCENE_DEFAULTS[a.type]?.priority || 0))
.map((s) => `- ${SCENE_DEFAULTS[s.type]?.label || s.type}${s.title? `「${s.title}」`: ''}${(s.facts || []).length? `：${s.facts.join('；')}`: ''}`);
const noteLines = notes
.filter((n) => n && n.text)
.map((n) => `- （字条 v${n.version}，第 ${n.reads + 1}/${NOTE_MAX_READS} 次读）${n.text}`);
const lines = [
full? '': '',
`触发原因：${trigger || '到时检查'}`,
charId? `角色：${charId}`: null,
sceneLines.length? `有效情境：\n${sceneLines.join('\n')}`: '有效情境：无',
noteLines.length? `短期字条：\n${noteLines.join('\n')}`: '短期字条：无',
'说明：本报告不含位置、App 使用、健康数据（本阶段不采集）。',
].filter(Boolean);
return {
text: lines.join('\n'),
full,
trigger: trigger || '到时检查',
scenes: scenes.map((s) => ({ id: s.id, type: s.type, title: s.title || null})),
notes: notes.filter((n) => n && n.text).map((n) => ({ sceneId: n.sceneId, version: n.version, reads: n.reads})),
};
}

/** 内存 store：与 storage.js 后端同接口（get/put/getAll/delete），供测试与未建表时使用。 */
export function createMemoryWakeStore() {
const tables = { wakeScenes: new Map(), wakeAlarms: new Map(), wakeReceipts: new Map(), settings: new Map()};
return {
async get(table, key) { const v = tables[table]?.get(key); return v === undefined? null: structuredClone(v);},
async put(table, value) { const key = value.id?? value.key?? value.wakeId; tables[table].set(key, structuredClone(value)); return key;},
async getAll(table) { return [...(tables[table]?.values() || [])].map((v) => structuredClone(v));},
async delete(table, key) { return tables[table]?.delete(key);},
};
}

// 建表迁移见 js/storage.js 的 ensureWakeStores（v3→v4，本文件不再重复定义，
// 避免 build-preview.mjs 拼接后出现同名顶层函数）。

/** 多标签页认领锁：lockStore 须实现 getItem/setItem/removeItem（默认用 localStorage）。 */
export function tryClaimLock(lockStore, key, holderId, nowMs, ttlMs = CLAIM_TTL_MS) {
if (!lockStore) return { ok: true, holder: holderId};
let raw = null;
try { raw = lockStore.getItem(key);} catch { raw = null;}
if (raw) {
try {
const prev = JSON.parse(raw);
if (prev.holder!== holderId && prev.expiresAt > nowMs) return { ok: false, holder: prev.holder};
} catch { /* 损坏的锁记录视为可覆盖 */}
}
try { lockStore.setItem(key, JSON.stringify({ holder: holderId, expiresAt: nowMs + ttlMs}));} catch { /* 写锁失败不阻塞 */}
return { ok: true, holder: holderId};
}

export class WakeEngine {
constructor(opts = {}) {
this.store = opts.store || createMemoryWakeStore();
this.clock = opts.clock || (() => Date.now());
this.holderId = opts.holderId || wakeUid('tab');
this.lockStore = opts.lockStore?? (typeof localStorage!== 'undefined'? localStorage: null);
this.channelFactory = opts.channelFactory || null; // () => BroadcastChannel 实例
this.slmClient = opts.slmClient || null;
this.settings = {...DEFAULT_WAKE_SETTINGS,...(opts.settings || {})};
this.userTyping = false;
this.cancelled = new Set();
this.channel = null;
if (this.channelFactory) {
try {
this.channel = this.channelFactory('verweile-wake');
this.channel.onmessage = (e) => {
if (e?.data?.type === 'wake-claimed') this.cancelled.add(e.data.wakeId);
};
} catch { this.channel = null;}
}
}

async loadSettings() {
const saved = await this.store.get('settings', WAKE_SETTINGS_KEY).catch(() => null);
if (saved?.value) this.settings = {...DEFAULT_WAKE_SETTINGS,...saved.value};
return this.settings;
}
async saveSettings(patch) {
this.settings = {...this.settings,...patch};
await this.store.put('settings', { key: WAKE_SETTINGS_KEY, value: this.settings});
return this.settings;
}
isEnabledFor(charId) {
if (!this.settings.enabled) return false;
if (charId && this.settings.perChar[charId] === false) return false;
return true;
}
isBackendConfigured() { return false;} // 真后台版预留：未配置前恒为 false
getModeText() { return WAKE_MODE_TEXT;}

setUserTyping(v) { this.userTyping =!!v;}
isUserTyping() { return this.userTyping;}
cancelWake(wakeId, reason) {
this.cancelled.add(wakeId);
return { wakeId, cancelled: true, reason: reason || '用户正在发言，唤醒回合让位'};
}

async _dayCounts(nowMs) {
const day = cstDayKey(nowMs);
const receipts = await this.store.getAll('wakeReceipts');
const today = receipts.filter((r) => r.day === day);
return {
wakes: today.length,
messages: today.filter((r) => r.notified).length,
};
}

/** 当日上限 + 冷却 + 免打扰 + 总开关的统一门禁。 */
async canWake(charId, nowMs = this.clock()) {
if (!this.isEnabledFor(charId)) return { ok: false, reason: '主动唤醒未开启'};
if (isInDnd(this.settings.dnd, nowMs)) return { ok: false, reason: '免打扰时段内，不唤醒'};
const counts = await this._dayCounts(nowMs);
if (counts.wakes >= this.settings.maxWakesPerDay) return { ok: false, reason: `今日唤醒已达上限（${this.settings.maxWakesPerDay} 次）`};
if (counts.messages >= this.settings.maxMessagesPerDay) return { ok: false, reason: `今日主动消息已达上限（${this.settings.maxMessagesPerDay} 条）`};
const receipts = await this.store.getAll('wakeReceipts');
const last = receipts.map((r) => r.completedAt || r.acceptedAt || 0).filter(Boolean);
const lastAt = last.length? Math.max(...last): 0;
if (lastAt && nowMs - lastAt < this.settings.cooldownMin * 60 * 1000) {
return { ok: false, reason: `冷却期内（${this.settings.cooldownMin} 分钟），暂不唤醒`};
}
return { ok: true, counts};
}

async startScene({ charId, sceneType, title, facts, cadenceMin, durationMin, nowMs = this.clock()}) {
const def = SCENE_DEFAULTS[sceneType];
if (!def) return { ok: false, reason: `未知情境类型：${sceneType}`};
const v = validateSceneTiming({ cadenceMin, durationMin});
if (!v.ok) return { ok: false, reason: v.errors.join('；')};
const cad = cadenceMin?? def.cadenceMin;
const dur = durationMin?? def.durationMin;
const scene = {
id: wakeUid('scene'), charId, type: sceneType, title: title || def.label,
facts: facts || [], cadenceMin: cad, durationMin: dur,
startedAt: nowMs, expiresAt: nowMs + dur * 60 * 1000, nextAt: nowMs + cad * 60 * 1000,
status: 'active', snoozeUntil: null, note: null, wakeWhen: null,
};
await this.store.put('wakeScenes', scene);
return { ok: true, scene};
}

async endScene(ref, nowMs = this.clock(), charId) {
const scenes = await this.store.getAll('wakeScenes');
const target = scenes.find((s) => (ref.sceneId? s.id === ref.sceneId: s.type === ref.sceneType) && s.status === 'active' && (!charId || s.charId === charId));
if (!target) return { ok: false, reason: '没有找到对应的有效情境'};
target.status = 'ended'; target.endedAt = nowMs;
await this.store.put('wakeScenes', target);
return { ok: true, scene: target};
}

/** 更新情境（节奏/有效期/标题/事实；wake_when 仍一律拒绝，见 validateWakeWhen）。 */
async updateScene(ref, patch = {}, nowMs = this.clock(), charId) {
const scenes = await this.store.getAll('wakeScenes');
const target = scenes.find((s) => (ref.sceneId? s.id === ref.sceneId: s.type === ref.sceneType) && s.status === 'active' && (!charId || s.charId === charId));
if (!target) return { ok: false, reason: '没有找到对应的有效情境'};
const v = validateSceneTiming({ cadenceMin: patch.cadenceMin, durationMin: patch.durationMin});
if (!v.ok) return { ok: false, reason: v.errors.join('；')};
if (patch.cadenceMin !== undefined && patch.cadenceMin !== null) target.cadenceMin = patch.cadenceMin;
if (patch.durationMin !== undefined && patch.durationMin !== null) { target.durationMin = patch.durationMin; target.expiresAt = target.startedAt + patch.durationMin * 60 * 1000; }
if (patch.title !== undefined) target.title = patch.title;
if (Array.isArray(patch.facts)) target.facts = patch.facts;
target.nextAt = nowMs + target.cadenceMin * 60 * 1000;
await this.store.put('wakeScenes', target);
return { ok: true, scene: target};
}

/** 暂缓：把某角色全部有效情境 snooze 指定分钟（用户说“先别发”时用）。 */
async snoozeScenes(charId, minutes, nowMs = this.clock()) {
if (!Number.isFinite(minutes) || minutes < SNOOZE_MIN || minutes > SNOOZE_MAX) {
return { ok: false, reason: `snooze 时长须在 ${SNOOZE_MIN}–${SNOOZE_MAX} 分钟之间`};
}
const scenes = await this.store.getAll('wakeScenes');
let n = 0;
for (const s of scenes.filter((x) => x.charId === charId && x.status === 'active')) {
s.snoozeUntil = nowMs + minutes * 60 * 1000;
await this.store.put('wakeScenes', s);
n += 1;
}
return { ok: true, snoozed: n, until: nowMs + minutes * 60 * 1000 };
}

async setAlarm({ charId, at, note, nowMs = this.clock()}) {
if (!Number.isFinite(at) || at <= nowMs) return { ok: false, reason: '闹钟必须是未来时间，过期闹钟拒绝。'};
const alarm = { id: wakeUid('alarm'), charId, at, note: note || '', status: 'pending', createdAt: nowMs};
await this.store.put('wakeAlarms', alarm);
return { ok: true, alarm};
}

/** 字条：写入即版本 +1、已读次数清零；成功读满 3 次后不再提供。 */
async setNote(sceneId, text) {
const scene = await this.store.get('wakeScenes', sceneId);
if (!scene) return { ok: false, reason: '情境不存在'};
const version = (scene.note?.version || 0) + 1;
scene.note = { text, version, reads: 0};
await this.store.put('wakeScenes', scene);
return { ok: true, note: scene.note};
}
async clearNote(sceneId) {
const scene = await this.store.get('wakeScenes', sceneId);
if (!scene) return { ok: false, reason: '情境不存在'};
scene.note = null;
await this.store.put('wakeScenes', scene);
return { ok: true};
}
/** 读字条（只计数、不消费）：返回 null 表示已读满 3 次或无字条。 */
readNote(scene) {
if (!scene?.note?.text) return null;
if (scene.note.reads >= NOTE_MAX_READS) return null;
return { sceneId: scene.id, text: scene.note.text, version: scene.note.version, reads: scene.note.reads};
}
/** 唤醒成功完成且有实质内容时，按报告引用的版本消费一次。 */
async consumeNotes(noteRefs) {
for (const ref of noteRefs || []) {
const scene = await this.store.get('wakeScenes', ref.sceneId);
if (!scene?.note || scene.note.version!== ref.version) continue; // 版本不符不扣次数
scene.note.reads = Math.min(NOTE_MAX_READS, (scene.note.reads || 0) + 1);
await this.store.put('wakeScenes', scene);
}
}

/** 用户消息入口：分类 → 应用增量（每条最多 3 个）。分类失败不建/不改情境。 */
async userMessage(charId, messageId, text, at = this.clock()) {
void messageId; void at;
const { deltas} = await classifyUserMessage(text, this.slmClient);
const applied = [];
for (const d of deltas) {
if (d.action === 'start') {
const r = await this.startScene({ charId, sceneType: d.sceneType, facts: d.facts, cadenceMin: d.cadenceMin, durationMin: d.durationMin});
if (r.ok) applied.push({ action: 'start', sceneType: d.sceneType});
} else if (d.action === 'end') {
const r = await this.endScene({ sceneType: d.sceneType}, at, charId);
if (r.ok) applied.push({ action: 'end', sceneType: d.sceneType});
} else if (d.action === 'snooze') {
const scenes = await this.store.getAll('wakeScenes');
for (const s of scenes.filter((x) => x.charId === charId && x.status === 'active')) {
s.snoozeUntil = at + d.minutes * 60 * 1000;
await this.store.put('wakeScenes', s);
}
applied.push({ action: 'snooze', minutes: d.minutes});
}
}
return { deltas, applied};
}

/** 领取认领：先写 claim 记录再执行；过期 claim 可回收；多标签页互斥。 */
async claimWake(wakeId, nowMs = this.clock()) {
const key = `wake-claim:${wakeId}`;
const lock = tryClaimLock(this.lockStore, key, this.holderId, nowMs);
if (!lock.ok) return { ok: false, reason: `已被另一标签页领取（持有者 ${lock.holder}）`};
let receipt = await this.store.get('wakeReceipts', wakeId);
if (receipt?.claim && receipt.claim.holder!== this.holderId && receipt.claim.expiresAt > nowMs) {
return { ok: false, reason: '已被认领（回执锁未过期）'};
}
if (!receipt) {
receipt = { wakeId, trigger: '', charId: '', acceptedAt: null, completedAt: null, notifiedAt: null, accepted: null, completed: false, notified: false, error: null, day: cstDayKey(nowMs), claim: null};
}
receipt.claim = { holder: this.holderId, expiresAt: nowMs + CLAIM_TTL_MS};
await this.store.put('wakeReceipts', receipt);
try { this.channel?.postMessage({ type: 'wake-claimed', wakeId, holder: this.holderId});} catch { /* ignore */}
return { ok: true, receipt};
}

/** 回执三分开记：accepted / completed / notified 各自独立。 */
async markReceipt(wakeId, field, value, nowMs = this.clock()) {
const receipt = (await this.store.get('wakeReceipts', wakeId)) || { wakeId, trigger: '', charId: '', acceptedAt: null, completedAt: null, notifiedAt: null, accepted: null, completed: false, notified: false, error: null, day: cstDayKey(nowMs), claim: null};
if (field === 'accepted') { receipt.accepted = value; receipt.acceptedAt = value === null? null: nowMs;}
if (field === 'completed') { receipt.completed =!!value; receipt.completedAt = nowMs;}
if (field === 'notified') { receipt.notified =!!value; receipt.notifiedAt = value? nowMs: null;}
await this.store.put('wakeReceipts', receipt);
return receipt;
}

/**
* 回执去重发送：同一 wakeId 已 notified 时不再重复发。
* sendFn(wakeId) 须返回 { delivered: boolean}。
*/
async sendOnce(wakeId, sendFn, nowMs = this.clock()) {
const receipt = await this.store.get('wakeReceipts', wakeId);
if (receipt?.notified) return { ok: true, delivered: true, deduped: true, reason: '该唤醒已发送过，不重复发'};
const res = await sendFn(wakeId);
if (res?.delivered) await this.markReceipt(wakeId, 'notified', true, nowMs);
return { ok:!!res?.delivered, delivered:!!res?.delivered, deduped: false};
}

/**
* 前端运行版检查：页面可见 / 恢复前台时调用。
* 用户正在发言时让位；过期安排标记过期，绝不补发。
* 返回 { due: [{ wakeId, trigger, scenes, alarms, report}], expired: [...]}。
*/
async checkDueOnForeground(nowMs = this.clock()) {
if (this.isUserTyping()) return { due: [], expired: [], skipped: 'user-typing'};
const scenes = await this.store.getAll('wakeScenes');
const alarms = await this.store.getAll('wakeAlarms');
const { dueAlarms, dueScenes, expiredAlarms, expiredScenes} = checkDue(scenes, alarms, nowMs);
const expired = [];
for (const a of expiredAlarms) { a.status = 'expired'; await this.store.put('wakeAlarms', a); expired.push({ kind: 'alarm', id: a.id});}
for (const s of expiredScenes) { s.status = 'expired'; await this.store.put('wakeScenes', s); expired.push({ kind: 'scene', id: s.id});}
// 超宽限未到期情境：下次时间顺延，不补发
for (const s of scenes) {
if (s.status === 'active' && nowMs >= s.nextAt && nowMs - s.nextAt > SCENE_GRACE_MS && nowMs < s.expiresAt) {
s.nextAt = nowMs + s.cadenceMin * 60 * 1000;
await this.store.put('wakeScenes', s);
}
}
const due = [];
const groups = new Map(); // 按 charId 合并同一轮到期项
for (const a of dueAlarms) {
if (!groups.has(a.charId)) groups.set(a.charId, { alarms: [], scenes: []});
groups.get(a.charId).alarms.push(a);
}
for (const s of dueScenes) {
if (!groups.has(s.charId)) groups.set(s.charId, { alarms: [], scenes: []});
groups.get(s.charId).scenes.push(s);
}
for (const [charId, g] of groups) {
const gate = await this.canWake(charId, nowMs);
if (!gate.ok) continue;
const wakeId = wakeUid('wake');
const claim = await this.claimWake(wakeId, nowMs);
if (!claim.ok) continue;
const notes = g.scenes.map((s) => this.readNote(s)).filter(Boolean);
const receipts = await this.store.getAll('wakeReceipts');
const report = buildWakeReport({
trigger: g.alarms.length? `闹钟到了：${g.alarms.map((a) => a.note || '闹钟').join('；')}`: `情境到了：${g.scenes.map((s) => s.title).join('、')}`,
scenes: g.scenes, notes, wakeCount: receipts.length + 1, charId,
});
due.push({ wakeId, trigger: report.trigger, charId, scenes: g.scenes, alarms: g.alarms, report});
for (const a of g.alarms) { a.status = 'fired'; await this.store.put('wakeAlarms', a);}
for (const s of g.scenes) { s.nextAt = nowMs + s.cadenceMin * 60 * 1000; await this.store.put('wakeScenes', s);}
}
return { due, expired};
}

/**
* 唤醒回合结果处理，三种分支都要有：
* - send：模型决定发送一条主动消息（由调用方经 sendOnce 实际发送）
* - skip：模型决定暂不发消息（只记 completed，不记 notified）
* - reschedule：模型用工具调用调整安排（经 parseWakeToolCall 校验后执行）
*/
async handleWakeOutcome(wakeId, outcome, nowMs = this.clock()) {
if (this.cancelled.has(wakeId) || this.isUserTyping()) {
return { ok: false, reason: '用户正在发言，唤醒回合已让位/取消', decision: 'cancelled'};
}
const decision = outcome?.decision;
if (decision === 'send') {
await this.markReceipt(wakeId, 'completed', true, nowMs);
return { ok: true, decision: 'send', message: outcome.message || ''};
}
if (decision === 'skip') {
await this.markReceipt(wakeId, 'completed', true, nowMs);
return { ok: true, decision: 'skip'};
}
if (decision === 'reschedule') {
const parsed = parseWakeToolCall(outcome.toolCall);
if (!parsed.ok) return { ok: false, decision: 'reschedule', reason: parsed.reason};
await this.markReceipt(wakeId, 'completed', true, nowMs);
return { ok: true, decision: 'reschedule', toolCall: parsed};
}
return { ok: false, reason: `未知的唤醒结果 decision：${String(decision)}（须为 send / skip / reschedule）`};
}

/** 唤醒成功完成且有实质内容时，消费报告引用的字条。 */
async settleWake(wakeId, report, substantive) {
if (!substantive) return { consumed: false};
await this.consumeNotes(report?.notes || []);
return { consumed: true};
}

/**
* 执行一条已通过 parseWakeToolCall 校验的工具调用（先校验、后执行；
* 未校验的原始输入请先走 parseWakeToolCall，不要直接调本函数）。
* parsed = { ok:true, action, params }；charId 缺省时用 fallbackCharId。
*/
async applyWakeToolCall(parsed, fallbackCharId, nowMs = this.clock()) {
if (!parsed?.ok) return { ok: false, reason: parsed?.reason || '工具调用未通过校验，拒绝执行。'};
const p = parsed.params || {};
const charId = p.charId || fallbackCharId;
switch (parsed.action) {
case 'set_alarm': return this.setAlarm({ charId, at: p.at, note: p.note, nowMs });
case 'set_repeat': return this.startScene({ charId, sceneType: p.sceneType, title: p.title, cadenceMin: p.cadenceMin, durationMin: p.durationMin, nowMs });
case 'snooze': {
if (p.sceneId) {
const scene = await this.store.get('wakeScenes', p.sceneId);
if (!scene) return { ok: false, reason: '情境不存在'};
scene.snoozeUntil = nowMs + p.minutes * 60 * 1000;
await this.store.put('wakeScenes', scene);
return { ok: true, scene };
}
return this.snoozeScenes(charId, p.minutes, nowMs);
}
case 'end_scene': return this.endScene({ sceneId: p.sceneId, sceneType: p.sceneType }, nowMs, charId);
case 'update_scene': return this.updateScene({ sceneId: p.sceneId, sceneType: p.sceneType }, { cadenceMin: p.cadenceMin, durationMin: p.durationMin, title: p.title, facts: p.facts }, nowMs, charId);
case 'set_note': return this.setNote(p.sceneId, p.note);
case 'clear_note': return this.clearNote(p.sceneId);
default: return { ok: false, reason: `未知的唤醒动作：${String(parsed.action)}`};
}
}
}

/**
* 设置区渲染（由总协调员接进 app.js 设置页）。
* deps：{ settings, onSave(settings), chars（[{id, name}]，用于角色独立开关）,
*         wakeEngine（本实例，用于读当日计数）, toast? }。
*/
export function renderWakeSettingsSection(container, deps = {}) {
const s = { ...DEFAULT_WAKE_SETTINGS, ...(deps.settings || {}) };
const dnd = s.dnd || {};
const html = `
<h3>主动唤醒</h3>
<p class="muted">${WAKE_EXPLAIN_TEXT}</p>
<p class="muted b-honesty">${WAKE_MODE_TEXT}</p>
<div class="setting-row"><span class="setting-label">开启主动唤醒<small>默认关闭</small></span><label class="switch"><input type="checkbox" id="wake-enabled" ${s.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div>
<div class="field"><label>免打扰时段</label><div class="setting-row"><span class="setting-label">启用<small>按 UTC+8 计，可跨午夜。</small></span><label class="switch"><input type="checkbox" id="wake-dnd-enabled" ${dnd.enabled ? 'checked' : ''}><span class="switch-track"></span></label></div><div class="row"><input type="time" id="wake-dnd-start" value="${dnd.start || '23:00'}"> – <input type="time" id="wake-dnd-end" value="${dnd.end || '08:00'}"></div></div>
<div class="field"><label>两次唤醒最短间隔（分钟）</label><input type="number" id="wake-cooldown" min="0" max="240" value="${s.cooldownMin ?? 10}"></div>
<div class="field"><label>每日唤醒上限（次，按 UTC+8 自然日）</label><input type="number" id="wake-max-wakes" min="1" max="500" value="${s.maxWakesPerDay ?? 50}"></div>
<div class="field"><label>每日主动消息上限（条，按 UTC+8 自然日）</label><input type="number" id="wake-max-msgs" min="1" max="500" value="${s.maxMessagesPerDay ?? 50}"></div>
<div class="field"><label>巡检间隔（分钟，仅页面可见时检查）</label><input type="number" id="wake-patrol" min="1" max="120" value="${s.patrolIntervalMin ?? 15}"></div>
${(deps.chars || []).map((c) => `<div class="setting-row"><span class="setting-label">允许 ${c.name || c.id} 主动唤醒</span><label class="switch"><input type="checkbox" data-wake-char="${c.id}" ${s.perChar?.[c.id] === false ? '' : 'checked'}><span class="switch-track"></span></label></div>`).join('')}
<div class="actions-row"><button class="primary" id="wake-save">保存唤醒设置</button></div>`;
if (container) container.innerHTML = html;
const q = (id) => container?.querySelector?.(`#${id}`);
q('wake-save')?.addEventListener?.('click', async () => {
const perChar = { ...(s.perChar || {}) };
container?.querySelectorAll?.('[data-wake-char]')?.forEach?.((cb) => { perChar[cb.dataset.wakeChar] = !!cb.checked; });
const next = {
enabled: q('wake-enabled')?.checked ?? s.enabled,
dnd: { enabled: q('wake-dnd-enabled')?.checked ?? false, start: q('wake-dnd-start')?.value || '23:00', end: q('wake-dnd-end')?.value || '08:00' },
cooldownMin: Math.max(0, parseInt(q('wake-cooldown')?.value || '10', 10) || 0),
maxWakesPerDay: Math.max(1, parseInt(q('wake-max-wakes')?.value || '50', 10) || 50),
maxMessagesPerDay: Math.max(1, parseInt(q('wake-max-msgs')?.value || '50', 10) || 50),
patrolIntervalMin: Math.max(1, parseInt(q('wake-patrol')?.value || '15', 10) || 15),
perChar,
};
await deps.onSave?.(next);
deps.toast?.('唤醒设置已保存');
});
return html;
}
