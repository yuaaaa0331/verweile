import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../js/promptBuilder.js';
import { buildRequest, filterHistoryForRequest, withdrawnPlaceholder } from '../js/historyBuilder.js';
import { fixtureCharacter, fixtureWorldBooks, fixtureStickers, globalSettings, countOccurrences } from './helpers.mjs';

const char = fixtureCharacter();
const deps = { worldBooks: fixtureWorldBooks(), stickers: fixtureStickers(), globalSettings };
const sys = buildSystemPrompt(char, deps);
const T0 = 1794000000000;

function msg(over) {
  return { id: `m_${Math.random()}`, role: 'user', content: '', timestamp: T0, ...over };
}

test('连续 3 条用户消息只点一次 get reply：顺序正确、每条只出现一次', () => {
  const history = [
    msg({ id: 'u1', content: '[朵朵的消息：第一句]', timestamp: T0 }),
    msg({ id: 'u2', content: '[朵朵的消息：第二句]', timestamp: T0 + 1000 }),
    msg({ id: 'u3', content: '[朵朵的消息：第三句]', timestamp: T0 + 2000 }),
  ];
  const { body, stats } = buildRequest(char, history, sys);
  const json = JSON.stringify(body.messages);
  assert.equal(countOccurrences(json, '第一句'), 1);
  assert.equal(countOccurrences(json, '第二句'), 1);
  assert.equal(countOccurrences(json, '第三句'), 1);
  assert.ok(json.indexOf('第一句') < json.indexOf('第二句') && json.indexOf('第二句') < json.indexOf('第三句'));
  assert.equal(countOccurrences(json, '<user_input>'), 1);
  assert.equal(countOccurrences(json, '</user_input>'), 1);
  assert.equal(countOccurrences(json, '<chat_history>'), 0, '无旧历史时不应有空 chat_history');
  assert.equal(stats.userInputCount, 1, '最新一轮合并为 1 条 user 消息');
});

test('content 与相同 parts.text 不重复发送；chat_history 与最新输入各出现一次', () => {
  const history = [
    msg({ id: 'a1', role: 'assistant', content: '[阿澈的消息：你好呀]', parts: [{ type: 'text', text: '[阿澈的消息：你好呀]' }], timestamp: T0 }),
    msg({ id: 'u1', content: '[朵朵的消息：在吗]', parts: [{ type: 'text', text: '[朵朵的消息：在吗]' }], timestamp: T0 + 600000 }),
    msg({ id: 'a2', role: 'assistant', content: '[阿澈的消息：在的]', parts: [{ type: 'text', text: '[阿澈的消息：在的]' }], timestamp: T0 + 660000 }),
    msg({ id: 'u2', content: '[朵朵的消息：今天很开心]', parts: [{ type: 'text', text: '[朵朵的消息：今天很开心]' }], timestamp: T0 + 720000 }),
  ];
  const { body, stats } = buildRequest(char, history, sys);
  const json = JSON.stringify(body.messages);
  // '你好呀' 在 TT 模板示例里出现 1 次（1.普通消息示例），历史里 1 次，共 2 次；不得多于 2 次
  assert.equal(countOccurrences(json, '你好呀'), 2, 'content 与 parts 相同文本不得拼接重复');
  assert.equal(countOccurrences(JSON.stringify(body.messages.slice(1)), '你好呀'), 0, '历史只应进 system 的 chat_history');
  assert.equal(countOccurrences(json, '在吗'), 1);
  assert.equal(countOccurrences(json, '今天很开心'), 1);
  assert.equal(countOccurrences(json, '<chat_history>'), 1);
  assert.equal(countOccurrences(json, '</chat_history>'), 1);
  assert.equal(countOccurrences(json, '<user_input>'), 1);
  assert.equal(stats.chatHistoryUsed, true);
  // chat_history 里不应包含最新用户输入
  const sysText = body.messages[0].content;
  const histPart = sysText.slice(sysText.indexOf('<chat_history>'), sysText.indexOf('</chat_history>'));
  assert.ok(!histPart.includes('今天很开心'), '最新用户输入只在 user_input 里');
  assert.ok(histPart.includes('你好呀') && histPart.includes('在的'));
});

test('禁用上下文、思考内容、空消息被排除；图像 parts 不丢失', () => {
  const history = [
    msg({ id: 'x1', content: '不要发我', isContextDisabled: true, timestamp: T0 }),
    msg({ id: 'x2', role: 'assistant', content: '<thinking>内部推理</thinking>[阿澈的消息：嗨]', isThinking: true, timestamp: T0 + 1 }),
    msg({ id: 'x3', role: 'assistant', content: '<thinking>推理</thinking>', timestamp: T0 + 2 }),
    msg({ id: 'img1', content: 'data:image/jpeg;base64,AAA', parts: [{ type: 'text', text: '[朵朵发来了一张图片：]' }, { type: 'image', data: 'data:image/jpeg;base64,AAA' }], timestamp: T0 + 3 }),
    msg({ id: 'u1', content: '[朵朵的消息：看图]', timestamp: T0 + 4 }),
  ];
  const filtered = filterHistoryForRequest(char, history);
  assert.equal(filtered.length, 2);
  const { body } = buildRequest(char, history, sys);
  const json = JSON.stringify(body.messages);
  assert.ok(!json.includes('不要发我') && !json.includes('内部推理') && !json.includes('推理'));
  assert.ok(json.includes('image_url'), '图像 part 应以 image_url 进入请求');
  assert.ok(json.includes('data:image/jpeg;base64,AAA'));
});

