import test from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveBase, resolveModelsEndpoint, resolveEmbeddingsEndpoint,
  resolveGeminiModelsEndpoint, resolveGeminiEmbedEndpoint,
  fetchModels, testSummaryApi, testEmbeddingApi, validateEmbeddingResponse,
  callSummaryChat, callEmbeddings, withoutKey,
} from '../js/auxApi.js';
import { MemoryBackend } from '../js/storage.js';
import { exportAll, normalizeBackup } from '../js/importExport.js';

test('URL 拼接：去尾斜杠、防 /v1 重复、embeddings 路径正确', () => {
  assert.equal(resolveBase('https://api.example.com/'), 'https://api.example.com');
  assert.equal(resolveBase('https://api.example.com/v1'), 'https://api.example.com');
  assert.equal(resolveBase('https://api.example.com/v1/chat/completions'), 'https://api.example.com');
  assert.equal(resolveBase('https://api.example.com/v1/'), 'https://api.example.com');
  assert.equal(resolveModelsEndpoint('https://api.example.com/v1/'), 'https://api.example.com/v1/models');
  assert.equal(resolveEmbeddingsEndpoint('https://api.example.com'), 'https://api.example.com/v1/embeddings');
  assert.equal(resolveEmbeddingsEndpoint('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1/embeddings');
  assert.equal(resolveGeminiModelsEndpoint('https://gen.example.com/'), 'https://gen.example.com/v1beta/models');
  assert.equal(resolveGeminiEmbedEndpoint('https://gen.example.com', 'text-embedding-004'), 'https://gen.example.com/v1beta/models/text-embedding-004:embedContent');
});

test('拉取模型：OpenAI 与 Gemini 各走各的路', async () => {
  const openaiFetch = async (url, opts) => {
    assert.ok(url.endsWith('/v1/models'));
    assert.equal(opts.headers.Authorization, 'Bearer k');
    return { ok: true, text: async () => JSON.stringify({ data: [{ id: 'gpt-x' }, { id: 'emb-y' }] }) };
  };
  const r1 = await fetchModels({ provider: 'openai', url: 'https://api.example.com/v1/', key: 'k', model: 'gpt-x' }, openaiFetch);
  assert.equal(r1.ok, true);
  assert.deepEqual(r1.models, ['gpt-x', 'emb-y']);

  const geminiFetch = async (url) => {
    assert.ok(url.includes('/v1beta/models?key=k'));
    return { ok: true, text: async () => JSON.stringify({ models: [{ name: 'models/gemini-x' }] }) };
  };
  const r2 = await fetchModels({ provider: 'gemini', url: 'https://gen.example.com', key: 'k', model: 'gemini-x' }, geminiFetch);
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.models, ['gemini-x']);

  const fail = await fetchModels({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' },
    async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
  assert.equal(fail.ok, false);
  assert.deepEqual(fail.models, []);
  assert.match(fail.message, /鉴权失败/);
});

test('总结副 API 测试：以“能出字”为标准；401 与断网都给明确中文提示', async () => {
  const okFetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: '好' } }] }),
  });
  const ok = await testSummaryApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' }, okFetch);
  assert.equal(ok.ok, true);
  assert.match(ok.message, /可以正常出字/);

  const emptyFetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ choices: [{ message: { content: '' } }] }),
  });
  const empty = await testSummaryApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' }, emptyFetch);
  assert.equal(empty.ok, false);
  assert.match(empty.message, /没有返回任何文字/);

  const bad = await testSummaryApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' },
    async () => ({ ok: false, status: 401, text: async () => 'bad key' }));
  assert.equal(bad.ok, false);
  assert.match(bad.message, /鉴权失败/);

  const net = await testSummaryApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' },
    async () => { throw new TypeError('Failed to fetch'); });
  assert.equal(net.ok, false);
  assert.match(net.message, /无法连接|跨域/);

  const missing = await testSummaryApi({ provider: 'openai', url: '', key: '', model: '' }, okFetch);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /请先填写/);
});

test('embeddings 响应校验：数值数组 + 维度；坏格式一律不通过', () => {
  const good = validateEmbeddingResponse({ data: [{ embedding: [0.1, -0.2, 0.3] }] }, 'openai');
  assert.equal(good.ok, true);
  assert.equal(good.dimensions, 3);
  assert.equal(good.count, 1);

  assert.equal(validateEmbeddingResponse({ data: [] }, 'openai').ok, false);
  assert.equal(validateEmbeddingResponse({ data: [{ embedding: 'not-array' }] }, 'openai').ok, false);
  assert.equal(validateEmbeddingResponse({ data: [{ embedding: [0.1, 'x'] }] }, 'openai').ok, false);
  assert.equal(validateEmbeddingResponse({ data: [{ embedding: [0.1] }, { embedding: [0.1, 0.2] }] }, 'openai').ok, false);

  const geminiGood = validateEmbeddingResponse({ embedding: { values: [0.5, 0.5] } }, 'gemini');
  assert.equal(geminiGood.ok, true);
  assert.equal(geminiGood.dimensions, 2);
  assert.equal(validateEmbeddingResponse({ embedding: {} }, 'gemini').ok, false);
});

