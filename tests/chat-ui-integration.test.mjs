// chat-ui-integration.test.mjs — A 组集成测试（聊天 UI 精简 + 状态/心声三模式 +
// 长按菜单 + 日常体验的接线断言）。app.js 本身是浏览器入口不进 Node 测试，
// 这里测它依赖的纯函数、提示词组装与样式/打包静态约定；
// 真实 DOM 行为（长按菜单点击、反应落盘、浮层三 bug）走无头验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { groupLastFlags, saveDraft, loadDraft, clearDraft, createDraftSaver, decideNewMessageDisplay, markFailed, canRetry, retryMessage, recoverInterruptedMessages, shouldResumeGeneration } from '../js/chatDaily.js';
import { parseInnerVoice } from '../js/innerVoice.js';
import { getStatusMode, setStatusMode, getStatusInstruction, getInnerVoicePrompt, DEFAULT_INNER_VOICE_PROMPT } from '../js/statusMode.js';
import { getMenuItems, toggleReaction, reactionCounts, createDeleteToken, isDeleteTokenValid, computeMenuPlacement } from '../js/longPressMenu.js';
import { buildSystemPrompt } from '../js/promptBuilder.js';
import { fixtureCharacter, fixtureWorldBooks, fixtureStickers, globalSettings } from './helpers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
const chatCss = readFileSync(resolve(root, 'chat.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const buildPreview = readFileSync(resolve(root, 'scripts/build-preview.mjs'), 'utf8');
const appJs = readFileSync(resolve(root, 'js/app.js'), 'utf8');
const deps = { worldBooks: fixtureWorldBooks(), stickers: fixtureStickers(), globalSettings };

function memStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  };
}

/* ---- 组末尾巴判定：与 .continuous 方向相反（标“组内最后一条”） ---- */
test('组末判定：同组短间隔只有最后一条是组末；换角色 / 超 10 分钟 / 跨天都断组', () => {
  const t0 = new Date('2026-11-20T10:00:00').getTime();
  const msgs = [
    { role: 'user', timestamp: t0 },
    { role: 'user', timestamp: t0 + 60_000 },
    { role: 'user', timestamp: t0 + 11 * 60_000 },
    { role: 'assistant', timestamp: t0 + 12 * 60_000 },
    { role: 'assistant', timestamp: t0 + 13 * 60_000 },
  ];
  assert.deepEqual(groupLastFlags(msgs), [false, true, true, false, true]);
  assert.deepEqual(groupLastFlags([]), []);
  assert.deepEqual(groupLastFlags([{ role: 'user', timestamp: t0 }]), [true]);
  // 跨天断组
  const day = new Date('2026-11-20T23:59:00').getTime();
  assert.deepEqual(groupLastFlags([
    { role: 'user', timestamp: day },
    { role: 'user', timestamp: day + 2 * 60_000 },
  ]), [true, true]);
});

/* ---- 状态三模式：切换只改选择字段，不删模板与历史，不重复注入 ---- */
test('状态模式切换不删除模板、历史与心声提示词', () => {
  const char = fixtureCharacter({
    statusPanel: {
      enabled: true, promptSuffix: '状态栏：显示心情。', regexPattern: 'x', replacePattern: 'y',
      history: [{ raw: '旧状态', html: '<b>旧</b>' }],
    },
    innerVoicePrompt: '我的心声提示词',
  });
  const switched = setStatusMode(char, 'inner');
  assert.equal(getStatusMode(switched), 'inner');
  assert.deepEqual(switched.statusPanel, char.statusPanel);
  assert.equal(switched.innerVoicePrompt, '我的心声提示词');
  assert.equal(getStatusMode(char), 'concise'); // 原对象不动
  assert.equal(getStatusMode(setStatusMode(char, 'nope')), 'concise'); // 非法回落
});

test('按模式只返回一套状态指令', () => {
  const base = fixtureCharacter({
    statusPanel: { enabled: true, promptSuffix: '状态栏：显示心情。' },
    innerVoicePrompt: '写三句心里话',
  });
  assert.deepEqual(getStatusInstruction({ ...base, statusMode: 'concise' }), { mode: 'concise', instruction: '' });
  assert.equal(getStatusInstruction({ ...base, statusMode: 'inner' }).instruction, '写三句心里话');
  assert.equal(getStatusInstruction({ ...base, statusMode: 'html' }).instruction, '状态栏：显示心情。');
  // html 模式模板未启用时不注入空指令
  assert.equal(getStatusInstruction({ ...base, statusMode: 'html', statusPanel: { enabled: false, promptSuffix: 'x' } }).instruction, '');
  assert.equal(getInnerVoicePrompt({}), DEFAULT_INNER_VOICE_PROMPT);
});

