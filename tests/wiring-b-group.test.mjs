// wiring-b-group.test.mjs — 接线轮测试（2026-11-21）：
// B 组 5 模块接进 app.js / build-preview.mjs / index.html / styles.css /
// importExport.js / theme.js 后的接线断言。app.js 本身不能在 Node 里 import
//（顶层就读 DOM），所以 runWakeRound / parseWakeDecision 用源码抽取 +
// new Function 在 fake 依赖下真实执行分支；其余接线点用静态锚点断言。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync} from 'node:fs';
import { MemoryBackend} from '../js/storage.js';
import { exportAll, importNormalized, normalizeBackup, previewCounts} from '../js/importExport.js';
import { WakeEngine, createMemoryWakeStore, DEFAULT_WAKE_SETTINGS} from '../js/wakeEngine.js';
import { THEME_DEFAULTS, clampTheme} from '../js/theme.js';

const appSrc = readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
const buildSrc = readFileSync(new URL('../scripts/build-preview.mjs', import.meta.url), 'utf8');
const indexSrc = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const cssSrc = readFileSync(new URL('../styles.css', import.meta.url), 'utf8');
const themeSrc = readFileSync(new URL('../js/theme.js', import.meta.url), 'utf8');
const importExportSrc = readFileSync(new URL('../js/importExport.js', import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

function orderList() {
const m = buildSrc.match(/const ORDER = \[([\s\S]*?)\];/);
assert.ok(m, 'build-preview.mjs 里找不到 ORDER');
return m[1].match(/'[^']+'/g).map((s) => s.slice(1, -1));
}

/** 从源码里按花括号配对抽出一个完整函数声明（供 Node 里真实执行）。 */
function extractFunction(src, name) {
const idx = src.indexOf(`function ${name}(`);
assert.ok(idx!== -1, `app.js 里找不到 function ${name}`);
const start = src.lastIndexOf('\n', idx) + 1;
// 函数体 { 在参数列表的右括号之后（默认参数 deps = {} 里也有花括号，不能直接取第一个 {）。
const brace = src.indexOf('{', src.indexOf(')', idx));
let depth = 0;
for (let i = brace; i < src.length; i++) {
if (src[i] === '{') depth++;
else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1);}
}
throw new Error(`抽取 ${name} 时花括号未配对`);
}

test('ORDER：B 组 5 行在 storage.js 之后、app.js 之前；A 组 4 行仍在；无重复', () => {
const order = orderList();
const b5 = ['js/inAppNotify.js', 'js/audioKeepAlive.js', 'js/pushNotify.js', 'js/customIcon.js', 'js/wakeEngine.js'];
const a4 = ['js/statusMode.js', 'js/longPressMenu.js', 'js/innerVoice.js', 'js/chatDaily.js'];
for (const f of [...b5,...a4]) assert.ok(order.includes(f), `ORDER 缺少 ${f}`);
assert.equal(new Set(order).size, order.length, 'ORDER 有重复行');
const storageIdx = order.indexOf('js/storage.js');
const appIdx = order.indexOf('js/app.js');
for (const f of b5) {
const i = order.indexOf(f);
assert.ok(i > storageIdx && i < appIdx, `${f} 须在 storage.js 之后、app.js 之前`);
}
assert.ok(order.indexOf('js/statusMode.js') < order.indexOf('js/promptBuilder.js'), 'statusMode 须在 promptBuilder 之前');
});

test('拼接打包防冲突：ORDER 全部模块之间无重复顶层导出名', () => {
const seen = new Map();
const dups = [];
for (const p of orderList()) {
const src = readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([\w$]+)/gm)) {
if (seen.has(m[1])) dups.push(`${m[1]}: ${seen.get(m[1])} vs ${p}`);
else seen.set(m[1], p);
}
for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gm)) {
for (const s of m[1].split(',')) {
const name = ((s.match(/as\s+([\w$]+)/) || [])[1] || s.trim()).replace(/;$/, '');
if (name) {
if (seen.has(name)) dups.push(`${name}: export-list ${seen.get(name)} vs ${p}`);
else seen.set(name, p);
}
}
}
}
assert.deepEqual(dups, [], `顶层导出重名会被拼接打包静默覆盖：${dups.join('；')}`);
});