test('向量 API 测试：发真实 embeddings 调用；模型不支持时 404 明确报错', async () => {
  const okFetch = async (url, opts) => {
    assert.ok(url.endsWith('/v1/embeddings'));
    const body = JSON.parse(opts.body);
    assert.equal(body.input[0], '测试向量');
    return { ok: true, text: async () => JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }) };
  };
  const ok = await testEmbeddingApi({ provider: 'openai', url: 'https://api.example.com/v1', key: 'k', model: 'emb-1' }, okFetch);
  assert.equal(ok.ok, true);
  assert.equal(ok.dimensions, 2);
  assert.match(ok.message, /向量接口可用/);

  const badShape = await testEmbeddingApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'emb-1' },
    async () => ({ ok: true, text: async () => JSON.stringify({ data: [{ embedding: 'nope' }] }) }));
  assert.equal(badShape.ok, false);
  assert.match(badShape.message, /格式不对/);

  const notFound = await testEmbeddingApi({ provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' },
    async () => ({ ok: false, status: 404, text: async () => 'model not found' }));
  assert.equal(notFound.ok, false);
  assert.match(notFound.message, /404/);

  const geminiFetch = async (url) => {
    assert.ok(url.includes(':embedContent?key=k'));
    return { ok: true, text: async () => JSON.stringify({ embedding: { values: [0.1, 0.2, 0.3] } }) };
  };
  const g = await testEmbeddingApi({ provider: 'gemini', url: 'https://gen.example.com', key: 'k', model: 'text-embedding-004' }, geminiFetch);
  assert.equal(g.ok, true);
  assert.equal(g.dimensions, 3);
});

test('callSummaryChat / callEmbeddings：走对端点、返回干净结果', async () => {
  const chatFetch = async (url, opts) => {
    assert.ok(url.endsWith('/v1/chat/completions'));
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content: '总结：一起散了步。' } }] }) };
  };
  const text = await callSummaryChat(
    { provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x' },
    [{ role: 'system', content: '总结' }, { role: 'user', content: '记录' }],
    chatFetch,
  );
  assert.equal(text, '总结：一起散了步。');

  const embFetch = async () => ({
    ok: true,
    text: async () => JSON.stringify({ data: [{ embedding: [1, 2] }, { embedding: [3, 4] }] }),
  });
  const emb = await callEmbeddings(
    { provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'emb-1' },
    ['a', 'b'],
    embFetch,
  );
  assert.equal(emb.dimensions, 2);
  assert.deepEqual(emb.vectors, [[1, 2], [3, 4]]);

  await assert.rejects(
    callSummaryChat({ provider: 'openai', url: '', key: '', model: '' }, [], chatFetch),
    (e) => /请先填写/.test(e.message),
  );
});

test('导出默认不含新 Key；含密钥的私人备份需明确勾选才含；导入能解析副 API 配置', async () => {
  assert.deepEqual(withoutKey({ provider: 'openai', url: 'u', key: 'sk-x', model: 'm' }), { provider: 'openai', url: 'u', model: 'm' });
  const backend = new MemoryBackend();
  await backend.put('settings', { key: 'summaryApi', value: { provider: 'openai', url: 'https://s.example.com', key: 'sk-secret-summary', model: 'gpt-x' } });
  await backend.put('settings', { key: 'embeddingApi', value: { provider: 'openai', url: 'https://e.example.com', key: 'sk-secret-embedding', model: 'emb-1' } });
  const out = await exportAll(backend);
  const dumped = JSON.stringify(out);
  assert.equal(dumped.includes('sk-secret-summary'), false);
  assert.equal(dumped.includes('sk-secret-embedding'), false);
  assert.equal(out.summaryApi.url, 'https://s.example.com');
  assert.equal(out.summaryApi.model, 'gpt-x');
  assert.equal(out.embeddingApi.model, 'emb-1');
  assert.equal('key' in (out.summaryApi || {}), false);
  assert.equal('key' in (out.embeddingApi || {}), false);

  const withKeys = await exportAll(backend, { includeKeys: true });
  assert.equal(withKeys.summaryApi.key, 'sk-secret-summary');
  assert.equal(withKeys.embeddingApi.key, 'sk-secret-embedding');

  const norm = normalizeBackup({
    summaryApi: { provider: 'openai', url: 'https://s.example.com', key: 'sk-x', model: 'gpt-x' },
    embeddingApi: { provider: 'gemini', url: 'https://g.example.com', key: 'sk-y', model: 'emb-g' },
    characters: [],
  });
  assert.equal(norm.summaryApi.model, 'gpt-x');
  assert.equal(norm.embeddingApi.provider, 'gemini');
  assert.equal('summaryApi' in norm.unknown, false);
  assert.equal('embeddingApi' in norm.unknown, false);
});
