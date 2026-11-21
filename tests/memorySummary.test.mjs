import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countRounds, selectMessagesForRounds, unsummarizedMessages,
  extractSummarizableText, buildSummaryRequest, isExcludedFromSummary,
  DEFAULT_SUMMARY_PROMPT, SUMMARY_LENGTHS,
} from '../js/memorySummary.js';
import { fixtureCharacter } from './helpers.mjs';

const ch = fixtureCharacter();
let seq = 0;
function msg(role, content, extra = {}) {
  return { id: `m${++seq}`, charId: 'char_1', role, content, timestamp: 1000 + seq * 1000, ...extra };
}

test('轮次计数：多气泡同一 roundId 只算一轮', () => {
  seq = 0;
  const history = [
    msg('user', '你好'),
    msg('assistant', '[阿澈的消息：嗨]', { roundId: 'r1' }),
    msg('assistant', '[阿澈的消息：今天怎么样]', { roundId: 'r1' }),
    msg('assistant', '[阿澈的消息：想你了]', { roundId: 'r1' }),
    msg('user', '我也想你'),
    msg('assistant', '[阿澈的消息：那来找我]', { roundId: 'r2' }),
    msg('assistant', '[阿澈的消息：等你]', { roundId: 'r2' }),
  ];
  assert.equal(countRounds(history, ch), 2);
});

test('轮次计数：只有用户发言不算轮；AI 先说话不算轮；无 roundId 按连续块算', () => {
  seq = 0;
  assert.equal(countRounds([msg('user', '在吗'), msg('user', '回我一下')], ch), 0);
  assert.equal(countRounds([
    msg('assistant', '[阿澈的消息：早]'),
    msg('user', '早'),
    msg('assistant', '[阿澈的消息：嗯]'),
  ], ch), 1);
  // 没有 roundId 的旧数据：连续的 AI 消息块算一轮
  assert.equal(countRounds([
    msg('user', 'a'),
    msg('assistant', '[阿澈的消息：1]'),
    msg('assistant', '[阿澈的消息：2]'),
    msg('user', 'b'),
    msg('assistant', '[阿澈的消息：3]'),
  ], ch), 2);
});

test('轮次计数：状态/思考消息不算回复、不打断轮次', () => {
  seq = 0;
  const history = [
    msg('user', '今天去哪玩'),
    msg('assistant', '[阿澈更新状态为：开心]', { isStatusUpdate: true }),
    msg('assistant', '[阿澈的消息：去海边]', { roundId: 'r1' }),
    msg('assistant', '<thinking>内心独白</thinking>', { isThinking: true }),
    msg('user', '好啊'),
    msg('assistant', '[阿澈的消息：那就这么定了]', { roundId: 'r2' }),
  ];
  assert.equal(countRounds(history, ch), 2);
});

test('选最近 N 轮与未总结范围', () => {
  seq = 0;
  const history = [
    msg('user', '第一轮'),
    msg('assistant', '[阿澈的消息：回1]', { roundId: 'r1' }),
    msg('user', '第二轮'),
    msg('assistant', '[阿澈的消息：回2]', { roundId: 'r2' }),
    msg('user', '第三轮'),
    msg('assistant', '[阿澈的消息：回3]', { roundId: 'r3' }),
  ];
  const last1 = selectMessagesForRounds(history, 1, ch);
  assert.equal(last1.length, 2);
  assert.equal(last1[0].content, '第三轮');
  const last2 = selectMessagesForRounds(history, 2, ch);
  assert.equal(last2.length, 4);
  assert.equal(last2[0].content, '第二轮');

  const rest = unsummarizedMessages(history, history[1].id);
  assert.equal(rest.length, 4);
  assert.equal(rest[0].content, '第二轮');
  assert.equal(unsummarizedMessages(history, null).length, 6);
  assert.equal(unsummarizedMessages(history, '不存在的id').length, 6);
});

test('总结内容过滤：状态/思考/HTML 消息被排除，正文保留且去协议壳', () => {
  seq = 0;
  const history = [
    msg('user', '我们上周去海边约好下周再去'),
    msg('assistant', '[阿澈的消息：好啊，下周六见]', { roundId: 'r1' }),
    msg('assistant', '[阿澈更新状态为：开心]', { isStatusUpdate: true }),
    msg('assistant', '<thinking>他在想什么</thinking>'),
    msg('assistant', '<div class="status">状态栏模板代码</div>'),
    msg('assistant', '[阿澈的消息：记得带伞]', { roundId: 'r1' }),
  ];
  assert.equal(isExcludedFromSummary(history[2], ch), true);
  assert.equal(isExcludedFromSummary(history[3], ch), true);
  assert.equal(isExcludedFromSummary(history[4], ch), true);
  assert.equal(isExcludedFromSummary(history[1], ch), false);
  const text = extractSummarizableText(history, ch);
  assert.match(text, /我们上周去海边约好下周再去/);
  assert.match(text, /好啊，下周六见/);
  assert.match(text, /记得带伞/);
  assert.equal(text.includes('更新状态为'), false);
  assert.equal(text.includes('他在想什么'), false);
  assert.equal(text.includes('状态栏模板代码'), false);
  assert.equal(text.includes('[阿澈的消息：'), false);
});

test('总结内容过滤：图片只留标记不带 Base64；引用与照片描述保留', () => {
  seq = 0;
  const img = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD';
  const history = [
    msg('user', '看这张照片', { parts: [{ type: 'text', text: '看这张照片' }, { type: 'image', data: img }] }),
    msg('assistant', '[阿澈发来的照片/视频：海边的日落]', { roundId: 'r1' }),
    msg('user', '引用测试', { quote: { content: '下周六见' } }),
  ];
  const text = extractSummarizableText(history, ch);
  assert.equal(text.includes('base64'), false);
  assert.equal(text.includes('/9j/'), false);
  assert.match(text, /\[图片\]/);
  assert.match(text, /海边的日落/);
  assert.match(text, /引用“下周六见”并回复/);
});

test('总结提示词默认值与长度档', () => {
  assert.match(DEFAULT_SUMMARY_PROMPT, /只根据下面提供的聊天记录做总结/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /不要编造/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /HTML\/CSS/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /状态栏模板代码/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /Base64 图片/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /系统提示词/);
  assert.match(DEFAULT_SUMMARY_PROMPT, /保留人物、日期/);
  assert.equal(SUMMARY_LENGTHS.short.instruction.includes('200'), true);
  assert.equal(SUMMARY_LENGTHS.medium.instruction.includes('500'), true);
  assert.equal(SUMMARY_LENGTHS.long.instruction.includes('1000'), true);

  const req = buildSummaryRequest({ prompt: DEFAULT_SUMMARY_PROMPT, length: 'short', transcript: '[2026-11-20] 朵朵：你好' });
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[0].content, /200 字以内/);
  assert.match(req.messages[1].content, /你好/);
  const def = buildSummaryRequest({ prompt: '', length: 'unknown', transcript: 'x' });
  assert.match(def.messages[0].content, /500 字以内/);
});