test('build-preview.mjs：复制 sw.js / manifest / 图标到 dist，缺失时生成默认 manifest 与图标', () => {
assert.ok(buildSrc.includes("copyFileSync(resolve(root, 'sw.js'), resolve(root, 'dist/sw.js'))"), '缺 sw.js 复制');
assert.ok(buildSrc.includes("copyFileSync(resolve(root, 'manifest.json'), resolve(root, 'dist/manifest.json'))"), '缺 manifest.json 复制');
assert.ok(buildSrc.includes("copyFileSync(resolve(root, 'apple-touch-icon.png'), resolve(root, 'dist/apple-touch-icon.png'))"), '缺 apple-touch-icon.png 复制');
assert.ok(buildSrc.includes("cpSync(resolve(root, 'assets/icons'), resolve(root, 'dist/icons')"), '缺 icons/ 复制');
assert.ok(buildSrc.includes('defaultIconPng'), '缺失时须生成默认图标');
assert.ok(buildSrc.includes("if (!existsSync(resolve(root, 'dist/manifest.json')))"), '缺失时须生成默认 manifest');
assert.ok(buildSrc.includes('copyFileSync, cpSync, existsSync'), '缺 fs 导入扩展');
});

test('package.json：build 先跑 build-icons 再跑 build-preview', () => {
assert.ok(pkg.scripts.build.indexOf('build-icons')!== -1 && pkg.scripts.build.indexOf('build-icons') < pkg.scripts.build.indexOf('build-preview'), `build 脚本须先跑 build-icons：${pkg.scripts.build}`);
});

test('index.html：manifest 与 apple-touch-icon 改为部署文件，不再是 data: 内联', () => {
assert.ok(indexSrc.includes('<link rel="manifest" href="/manifest.json">'), 'manifest 须指 /manifest.json');
assert.ok(indexSrc.includes('<link rel="apple-touch-icon" href="/apple-touch-icon.png">'), 'apple-touch-icon 须指 /apple-touch-icon.png');
assert.ok(indexSrc.includes('id="sub-notify"'), 'index.html 缺 notify 二级页节点 sub-notify（openSubpage 按 sub-<id> 查找）');
assert.ok(indexSrc.includes('<h2>通知与唤醒</h2>'), 'sub-notify 标题须为“通知与唤醒”');
const manageSrc = readFileSync(new URL('../js/manage.js', import.meta.url), 'utf8');
assert.ok(manageSrc.includes("id: 'notify'"), 'ManageView 缺 notify 入口行，否则设置页进不去');
assert.ok(!indexSrc.includes('data:application/manifest+json'), '不应残留内联 manifest');
assert.ok(!indexSrc.includes('data:image/svg+xml'), '不应残留内联 apple-touch-icon');
});

test('app.js 设置 state 与存取：5 个 B 设置变量、loadAll 加载、5 个 save 函数', () => {
for (const v of ['notifySettings', 'keepAliveSettings', 'pushSettings', 'customIconSettings', 'wakeSettings']) {
assert.ok(appSrc.includes(`let ${v} =`), `缺设置变量 ${v}`);
}
for (const fn of ['saveNotifySettings', 'saveKeepAliveSettings', 'savePushSettings', 'saveCustomIconSettings', 'saveWakeSettings']) {
assert.ok(appSrc.includes(`async function ${fn}()`), `缺保存函数 ${fn}`);
}
for (const key of ['NOTIFY_SETTINGS_KEY', 'KEEPALIVE_SETTINGS_KEY', 'PUSH_SETTINGS_KEY', 'CUSTOM_ICON_SETTINGS_KEY', 'WAKE_SETTINGS_KEY']) {
assert.ok(appSrc.includes(`backend.get('settings', ${key})`), `loadAll 缺 ${key}`);
}
assert.ok(appSrc.includes('let inAppNotifier = null'), '缺 inAppNotifier 单例');
assert.ok(appSrc.includes('let audioKeepAlive = null'), '缺 audioKeepAlive 单例');
assert.ok(appSrc.includes('let wakeEngine = null'), '缺 wakeEngine 单例');
});

