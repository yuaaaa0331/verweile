// chat-layout.test.mjs — 聊天页整体布局高度（2026-11-21）：
// 顶栏上方空白来自安全区重复预留——Muse 预览 iframe 里宿主已占导航/安全区，
// webview 上报的 env() 会把宿主高度再算一遍（实测顶栏多出约 123px，消息列表
// 只剩约 408px）。修法不是加覆盖补丁，而是把全站安全区收进 --sat/--sab
// 两个变量，嵌在 iframe 里时 html.embedded 把阀门关到 0；独立打开仍走 env()。
// 另：图片/表情包容器不挂文字气泡尾巴（透明底图片上尾巴会悬空）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
const chatCss = readFileSync(resolve(root, 'chat.css'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const appJs = readFileSync(resolve(root, 'js/app.js'), 'utf8');

test('安全区阀门：--sat/--sab 只在 :root 取 env()，其余用量全走变量', () => {
  assert.ok(css.includes('--sat: env(safe-area-inset-top);'), ':root 定义 --sat 取 env(top)');
  assert.ok(css.includes('--sab: env(safe-area-inset-bottom);'), ':root 定义 --sab 取 env(bottom)');
  assert.ok(css.includes('html.embedded { --sat: 0px; --sab: 0px; }'), 'embedded 关阀门到 0');
  // 除 :root 定义外，全站不得再有裸 env(safe-area-*)（否则又是重复预留的漏网点）
  const stripped = (css + chatCss)
    .replace('--sat: env(safe-area-inset-top);', '')
    .replace('--sab: env(safe-area-inset-bottom);', '');
  assert.ok(!stripped.includes('env(safe-area-inset-top)'), '无裸 env(safe-area-inset-top)');
  assert.ok(!stripped.includes('env(safe-area-inset-bottom)'), '无裸 env(safe-area-inset-bottom)');
  assert.ok(chatCss.includes('padding:calc(6px + var(--sat)) 10px 7px;'), '顶栏上 padding 走 --sat');
  assert.ok(chatCss.includes('padding:8px 12px calc(9px + var(--sab))'), '输入栏下 padding 走 --sab');
});

test('内嵌判定：iframe 里首绘前挂 .embedded，独立打开不挂', () => {
  assert.ok(html.includes("if (window.self !== window.top) document.documentElement.classList.add('embedded');"), 'index.html <head> 有内嵌判定脚本');
  assert.ok(appJs.includes("if (window.self !== window.top) document.documentElement.classList.add('embedded');"), 'app.js 有内嵌兜底');
});

test('纵向布局：顶栏按内容占高，消息列表 flex:1 + min-height:0 独立滚动，输入栏在底', () => {
  assert.ok(chatCss.includes('#view-chat #message-area {'), '消息区规则在位');
  const area = chatCss.slice(chatCss.indexOf('#view-chat #message-area {'));
  assert.ok(area.startsWith('#view-chat #message-area {\n  flex:1; min-height:0; overflow-y:auto;'), '消息列表 flex:1、min-height:0、独立纵向滚动');
  assert.ok(chatCss.includes('#view-chat #composer { position:relative; flex:none;'), '输入栏 flex:none 在底');
  assert.ok(chatCss.includes('#view-chat .chat-head {'), '顶栏规则在位');
  const head = chatCss.slice(chatCss.indexOf('#view-chat .chat-head {'));
  assert.ok(head.includes('flex:none;'), '顶栏 flex:none 按内容占高');
});

test('图片/表情包不挂尾巴：文字气泡/语音/转账/礼物保留尾巴', () => {
  assert.ok(!appJs.includes("'.bubble, .voice-card, .photo-wrap, .sticker-wrap, .transfer-card, .gift-card'"), '尾巴挂载不再含 photo-wrap/sticker-wrap');
  assert.ok(appJs.includes("'.bubble, .voice-card, .transfer-card, .gift-card'"), '文字气泡/语音/转账/礼物仍挂尾巴');
  assert.ok(!css.includes('.msg.group-last .photo-wrap::before'), '旧 drop-shadow 组不再含 photo-wrap');
  assert.ok(!css.includes('.msg.group-last .sticker-wrap::before'), '旧 drop-shadow 组不再含 sticker-wrap');
});

test('内容尺寸不动：只扩大消息列表可视区域，不放大里面的内容', () => {
  assert.ok(chatCss.includes('--ios16-font-size:15px;'), '气泡字号仍 15px');
  assert.ok(chatCss.includes('--ios16-bubble-padding:7px 12px;'), '气泡内边距仍 7px 12px');
  assert.ok(chatCss.includes('max-width:160px; max-height:180px;'), '表情包仍 160×180');
});