test('提示词组装：concise 不注入状态/心声，inner 只注心声，html 只注模板', () => {
  const panel = { enabled: true, promptSuffix: '状态栏：显示心情。', regexPattern: '', replacePattern: '', historyLimit: 3 };
  const concise = buildSystemPrompt(fixtureCharacter({ statusMode: 'concise', statusPanel: panel, innerVoicePrompt: '心声提示词ABC' }), deps);
  assert.ok(!concise.systemPrompt.includes('状态栏：显示心情。'));
  assert.ok(!concise.systemPrompt.includes('心声提示词ABC'));
  const inner = buildSystemPrompt(fixtureCharacter({ statusMode: 'inner', statusPanel: panel, innerVoicePrompt: '心声提示词ABC' }), deps);
  assert.ok(inner.systemPrompt.includes('心声提示词ABC'));
  assert.ok(!inner.systemPrompt.includes('状态栏：显示心情。'));
  const htmlMode = buildSystemPrompt(fixtureCharacter({ statusMode: 'html', statusPanel: panel, innerVoicePrompt: '心声提示词ABC' }), deps);
  assert.ok(htmlMode.systemPrompt.includes('状态栏：显示心情。'));
  assert.ok(!htmlMode.systemPrompt.includes('心声提示词ABC'));
});

test('提示词组装兼容：老角色无 statusMode 但模板已启用，仍按 html 走', () => {
  const { systemPrompt } = buildSystemPrompt(fixtureCharacter(), deps);
  assert.ok(systemPrompt.includes('状态栏：显示心情与位置。'));
});

/* ---- 心声解析降级：协议标记绝不留在正文里 ---- */
test('心声解析：正常剥离、缺失闭标签安静降级、多块全清', () => {
  const ok = parseInnerVoice('你好呀[inner_voice]其实我有点紧张。[/inner_voice]明天见');
  assert.equal(ok.cleanContent, '你好呀明天见');
  assert.equal(ok.innerVoice, '其实我有点紧张。');
  const broken = parseInnerVoice('你好呀[inner_voice]半截独白没有闭合');
  assert.equal(broken.innerVoice, null);
  assert.ok(!broken.cleanContent.includes('[inner_voice]'));
  assert.equal(broken.cleanContent, '你好呀');
  const multi = parseInnerVoice('A[inner_voice]第一句。[/inner_voice]B[inner_voice]第二句。[/inner_voice]C');
  assert.equal(multi.innerVoice, '第一句。');
  assert.equal(multi.cleanContent, 'ABC');
  const empty = parseInnerVoice('正文[/inner_voice]尾巴');
  assert.equal(empty.innerVoice, null);
  assert.ok(!empty.cleanContent.includes('inner_voice'));
});

/* ---- 长按菜单：按消息类型过滤、反应保存与取消、删除撤销窗口 ---- */
test('长按菜单按消息类型过滤：已撤回无复制/收藏，状态类无删除，助理有重新生成', () => {
  const now = Date.now();
  const own = { id: 'm1', role: 'user', timestamp: now - 30_000, content: 'hi' };
  const ownIds = getMenuItems(own, now).map((i) => i.id);
  assert.ok(ownIds.includes('copy') && ownIds.includes('edit') && ownIds.includes('recall'));
  assert.ok(!ownIds.includes('regenerate'));
  const ai = { id: 'm2', role: 'assistant', timestamp: now - 30_000, content: 'hi' };
  assert.ok(getMenuItems(ai, now).map((i) => i.id).includes('regenerate'));
  const withdrawn = { id: 'm3', role: 'user', timestamp: now - 30_000, isWithdrawn: true, content: 'x' };
  const wIds = getMenuItems(withdrawn, now).map((i) => i.id);
  assert.ok(!wIds.includes('copy') && !wIds.includes('favorite') && !wIds.includes('edit'));
  const status = { id: 'm4', role: 'assistant', isStatusUpdate: true, content: 'x' };
  assert.ok(!getMenuItems(status, now).map((i) => i.id).includes('delete'));
  // 超过 2 分钟不可撤回
  const old = { id: 'm5', role: 'user', timestamp: now - 3 * 60_000, content: 'x' };
  assert.ok(!getMenuItems(old, now).map((i) => i.id).includes('recall'));
});