test('app.js 设置页：notify tab 与 4 个 B 设置区、外观 tab 图标区真实导出', () => {
assert.ok(appSrc.includes("'notify'"), 'TABS 缺 notify');
assert.ok(appSrc.includes("if (settingsTab === 'notify')"), 'renderSettingsBody 缺 notify 分支');
for (const fn of ['renderNotifySettingsSection', 'renderKeepAliveSettingsSection', 'renderPushSettingsSection', 'renderWakeSettingsSection']) {
assert.ok(appSrc.includes(fn), `notify 分支缺 ${fn}`);
}
assert.ok(appSrc.includes('renderIconSettingsSection'), '外观 tab 缺图标区');
assert.ok(appSrc.includes('exportIconPack('), 'onExportPack 须调 exportIconPack 真实导出');
assert.ok(appSrc.includes('a.download = f.file'), '导出须逐档触发下载');
assert.ok(appSrc.includes('handleIconFileChange'), '缺图标文件选择回调');
assert.ok(appSrc.includes('validateIconFile'), '文件回调须先校验');
assert.ok(appSrc.includes('previewSpecs('), '文件回调须按 previewSpecs 画预览');
assert.ok(!appSrc.includes("return { ok: false, reason: '请先上传一张图标图片。'}"), 'onExportPack 不应残留占位返回');
});

test('app.js boot：B 初始化、SW 注册、前台巡检；消息写入后触发横幅', () => {
for (const anchor of [
'new InAppNotifier({', 'await loadUnread(backend, inAppNotifier)',
'getAudioKeepAlive({', 'new WakeEngine({', 'await wakeEngine.loadSettings()',
"registerServiceWorker(navigator, '/sw.js')", 'wakePatrol', 'visibilitychange',
'audioKeepAlive?.handleVisibility(false)',
]) assert.ok(appSrc.includes(anchor), `boot 缺锚点：${anchor}`);
assert.ok(appSrc.includes('inAppNotifier.notifyInApp({'), 'put 包装器缺横幅触发');
assert.ok(appSrc.includes('await saveUnread(backend, inAppNotifier)'), '横幅触发后须保存未读');
assert.ok(appSrc.includes("args[1]?.role === 'assistant'"), '只对 assistant 消息弹横幅');
assert.ok(appSrc.includes('isChatPageVisible()'), '横幅须按聊天页可见性判断');
assert.ok(appSrc.includes('NavShell.getCurrent() === \'chat\''), 'isChatPageVisible 须以 NavShell 当前页为准');
assert.ok(appSrc.includes('NavShell.switchView(\'chat\')'), 'openChatForBanner 须切回聊天页');
assert.ok(appSrc.includes('scrollIntoView'), 'openChatForBanner 须定位到消息');
});

test('app.js 用户消息入口：wakeEngine.userMessage 用原文、失败静默', () => {
assert.ok(appSrc.includes('wakeEngine.userMessage(char.id, msg.id, text)'), 'sendUserText 缺唤醒分类');
assert.ok(appSrc.includes('.catch(() => {})'), '分类失败须静默');
assert.ok(appSrc.includes('wakeEngine?.setUserTyping(!!inputEl.value.trim())'), '输入框有字时须标记正在发言');
});

