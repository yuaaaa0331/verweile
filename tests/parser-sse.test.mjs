import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReplyText, parseBilingual, classifyContent } from '../js/replyParser.js';
import { createSSEParser, extractSSEText, parseNonStreamText, parseGeminiStreamText } from '../js/sse.js';
import { fixtureCharacter, fixtureStickers } from './helpers.mjs';

const char = fixtureCharacter();
const allowed = fixtureStickers().filter((s) => ['日常', '撒娇'].includes(s.group)).map((s) => s.name);

test('解析：正文里的普通方括号不截断消息', () => {
  const segs = parseReplyText('[阿澈的消息：今天[好开心]啊，真的]', char);
  assert.equal(segs.length, 1);
  assert.equal(segs[0].kind, 'text');
  assert.ok(segs[0].content.includes('[好开心]'));
});

test('解析：多条消息 + 引用 + 双语 + 表情包 + 状态一次分对', () => {
  const raw = '[阿澈的消息：Of course, I\'d love to.「当然，我很乐意。」]\n[阿澈引用“在吗”并回复：我在呢]\n[阿澈的表情包：贴贴]\n[阿澈更新状态为：正在看电影...]';
  const segs = parseReplyText(raw, char, { allowedStickers: allowed });
  assert.deepEqual(segs.map((s) => s.kind), ['bilingual', 'quote', 'sticker', 'status']);
  assert.equal(segs[0].foreign, "Of course, I'd love to.");
  assert.equal(segs[0].chinese, '当然，我很乐意。');
  assert.equal(segs[1].quoted, '在吗');
  assert.equal(segs[2].name, '贴贴');
});

test('解析：未知表情包回退文字；未闭合指令不执行、保留为文本', () => {
  const segs = parseReplyText('[阿澈的表情包：不存在的名字]\n[阿澈的消息：你好', char, { allowedStickers: allowed });
  assert.equal(segs[0].kind, 'stickerUnknown');
  assert.equal(segs[1].kind, 'text');
  assert.ok(segs[1].content.includes('[阿澈的消息：你好'));
});

test('解析：撤回 / 转账 / 礼物 / 接收指令 / 语音 / 图片描述', () => {
  const raw = '[阿澈撤回了一条消息：打错了]\n[阿澈的转账：52元；备注：奶茶钱]\n[阿澈送来的礼物：一束花]\n[阿澈已接收礼物]\n[阿澈的语音：晚安啦]\n[阿澈发来的照片/视频：窗外的晚霞]';
  const kinds = parseReplyText(raw, char).map((s) => s.kind);
  assert.deepEqual(kinds, ['withdraw', 'transfer', 'gift', 'giftResponse', 'voice', 'photo']);
});

test('解析：转发块与 HTML 块按标签配对，不丢字；纯文本保留原样', () => {
  const raw = '先说一句纯文本\n<阿澈转发的聊天记录>A:哈哈\nB:确实</阿澈转发的聊天记录>\n<div>html内容</div>';
  const segs = parseReplyText(raw, char);
  assert.equal(segs[0].kind, 'text');
  assert.ok(segs[0].content.includes('先说一句纯文本'));
  assert.equal(segs[1].kind, 'forward');
  assert.ok(segs[1].content.includes('A:哈哈'));
  assert.equal(segs[2].kind, 'html');
});

test('双语解析：优先「」，回退（）', () => {
  assert.deepEqual(parseBilingual('Hello world「你好世界」'), { foreign: 'Hello world', chinese: '你好世界' });
  assert.deepEqual(parseBilingual('Hello (你好)'), { foreign: 'Hello', chinese: '你好' });
  assert.equal(parseBilingual('纯中文没有翻译'), null);
});

test('SSE：拆开的 UTF-8 字符、跨 chunk 的 JSON、[DONE] 都正确', async () => {
  let out = '';
  const parser = createSSEParser({ onDelta: (d) => { out += d; } });
  const enc = new TextEncoder();
  const chunk1 = enc.encode('data: {"choices":[{"delta":{"content":"你好');
  const chunk2 = enc.encode('，世');
  const chunk3 = enc.encode('界"}}]}\n\ndata: {"choices":[{"delta":{"content":"！"}}]}\n\ndata: [DONE]\n\n');
  // 把一个中文字符的 UTF-8 字节从中间劈开
  const bytes = enc.encode('data: {"choices":[{"delta":{"content":"你"}}]}\n\n');
  const cut = 30; // 切在“你”的字节中间附近
  parser.feed(chunk1);
  parser.feed(chunk2);
  parser.feed(chunk3);
  parser.feed(bytes.slice(0, cut));
  parser.feed(bytes.slice(cut));
  parser.flush();
  assert.equal(out, '你好，世界！你');
  assert.equal(parser.done, true);
});

test('SSE：非流式 JSON 与 Gemini 流式数组', () => {
  const t = parseNonStreamText(JSON.stringify({ choices: [{ message: { content: '嗨' } }] }));
  assert.equal(t, '嗨');
  assert.throws(() => parseNonStreamText('<!DOCTYPE html><html>404</html>'), /HTML/);
  const g = parseGeminiStreamText(JSON.stringify([
    { candidates: [{ content: { parts: [{ text: '你好' }] } }] },
    { candidates: [{ content: { parts: [{ text: '呀' }] } }] },
  ]));
  assert.equal(g, '你好呀');
  assert.equal(extractSSEText('data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n'), 'hi');
});

test('classifyContent：单条直接返回该类，多条返回 mixed', () => {
  const one = classifyContent('[阿澈的转账：10元；备注：早餐]', char);
  assert.equal(one.kind, 'transfer');
  const multi = classifyContent('[阿澈的消息：hi]\n[阿澈的消息：hello]', char);
  assert.equal(multi.kind, 'mixed');
  assert.equal(multi.segments.length, 2);
});
