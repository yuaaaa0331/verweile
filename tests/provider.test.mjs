import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveOpenAIEndpoint, resolveGeminiEndpoint, isBlockedUrl, testConnection, sendChat } from '../js/providerAdapter.js';

test('Base URL 不重复拼接 /v1；三种写法都对', () => {
  assert.equal(resolveOpenAIEndpoint('https://api.example.com'), 'https://api.example.com/v1/chat/completions');
  assert.equal(resolveOpenAIEndpoint('https://api.example.com/v1'), 'https://api.example.com/v1/chat/completions');
  assert.equal(resolveOpenAIEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/chat/completions');
  assert.equal(resolveOpenAIEndpoint('https://api.example.com/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(resolveGeminiEndpoint('https://gen.example.com', 'gemini-x', true), 'https://gen.example.com/v1beta/models/gemini-x:streamGenerateContent');
});

test('屏蔽域名与连接检查（fake fetch）', async () => {
  assert.equal(isBlockedUrl('https://api522.pro/v1'), true);
  assert.equal(isBlockedUrl('https://api.example.com'), false);
  const fakeFetch = async (url) => ({
    ok: true,
    json: async () => ({ data: [{ id: 'gpt-x' }] }),
  });
  const ok = await testConnection({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' }, fakeFetch);
  assert.equal(ok.ok, true);
  const bad = await testConnection({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'nope' }, fakeFetch);
  assert.equal(bad.ok, true);
  assert.ok(bad.message.includes('未找到'));
  const missing = await testConnection({ provider: 'openai', url: '', key: '', model: '' }, fakeFetch);
  assert.equal(missing.ok, false);
});

test('sendChat 非流式：用 fake fetch 返回 JSON，不吞错误状态', async () => {
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => 'application/json' },
    body: null,
    text: async () => JSON.stringify({ choices: [{ message: { content: '[阿澈的消息：嗨]' } }] }),
  });
  const r = await sendChat(
    { provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x', streamEnabled: false },
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: fakeFetch },
  );
  assert.equal(r.text, '[阿澈的消息：嗨]');
  const errFetch = async () => ({ ok: false, status: 401, text: async () => 'bad key' });
  await assert.rejects(
    sendChat({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' }, { messages: [] }, { fetchImpl: errFetch }),
    (e) => e.status === 401,
  );
});