test('B 设置键经 settings 表加载/保存往返', async () => {
const db = new MemoryBackend();
const { NOTIFY_SETTINGS_KEY, DEFAULT_NOTIFY_SETTINGS} = await import('../js/inAppNotify.js');
const { KEEPALIVE_SETTINGS_KEY, DEFAULT_KEEPALIVE_SETTINGS} = await import('../js/audioKeepAlive.js');
const { PUSH_SETTINGS_KEY, DEFAULT_PUSH_SETTINGS} = await import('../js/pushNotify.js');
const { CUSTOM_ICON_SETTINGS_KEY, DEFAULT_APP_NAME} = await import('../js/customIcon.js');
const { WAKE_SETTINGS_KEY, DEFAULT_WAKE_SETTINGS} = await import('../js/wakeEngine.js');
await db.put('settings', { key: NOTIFY_SETTINGS_KEY, value: {...DEFAULT_NOTIFY_SETTINGS, hideSummary: true}});
await db.put('settings', { key: KEEPALIVE_SETTINGS_KEY, value: {...DEFAULT_KEEPALIVE_SETTINGS, enabled: true}});
await db.put('settings', { key: PUSH_SETTINGS_KEY, value: {...DEFAULT_PUSH_SETTINGS, vapidPublicKey: 'BPUB'}});
await db.put('settings', { key: CUSTOM_ICON_SETTINGS_KEY, value: { appName: 'test-app', dataUrl: 'data:image/png;base64,AAA'}});
await db.put('settings', { key: WAKE_SETTINGS_KEY, value: {...DEFAULT_WAKE_SETTINGS, enabled: true, cooldownMin: 5}});
assert.equal((await db.get('settings', NOTIFY_SETTINGS_KEY)).value.hideSummary, true);
assert.equal((await db.get('settings', KEEPALIVE_SETTINGS_KEY)).value.enabled, true);
assert.equal((await db.get('settings', PUSH_SETTINGS_KEY)).value.vapidPublicKey, 'BPUB');
assert.equal((await db.get('settings', CUSTOM_ICON_SETTINGS_KEY)).value.appName, 'test-app');
assert.equal((await db.get('settings', WAKE_SETTINGS_KEY)).value.cooldownMin, 5);
assert.equal(DEFAULT_APP_NAME, 'verweile');
});

test('备份往返：导出含 5 键 + 3 表；清空后导入恢复，wakeReceipts.claim 已清空', async () => {
const src = new MemoryBackend();
await src.put('settings', { key: 'notifySettings', value: { bannerEnabled: false}});
await src.put('settings', { key: 'audioKeepAlive', value: { enabled: true, heartbeatSec: 20}});
await src.put('settings', { key: 'pushSettings', value: { enabled: true, vapidPublicKey: 'BPUB', pushServiceUrl: 'https://push.example'}});
await src.put('settings', { key: 'customIcon', value: { appName: 'my-app', dataUrl: 'data:image/png;base64,AAA'}});
await src.put('settings', { key: 'wakeSettings', value: { enabled: true, cooldownMin: 7}});
await src.put('wakeScenes', { id: 'scene_1', charId: 'c1', type: 'morning', title: '早安', status: 'active'});
await src.put('wakeAlarms', { id: 'alarm_1', charId: 'c1', at: Date.now() + 3600e3, note: '起床', status: 'pending'});
await src.put('wakeReceipts', { wakeId: 'wake_1', charId: 'c1', accepted: true, completed: true, notified: false, day: '2026-11-21', claim: { holder: 'tab_old', expiresAt: Date.now() + 60000}});
const exported = await exportAll(src);
assert.equal(exported.notifySettings.bannerEnabled, false);
assert.equal(exported.audioKeepAlive.heartbeatSec, 20);
assert.equal(exported.pushSettings.vapidPublicKey, 'BPUB', 'VAPID 公钥可随备份走');
assert.equal(exported.customIcon.appName, 'my-app');
assert.equal(exported.wakeSettings.cooldownMin, 7);
assert.equal(exported.wakeScenes.length, 1);
assert.equal(exported.wakeAlarms.length, 1);
assert.equal(exported.wakeReceipts.length, 1);

const dst = new MemoryBackend();
const report = await importNormalized(dst, normalizeBackup(JSON.parse(JSON.stringify(exported))));
assert.equal(report.added.notifySettings, 1);
assert.equal(report.added.wakeScenes, 1);
assert.equal(report.added.wakeAlarms, 1);
assert.equal(report.added.wakeReceipts, 1);
assert.equal((await dst.get('settings', 'wakeSettings')).value.cooldownMin, 7);
assert.equal((await dst.get('settings', 'pushSettings')).value.vapidPublicKey, 'BPUB');
const receipt = await dst.get('wakeReceipts', 'wake_1');
assert.equal(receipt.claim, null, '导入时须清空过期认领，不带到新设备');
assert.equal(receipt.accepted, true);
const counts = previewCounts(normalizeBackup(JSON.parse(JSON.stringify(exported))));
assert.equal(counts.wakeScenes, 1);
assert.equal(counts.wakeAlarms, 1);
assert.equal(counts.wakeReceipts, 1);
assert.ok(importExportSrc.includes("for (const key of ['notifySettings', 'audioKeepAlive', 'pushSettings', 'customIcon', 'wakeSettings'])"), 'importExport 缺 B 设置键处理');
});