test('反应切换：重复点取消，汇总计数正确；删除 token 5 秒内有效', () => {
  const msg = { id: 'm1', role: 'assistant', content: 'hi' };
  const reacted = toggleReaction(msg, '❤️', 1000);
  assert.equal(reactionCounts(reacted).length, 1);
  assert.equal(reactionCounts(reacted)[0].mine, true);
  assert.equal(msg.reactions, undefined); // 不改原对象
  const cancelled = toggleReaction(reacted, '❤️', 2000);
  assert.deepEqual(reactionCounts(cancelled), []);
  const token = createDeleteToken(msg, 1000);
  assert.equal(isDeleteTokenValid(token, 1000 + 4999), true);
  assert.equal(isDeleteTokenValid(token, 1000 + 5001), false);
});

test('菜单放置：下方空间够放下方，不够翻到上方；底部避让不被键盘/底栏遮住', () => {
  const vp = { width: 390, height: 844 };
  const below = computeMenuPlacement(
    { top: 100, bottom: 150, left: 20, right: 300, width: 280, height: 50 },
    { width: 280, height: 300 }, vp, { bottomReserve: 0 });
  assert.equal(below.placement, 'below');
  const above = computeMenuPlacement(
    { top: 600, bottom: 650, left: 20, right: 300, width: 280, height: 50 },
    { width: 280, height: 300 }, vp, { bottomReserve: 120 });
  assert.equal(above.placement, 'above');
  assert.ok(above.menu.top + 300 <= 844 - 120 + 8, '菜单底缘不进入底部避让区');
  assert.ok(above.menu.left >= 8 && above.menu.left + 280 <= 390 - 8, '左右钳制在视口内');
});

/* ---- 日常体验：草稿 / 阅读位置 / 重试 / 生成恢复 ---- */
test('草稿按角色保存、发送后清除；防抖保存器 flush 立即落盘', async () => {
  const s = memStorage();
  saveDraft(s, 'charA', '  hello  ');
  assert.equal(loadDraft(s, 'charA'), '  hello  ');
  assert.equal(loadDraft(s, 'charB'), '');
  saveDraft(s, 'charA', '   ');
  assert.equal(loadDraft(s, 'charA'), '');
  const saver = createDraftSaver(s, 'charA', { debounceMs: 5 });
  saver.schedule('未落盘');
  assert.equal(loadDraft(s, 'charA'), '');
  saver.flush();
  assert.equal(loadDraft(s, 'charA'), '未落盘');
  clearDraft(s, 'charA');
  assert.equal(loadDraft(s, 'charA'), '');
});

test('新消息拉底判定：贴底跟随，上翻显示 pill；发送失败复用同一 id 重试', () => {
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 0 }), { shouldStickToBottom: true, showNewMessagesPill: false });
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 48 }), { shouldStickToBottom: true, showNewMessagesPill: false });
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 200 }), { shouldStickToBottom: false, showNewMessagesPill: true });
  const failed = markFailed({ id: 'm1', content: 'hi', timestamp: 1 }, new Error('no db'));
  assert.equal(failed.sendState, 'failed');
  assert.equal(canRetry(failed), true);
  const retried = retryMessage(failed);
  assert.equal(retried.id, 'm1');
  assert.equal(retried.sendState, 'sending');
  assert.equal(canRetry(retried), false);
});

test('生成恢复：残留 generating 标中断，绝不自动续生成', () => {
  const { messages, wasGenerating } = recoverInterruptedMessages([
    { id: 'a', sendState: 'sent' },
    { id: 'b', sendState: 'generating' },
    { id: 'c', generating: true },
  ]);
  assert.equal(wasGenerating, true);
  assert.equal(messages[0].sendState, 'sent');
  assert.equal(messages[1].sendState, 'interrupted');
  assert.equal(messages[2].sendState, 'interrupted');
  assert.equal(shouldResumeGeneration(), false);
  assert.equal(recoverInterruptedMessages([{ id: 'a', sendState: 'sent' }]).wasGenerating, false);
});

