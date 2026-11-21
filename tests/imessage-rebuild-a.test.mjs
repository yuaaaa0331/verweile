// imessage-rebuild-a.test.mjs — A 组 iMessage 重建测试（顶栏＋消息区＋输入栏＋
// 沉浸式导航＋特殊消息类型）。app.js 本身是浏览器入口不进 Node 测试，
// 这里测它依赖的纯函数与样式/结构/接线静态约定；真实 DOM 行为走无头验证。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { groupLastFlags } from '../js/chatDaily.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
const chatCss = readFileSync(resolve(root, 'chat.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const appJs = readFileSync(resolve(root, 'js/app.js'), 'utf8');

/* ---- 组末尾巴判定：组末有尾巴、组中无尾巴、换方断组 ---- */
test('组末判定：组末 true、组中 false；换角色 / 超 10 分钟 / 跨天都断组', () => {
  const t0 = new Date('2026-11-20T10:00:00').getTime();
  // 同组 3 条：只有最后一条是组末
  assert.deepEqual(groupLastFlags([
    { role: 'user', timestamp: t0 },
    { role: 'user', timestamp: t0 + 60_000 },
    { role: 'user', timestamp: t0 + 120_000 },
  ]), [false, false, true]);
  // 换方断组：换方前后两条都是各自组末
  assert.deepEqual(groupLastFlags([
    { role: 'user', timestamp: t0 },
    { role: 'assistant', timestamp: t0 + 60_000 },
  ]), [true, true]);
  // 超 10 分钟断组
  assert.deepEqual(groupLastFlags([
    { role: 'user', timestamp: t0 },
    { role: 'user', timestamp: t0 + 11 * 60_000 },
  ]), [true, true]);
  assert.deepEqual(groupLastFlags([{ role: 'assistant', timestamp: t0 }]), [true]);
  assert.deepEqual(groupLastFlags([]), []);
});

test('组末尾巴样式：16×18 iOS16 mask，.message-tail 只挂组末最后一段内容', () => {
  assert.ok(chatCss.includes('--ios16-tail:'), 'iOS16 尾巴 mask 变量在位');
  assert.ok(chatCss.includes('.msg.group-last .message-tail::before'), '尾巴只画在组末');
  assert.ok(chatCss.includes('width:16px; height:18px;'), '尾巴 16×18');
  assert.ok(chatCss.includes('mask:var(--ios16-tail)'), '尾巴用 iOS16 mask');
  assert.ok(chatCss.includes('drop-shadow(0 1px 1px rgba(0,0,0,.28))'), '尾巴补 drop-shadow 边，浅色壁纸可见');
  assert.ok(appJs.includes("classList.add('message-tail')"), '尾巴挂载已接入渲染');
  assert.ok(appJs.includes("'.bubble, .voice-card, .transfer-card, .gift-card'"), '尾巴挂载覆盖气泡/语音/转账/礼物');
  assert.ok(!appJs.includes("'.bubble, .voice-card, .photo-wrap, .sticker-wrap, .transfer-card, .gift-card'"), '图片/表情包不挂尾巴（透明底上会悬空）');
  assert.ok(!chatCss.includes('--tail-l:'), '旧 24×21 mask 左变量已删');
  assert.ok(!chatCss.includes('--tail-r:'), '旧 24×21 mask 右变量已删');
  assert.ok(chatCss.includes('.transfer-card.message-tail::before'), '转账卡尾巴继承渐变');
  assert.ok(chatCss.includes('background:inherit;'), '渐变卡尾巴用 inherit');
});

/* ---- 默认无头像 ---- */
test('默认无头像：渲染不再创建 .msg-avatar，样式里整段删掉', () => {
  assert.ok(!appJs.includes("el('img', 'msg-avatar'"), 'createMessageElement / 流式气泡不再创建头像');
  assert.ok(!css.includes('.msg-avatar {'), '头像样式已删');
  assert.ok(!css.includes('.msg.sent { padding-left: 35px; }'), '为头像留的左侧补位已删');
  assert.ok(!html.includes('msg-avatar'), 'HTML 里无消息头像节点');
  // 头像只留在顶栏：58px 圆头像仍在
  assert.ok(html.includes('id="char-avatar"'));
});

/* ---- 顶栏三件套：in-flow 网格顶栏 + 62px 头像 + 44×44 返回/··· ---- */
test('顶栏三件套结构：in-flow 网格顶栏、头像 62px、返回/··· 44×44 无背景', () => {
  assert.ok(html.includes('<header class="chat-head">'), '顶栏在位');
  assert.ok(!html.includes('<header class="chat-head glass">'), '顶栏不挂玻璃');
  assert.ok(html.includes('id="chat-back-btn"'), '左返回按钮在位');
  assert.ok(html.includes('id="char-avatar-btn"'), '居中头像按钮在位');
  assert.ok(html.includes('id="top-info-btn"'), '昵称按钮在位');
  assert.ok(html.includes('id="chat-menu-btn"'), '右 ··· 在位');
  assert.ok(!html.includes('class="chat-back-btn glass"'), '返回按钮去玻璃');
  assert.ok(chatCss.includes('display:grid; grid-template-columns:56px minmax(0,1fr) 56px;'), '顶栏 in-flow 网格');
  assert.ok(chatCss.includes('position:relative; inset:auto; flex:none; display:grid;'), '顶栏非绝对悬浮');
  assert.ok(chatCss.includes('--ios16-header-avatar:62px;'), '头像 62px');
  assert.ok(chatCss.includes('width:44px; height:44px;'), '返回/··· 44×44');
  assert.ok(chatCss.includes('.top-name { font-size:14px;'), '昵称 14px');
  // 不抄原项目的数字徽标与 "Maybe:" 字样
  assert.ok(!html.includes('214'), '返回按钮里无数字徽标');
  assert.ok(!html.includes('Maybe:'), '无 "Maybe:" 字样');
  assert.ok(!css.includes('214'), '样式里无数字徽标');
});

/* ---- 心形按钮已并入头像/昵称入口，状态行节点已去掉 ---- */
test('状态入口合并：心形按钮与顶栏状态行已删，入口只剩头像与昵称胶囊', () => {
  assert.ok(!html.includes('id="status-btn"'), '顶栏心形按钮已删');
  assert.ok(!html.includes('id="char-status"'), '顶栏状态行已删');
  assert.ok(!appJs.includes("$('#status-btn')"), '心形监听已删');
  assert.ok(!appJs.includes("$('#char-status')"), '状态行写入已删');
  assert.ok(appJs.includes("$('#char-avatar-btn').addEventListener('click', openStatusPopup)"), '头像点开状态弹窗');
  assert.ok(appJs.includes("$('#top-info-btn').addEventListener('click', openStatusPopup)"), '昵称胶囊点开状态弹窗');
  assert.ok(appJs.includes('openChatMenu'), '设置仍在 ··· 菜单里');
});

/* ---- 沉浸式导航：聊天页隐藏主导航，返回按钮回主界面 ---- */
test('聊天页 tabbar 隐藏判定：.in-chat 时 display:none，节点仍保留供其他页用', () => {
  assert.ok(css.includes('#app.in-chat #tabbar { display: none; }'), '聊天页隐藏主导航');
  assert.ok(html.includes('id="tabbar"'), 'Tab 栏节点保留，其他页仍可用');
  assert.ok(appJs.includes('goBackFromChat'), '返回函数在位');
  assert.ok(appJs.includes("NavShell.switchView(lastHomeView"), '返回切回上一次所在的页');
  assert.ok(appJs.includes("let lastHomeView = 'moments'"), '默认回动态页');
  assert.ok(appJs.includes("$('#chat-back-btn').addEventListener('click', goBackFromChat)"), '返回按钮已接线');
});

/* ---- 截图最下方五按钮栏不在项目源码里（Muse 预览宿主 chrome） ---- */
test('五按钮宿主栏不在源码里：index.html / styles.css 均无其图标与结构', () => {
  for (const emoji of ['💬', '📄', '💡', '✅', '🔲']) {
    assert.ok(!html.includes(emoji), `源码里无宿主栏图标 ${emoji}`);
    assert.ok(!css.includes(emoji), `样式里无宿主栏图标 ${emoji}`);
  }
});

/* ---- 输入区三件套：加号 + 输入框 + 发送/获取回复 ---- */
test('输入区三件套结构：32×36 无背景加号、36px 输入框、32px 发送/获取回复', () => {
  assert.ok(html.includes('id="plus-btn"'), '左加号在位');
  assert.ok(html.includes('id="plus-btn" class="icon-btn round"'), '加号去 .glass（聊天内不挂液态玻璃快照）');
  assert.ok(!html.includes('id="plus-btn" class="icon-btn round glass"'), '加号不再挂 .glass');
  assert.ok(css.includes('.icon-btn.round.glass.gl-webgl { background: transparent;'), 'WebGL 接管后加号 CSS 清零');
  assert.ok(html.includes('id="input"'), '中间输入框在位');
  assert.ok(html.includes('id="send-btn"'), '发送按钮在位');
  assert.ok(html.includes('id="get-reply-btn"'), '获取回复按钮在位');
  assert.ok(chatCss.includes('#view-chat #plus-btn {'), '加号样式在 chat.css');
  assert.ok(chatCss.includes('width:32px; height:36px;'), '加号 32×36 无背景');
  assert.ok(chatCss.includes('#view-chat #input {'), '输入框样式在 chat.css');
  assert.ok(chatCss.includes('min-height:34px;'), '输入框 34px+ 高');
  assert.ok(chatCss.includes('#view-chat .send-btn, #view-chat .reply-btn {'), '发送/获取回复样式在位');
  assert.ok(chatCss.includes('width:32px; height:32px;'), '发送/获取回复 32px');
  assert.ok(chatCss.includes('#view-chat #composer { position:relative;'), '输入区实色 chrome 底栏');
  assert.ok(chatCss.includes('padding:8px 12px calc(9px + var(--sab));'), '输入区底部留安全区（Tab 栏已隐藏，经 --sab 阀门）');
  assert.ok(appJs.includes("$('#send-btn').addEventListener('click', sendCurrent)"), '真实发送逻辑保留');
  assert.ok(appJs.includes("$('#get-reply-btn').addEventListener('click', getReply)"), 'Get Reply 逻辑保留');
});

/* ---- 消息区排版：组内 3px、换方 12px、顶栏 in-flow 故无 115px 顶垫 ---- */
test('消息区排版：组内 3px / 换方 12px，顶部 padding 8px 16px 16px', () => {
  assert.ok(chatCss.includes('#view-chat #message-area {'), '消息区样式在 chat.css');
  assert.ok(chatCss.includes('padding:8px 16px 16px;'), '消息区 padding 8px 16px 16px');
  assert.ok(chatCss.includes('margin:12px 0 0;'), '换方组间 12px');
  assert.ok(chatCss.includes('margin-top:3px;'), '组内 3px');
  assert.ok(!chatCss.includes('115px'), '旧 115px 顶垫已删');
});

/* ---- 已送达：只在末条已发送消息下方显示一次 ---- */
test('已送达标记：只在末条已发送消息下方显示一次（10px）', () => {
  assert.ok(appJs.includes('refreshDeliveredMarker'), '已送达重算函数在位');
  assert.ok(appJs.includes('已送达 · '), '文案“已送达 + 时间”');
  assert.ok(appJs.includes("querySelectorAll('.msg.sent:not(.withdrawn)')"), '只找末条已发送消息');
  assert.ok(chatCss.includes('#view-chat .msg-delivered'), '已送达样式在 chat.css');
  assert.ok(chatCss.includes('font-size:10px;'), '已送达 10px');
});

/* ---- 引用 / 语音 / 转账渲染不断 ---- */
test('引用渲染：可点击的 quoted-message 按钮，58cqw 上限，2 行截断，点按走引用跳转', () => {
  assert.ok(appJs.includes('createQuotedMessage'), '引用渲染已接入 createQuotedMessage');
  assert.ok(appJs.includes('quoted-message'), '引用按钮类名在位');
  assert.ok(appJs.includes('dataset.quoteMessageId'), '引用带原消息 ID');
  assert.ok(appJs.includes("classList.add('has-quote')"), '含引用消息标 has-quote');
  assert.ok(appJs.includes('jumpToQuotedMessage'), '引用点击走跳转');
  assert.ok(appJs.includes('followQuoteReference'), '跳转解析走 quoteNavigation');
  assert.ok(!appJs.includes("el('div', 'quote-bubble '"), '旧不可点击 div 引用已删');
  assert.ok(chatCss.includes('.quote-bubble.quoted-message {'), '引用按钮样式在位');
  assert.ok(chatCss.includes('max-width:min(58cqw,220px);'), '引用 max-width min(58cqw,220px)');
  assert.ok(chatCss.includes('.quoted-message .quoted-text { display:-webkit-box; -webkit-line-clamp:2;'), '引用 2 行截断');
  assert.ok(chatCss.includes('.msg.has-quote::after'), '弯曲引导线在位');
  assert.ok(chatCss.includes('.quoted-message.from-me'), '引用分方向（我方右置）');
});

test('语音渲染：184px 气泡，22px 播放按钮，展开转写变两行', () => {
  assert.ok(appJs.includes("'voice-card voice-bubble'"), '语音卡片已接入渲染');
  assert.ok(appJs.includes('voice-transcript'), '转写行已接入渲染');
  assert.ok(appJs.includes('voice-row'), '播放行已接入渲染');
  assert.ok(appJs.includes('play-icon'), '播放按钮带 play-icon');
  assert.ok(appJs.includes('展开语音文字'), '播放按钮有展开文案');
  assert.ok(!appJs.includes("'card voice-card'"), '旧卡片式语音已删');
  assert.ok(chatCss.includes('--ios16-voice-width:184px;'), '语音 184px 宽');
  assert.ok(chatCss.includes('width:var(--ios16-voice-width);'), '语音宽走变量');
  assert.ok(chatCss.includes('.voice-play {'), '播放按钮样式在位');
  assert.ok(chatCss.includes('width:22px; height:22px;'), '播放按钮 22px');
  assert.ok(chatCss.includes('.voice-bubble.expanded { height:auto; }'), '展开变两行');
  assert.ok(chatCss.includes('.voice-bubble .voice-transcript.active { display:block; }'), '转写 active 显示');
});

test('转账/礼物渲染：210px 宽、min-height 139px，灰渐变白字，金额大字，备注 2 行截断', () => {
  assert.ok(appJs.includes('card-amount'), '金额大字已接入渲染');
  assert.ok(appJs.includes('card-label'), '卡片小标签已接入渲染');
  assert.ok(appJs.includes("'card transfer-card'"), '转账卡片仍在');
  assert.ok(appJs.includes("'card gift-card'"), '礼物卡片仍在');
  assert.ok(chatCss.includes('#view-chat .transfer-card, #view-chat .gift-card'), '转账/礼物样式在 chat.css');
  assert.ok(chatCss.includes('width:210px; max-width:100%; min-height:139px;'), '转账/礼物 210px × min-height 139px');
  assert.ok(chatCss.includes('linear-gradient(135deg,#bfbfbf,#a6a6a6)'), '转账灰渐变');
  assert.ok(chatCss.includes('linear-gradient(135deg,#b2b2b2,#969696)'), '礼物灰渐变');
  assert.ok(chatCss.includes('#view-chat .gift-card { width:210px; min-height:139px;'), '礼物卡同为 210×139');
  assert.ok(chatCss.includes('.card-amount { font-size:30px; }'), '金额 30px');
  assert.ok(chatCss.includes('.transfer-card .card-sub,.gift-card .card-sub { display: -webkit-box; -webkit-line-clamp: 2;'), '备注 2 行截断');
  assert.ok(chatCss.includes('#view-chat .card .card-status { position:static;'), '状态行静态排布');
});

test('翻译渲染：译文静态在正文下方，原文减淡到 55%，按钮“翻译/原文”', () => {
  assert.ok(appJs.includes('show-translation'), '翻译展开切换已接入渲染');
  assert.ok(appJs.includes('bubble-text'), '原文 span 已接入渲染');
  assert.ok(appJs.includes('translation-text'), '译文静态节点已接入渲染');
  assert.ok(appJs.includes("'翻译'"), '按钮文案“翻译”');
  assert.ok(appJs.includes("'原文'"), '按钮文案“原文”');
  assert.ok(!appJs.includes('查看翻译'), '旧“查看翻译”文案已删');
  assert.ok(!appJs.includes('收起翻译'), '旧“收起翻译”文案已删');
  assert.ok(!appJs.includes("hidden-t"), '旧隐藏式翻译已删');
  assert.ok(chatCss.includes('.bubble .translation { position:static;'), '译文静态流式');
  assert.ok(chatCss.includes('.bubble.show-translation .bubble-text { opacity:.55; }'), '原文减淡到 55%');
  assert.ok(chatCss.includes('.translation-text.active { display:block; }'), '译文 active 显示');
  assert.ok(!css.includes('-webkit-text-stroke: .55px'), '旧黑描边覆盖层已删');
});

test('图片/表情包渲染：保留原始比例，圆角 17.5px，组末尾巴外层在位', () => {
  assert.ok(appJs.includes('photo-wrap'), '图片尾巴外层已接入渲染');
  assert.ok(appJs.includes('sticker-wrap'), '表情包尾巴外层已接入渲染');
  assert.ok(css.includes('.photo-img { max-width: 230px; max-height: 230px; border-radius: 17.5px;'), '图片 17.5px 圆角');
  assert.ok(css.includes('.sticker-img { max-width: 160px; max-height: 180px; border-radius: 17.5px;'), '表情包 17.5px 圆角');
});

/* ---- 引用描边：styles.css 不得残留旧引用规则（2026-11-21 实测回归） ----
   旧 .quote-bubble::before 的 width:24px;height:21px 会把 chat.css 里靠
   inset 撑满整框的描边框死在 24×21px 里，四角 SVG 叠在一起，渲染成涂鸦。 */
test('引用描边：styles.css 无旧 .quote-bubble 规则；描边框尺寸由 chat.css 的 inset 决定', () => {
  assert.equal(css.includes('.quote-bubble'), false, 'styles.css 仍有 .quote-bubble 规则：旧 24×21 ::before 会把新描边框死');
  assert.match(chatCss, /#view-chat \.quoted-message::before \{[^}]*inset:\s*-\.6px -6px/, 'chat.css 的引用描边必须用 inset 撑满整框');
  assert.doesNotMatch(chatCss, /\.quoted-message::before \{[^}]*width:\s*24px/, '描边 ::before 不得有固定宽度');
});