// ---- runWakeRound：从 app.js 抽取真实函数，在 fake 依赖下执行分支 ----
const parseWakeDecision = new Function(`${extractFunction(appSrc, 'parseWakeDecision')}; return parseWakeDecision;`)();
const runWakeRound = new Function('wakeEngine', 'callWakeModel', 'saveWakeReply', 'parseWakeDecision', `
let wakeRoundRunning = false;
${extractFunction(appSrc, 'runWakeRound')}
return runWakeRound;
`)(undefined, undefined, undefined, parseWakeDecision);

function fakeWake() {
return {
wakeId: 'wake_test_1', trigger: '情境到了：早安', charId: 'c1',
scenes: [], alarms: [],
report: { text: '触发原因：情境到了：早安\n有效情境：无\n短期字条：无', trigger: '情境到了：早安', scenes: [], notes: []},
};
}
function realEngine() {
return new WakeEngine({ store: createMemoryWakeStore(), settings: {...DEFAULT_WAKE_SETTINGS, enabled: true}});
}

test('runWakeRound 决策解析：send/skip/reschedule/unknown', () => {
assert.deepEqual(parseWakeDecision('【发送】你好呀'), { decision: 'send', message: '你好呀'});
assert.deepEqual(parseWakeDecision('【跳过】'), { decision: 'skip'});
assert.deepEqual(parseWakeDecision('【调整】{"action":"snooze","minutes":30}'), { decision: 'reschedule', toolCall: '{"action":"snooze","minutes":30}'});
assert.equal(parseWakeDecision('你好呀').decision, 'unknown');
assert.equal(parseWakeDecision('').decision, 'unknown');
});

test('runWakeRound send 分支：保存消息 → sendOnce 记 notified → 消费字条', async () => {
const engine = realEngine();
const saved = [];
const r = await runWakeRound(fakeWake(), {
engine, parseDecision: parseWakeDecision,
modelCall: async () => '【发送】早安，今天也要加油。',
saveReply: async (text) => { saved.push(text);},
});
assert.equal(r.decision, 'send');
assert.deepEqual(saved, ['早安，今天也要加油。']);
const receipt = await engine.store.get('wakeReceipts', 'wake_test_1');
assert.equal(receipt.accepted, true);
assert.equal(receipt.completed, true);
assert.equal(receipt.notified, true);
});

test('runWakeRound skip 分支：只记 completed，不保存、不记 notified', async () => {
const engine = realEngine();
let saved = 0;
const r = await runWakeRound(fakeWake(), {
engine, parseDecision: parseWakeDecision,
modelCall: async () => '【跳过】',
saveReply: async () => { saved++;},
});
assert.equal(r.decision, 'skip');
assert.equal(saved, 0);
const receipt = await engine.store.get('wakeReceipts', 'wake_test_1');
assert.equal(receipt.completed, true);
assert.equal(receipt.notified, false);
});