test('撤回消息按可见占位序列化，原文不再出现；引用序列化', () => {
  const history = [
    msg({ id: 'u1', content: '[朵朵的消息：普通消息]', timestamp: T0 }),
    // 撤回后只剩占位：originalContent 留在本地记录里，绝不进请求
    msg({ id: 'u2', content: '[朵朵 撤回了一条消息：秘密内容不要外传]', isWithdrawn: true, originalContent: '秘密内容不要外传', timestamp: T0 + 1000 }),
    msg({ id: 'u3', content: '[朵朵的消息：引用测试]', quote: { content: '你好呀', messageId: 'a1' }, timestamp: T0 + 2000 }),
  ];
  const { body } = buildRequest(char, history, sys);
  const json = JSON.stringify(body.messages);
  assert.equal(countOccurrences(json, '秘密内容不要外传'), 0, '撤回原文绝不能进请求，占位里也不带');
  assert.ok(json.includes('撤回了一条消息'));
  assert.ok(json.includes('[朵朵引用“你好呀”并回复：引用测试]'));
});

test('withdrawnPlaceholder：只留“撤回了一条消息”，不拼 originalContent 也不拼 content 原文', () => {
  const userMsg = { id: 'u1', role: 'user', content: '[朵朵的消息：秘密内容不要外传]', isWithdrawn: true, originalContent: '秘密内容不要外传' };
  const asstMsg = { id: 'a1', role: 'assistant', content: '[阿澈的消息：另一句秘密]', isWithdrawn: true, originalContent: '另一句秘密' };
  assert.equal(withdrawnPlaceholder(userMsg, char), '[朵朵 撤回了一条消息]');
  assert.equal(withdrawnPlaceholder(asstMsg, char), '[阿澈撤回了一条消息]');
  // 经 filterHistoryForRequest 后，撤回消息只有占位 part，原文彻底消失
  const filtered = filterHistoryForRequest(char, [userMsg, asstMsg]);
  assert.equal(filtered.length, 2);
  for (const m of filtered) {
    assert.equal(m.parts.length, 1);
    assert.match(m.parts[0].text, /撤回了一条消息/);
    assert.equal(m.content.includes('秘密'), false);
  }
});

test('同角色相邻合并；时间标记每 10 分钟出现；maxMemory 字符串 80 生效', () => {
  const history = [];
  for (let i = 0; i < 100; i++) {
    history.push(msg({ id: `u${i}`, content: `[朵朵的消息：第${i}句]`, timestamp: T0 + i * 1000 }));
  }
  const { body, stats } = buildRequest(char, history, sys);
  assert.equal(stats.sliced, 80, "maxMemory '80' 应转为数值 80");
  assert.equal(stats.historyMessages, 80);
  assert.equal(body.messages.length, 2, 'system + 1 条合并后的 user 消息');
  const hist2 = [
    msg({ id: 'a1', role: 'assistant', content: '[阿澈的消息：早]', timestamp: T0 }),
    msg({ id: 'a2', role: 'assistant', content: '[阿澈的消息：午好]', timestamp: T0 + 11 * 60 * 1000 }),
  ];
  const r2 = buildRequest(char, hist2, sys);
  const j2 = JSON.stringify(r2.body.messages);
  assert.equal(countOccurrences(j2, '[system:'), 2, '两条间隔 11 分钟的消息各带一个时间标记');
});

test('Gemini 分支：contents 不合并、system_instruction 分离、user_input 正确', () => {
  const history = [
    msg({ id: 'u1', content: '[朵朵的消息：你好]', timestamp: T0 }),
    msg({ id: 'u2', content: '[朵朵的消息：再说一句]', timestamp: T0 + 1000 }),
  ];
  const { body } = buildRequest(char, history, sys, { provider: 'gemini' });
  assert.equal(body.contents.length, 2, 'Gemini 不合并相邻同角色');
  // 无旧历史时占位符应直接去掉，不留空 <chat_history>
  assert.ok(!body.system_instruction.parts[0].text.includes('<chat_history>'));
  const joined = body.contents.map((c) => c.parts.map((p) => p.text || '').join('')).join('');
  assert.equal(countOccurrences(joined, '<user_input>'), 1);
  // 有旧历史时 chat_history 出现一次
  const history2 = [
    msg({ id: 'a0', role: 'assistant', content: '[阿澈的消息：旧消息]', timestamp: T0 - 600000 }),
    ...history,
  ];
  const r2 = buildRequest(char, history2, sys, { provider: 'gemini' });
  assert.equal(countOccurrences(r2.body.system_instruction.parts[0].text, '<chat_history>'), 1);
  assert.ok(r2.body.system_instruction.parts[0].text.includes('旧消息'));
  assert.equal(r2.body.contents.length, 2, '旧历史进 system_instruction，不再重复进 contents');
});