/* ---- 静态约定：样式 / 结构 / 打包顺序 ---- */
test('样式：品牌行只在聊天页隐藏，状态条与自动回复行隐藏，顶栏 in-flow，气泡实色紧凑', () => {
  assert.ok(css.includes('#app.in-chat .brand-bar'), '聊天态隐藏品牌行');
  assert.ok(chatCss.includes('#view-chat #mock-badge, #view-chat #status-strip, #view-chat #auto-row { display:none; }'), '聊天页隐藏状态条与自动回复行');
  assert.ok(chatCss.includes('display:grid; grid-template-columns:56px minmax(0,1fr) 56px;'), '顶栏 in-flow 网格，非悬浮');
  assert.ok(chatCss.includes('--ios16-bubble-padding:7px 12px;') && chatCss.includes('line-height:1.38;'), '气泡 7px 12px / 1.38');
  assert.ok(chatCss.includes('--ios16-bubble-radius:18px;'), '圆角 18px');
  assert.ok(chatCss.includes('.msg.group-last .message-tail::before'), '组末尾巴（.message-tail）');
  assert.ok(chatCss.includes('width:16px; height:18px;'), '尾巴 16×18');
  assert.ok(chatCss.includes('mask:var(--ios16-tail)'), '尾巴用 iOS16 mask，不用固定尺寸拉伸');
});

test('样式：状态浮层三 bug 收口——absolute 定位、满宽 sheet、不透明底、sticky footer', () => {
  assert.ok(css.includes('.status-popup { position: absolute;'), 'fixed → absolute，跟 #app 走');
  assert.ok(!css.includes('.status-sheet { position: relative; width: 100%; max-width: 520px;'), '520px 越界已去掉');
  assert.ok(css.includes('.status-sheet.glass { background: rgba(255, 255, 255, .88);'), 'sheet 不透明，底栏不再透出来');
  assert.ok(css.includes('.status-sheet-foot { position: sticky; bottom: 0;'), 'footer sticky 贴底带实底');
  assert.ok(css.includes('calc(96px + var(--sab))'), '底部留出 Tab 栏高度（经 --sab 阀门）');
});

test('结构：状态弹窗是 #app 直接子节点；旧 #msg-menu 已退役；新消息 pill 与心声面板在位', () => {
  assert.ok(!html.includes('id="msg-menu"'), '旧底部 sheet 菜单已退役');
  const popupIdx = html.indexOf('id="status-popup"');
  const tabbarIdx = html.indexOf('id="tabbar"');
  const viewsEnd = html.indexOf('</section>', html.indexOf('id="view-manage"'));
  assert.ok(popupIdx > tabbarIdx, '状态弹窗在 Tab 栏之后（#app 直接子节点，不困在 .views 层叠上下文里）');
  assert.ok(popupIdx > viewsEnd, '状态弹窗在三页容器之外');
  assert.ok(html.includes('id="new-msg-pill"'));
  assert.ok(html.includes('id="inner-voice-panel"'));
  assert.ok(html.includes('id="status-strip"') && html.includes('id="auto-row"'), '隐藏的控制节点仍保留在 DOM 里供 JS 读写');
});

test('打包顺序：状态模式在提示词组装之前，四个新模块在 app.js 之前', () => {
  const order = (name) => buildPreview.indexOf(`'${name}'`);
  assert.ok(order('js/statusMode.js') > 0 && order('js/statusMode.js') < order('js/promptBuilder.js'));
  for (const m of ['js/longPressMenu.js', 'js/innerVoice.js', 'js/chatDaily.js']) {
    assert.ok(order(m) > 0 && order(m) < order('js/app.js'), `${m} 应在 app.js 之前`);
  }
});

test('app.js 接线锚点：长按菜单/心声/草稿/重试/组末判定均已接入', () => {
  for (const anchor of [
    "new LongPressMenu({", 'parseInnerVoice(', 'getStatusMode(char)',
    'createDraftSaver(localStorage', 'retrySendMessage(', 'groupLastFlags(',
    "localStorage.setItem('uwu-chat.generating'", 'recoverInterruptedMessages(',
    'openChatMenu', 'deleteMessageWithUndo', 'renderReactionsRow',
  ]) assert.ok(appJs.includes(anchor), `缺接线锚点：${anchor}`);
  assert.ok(!appJs.includes("openSheet('#msg-menu')"), '旧底部 sheet 菜单调用已清掉');
  assert.ok(!appJs.includes('longPressTimer'), '旧 480ms 长按计时器已清掉');
});