test('runWakeRound reschedule 分支：校验后执行 applyWakeToolCall（新建闹钟）', async () => {
const engine = realEngine();
const at = new Date(Date.now() + 3600e3).toISOString();
const r = await runWakeRound(fakeWake(), {
engine, parseDecision: parseWakeDecision,
modelCall: async () => `【调整】{"action":"set_alarm","at":"${at}","note":"提醒我"}`,
saveReply: async () => { throw new Error('reschedule 不应保存消息');},
});
assert.equal(r.decision, 'reschedule');
const alarms = await engine.store.getAll('wakeAlarms');
assert.equal(alarms.length, 1);
assert.equal(alarms[0].note, '提醒我');
const receipt = await engine.store.get('wakeReceipts', 'wake_test_1');
assert.equal(receipt.completed, true);
assert.equal(receipt.notified, false);
});

test('runWakeRound cancelled 分支：用户正在发言时作废，不保存、不记 notified', async () => {
const engine = realEngine();
engine.setUserTyping(true);
let saved = 0;
const r = await runWakeRound(fakeWake(), {
engine, parseDecision: parseWakeDecision,
modelCall: async () => '【发送】不该发',
saveReply: async () => { saved++;},
});
assert.equal(r.decision, 'cancelled');
assert.equal(saved, 0);
const receipt = await engine.store.get('wakeReceipts', 'wake_test_1');
assert.equal(receipt, null, '让位时不应先记 accepted');
});

test('runWakeRound 模型失败 / 决策无法解析：按 skip 收尾，不凭空发消息', async () => {
const engine = realEngine();
let saved = 0;
const fail = await runWakeRound(fakeWake(), {
engine, parseDecision: parseWakeDecision,
modelCall: async () => { throw new Error('网络失败');},
saveReply: async () => { saved++;},
});
assert.equal(fail.decision, 'skip');
assert.equal(saved, 0);
const engine2 = realEngine();
const unknown = await runWakeRound(fakeWake(), {
engine: engine2, parseDecision: parseWakeDecision,
modelCall: async () => '今天天气不错',
saveReply: async () => { saved++;},
});
assert.equal(unknown.decision, 'skip');
assert.equal(saved, 0);
});

test('气泡玻璃开关：默认关闭；clampTheme 保留开关；theme 与 CSS 都有接线', () => {
assert.equal(THEME_DEFAULTS.bubbleGlass, false, '默认须为 iMessage 式清晰材质');
assert.equal(clampTheme({}).bubbleGlass, false);
assert.equal(clampTheme({ bubbleGlass: true}).bubbleGlass, true);
assert.equal(clampTheme({ bubbleGlass: 'yes'}).bubbleGlass, false, '非布尔值须归一为 false');
assert.ok(themeSrc.includes("classList.toggle('bubble-glass'"), 'apply() 须按开关切 #app class');
assert.ok(themeSrc.includes('bubbleGlass'), 'renderAppearance 须有开关');
assert.ok(themeSrc.includes('液态玻璃气泡'), '开关须有中文说明');
assert.ok(cssSrc.includes('#app.bubble-glass .bubble'), 'styles.css 须有气泡玻璃样式');
assert.ok(cssSrc.includes('.inapp-banner'), 'styles.css 须含 B 组横幅样式');
assert.ok(cssSrc.includes('.b-honesty'), 'styles.css 须含 B 组诚实说明样式');
assert.ok(cssSrc.includes('.icon-preview-row'), 'styles.css 须含图标预览样式');
});

test('CSS 合并后无残留临时文件：docs/b-css-additions.css 已删除', async () => {
const { access} = await import('node:fs/promises');
await assert.rejects(access(new URL('../docs/b-css-additions.css', import.meta.url)), '临时 CSS 文件应已删除');
});
