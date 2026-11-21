// auxApi.js — 记忆总结副 API 与向量 Embedding API（auxApi）。
// 与主 API 完全独立的配置：各自的 Base URL / Key / 模型，存在 settings 的
// 'summaryApi'、'embeddingApi' 键里，不与主 API 混用。
// 本文件只放纯逻辑 + fetch 注入（URL 拼接、响应格式校验、错误分类、真实调用），
// 可在 Node 测试里用 fake fetch 验证；UI 层（app.js）只做绑定。
// 绝不只看模型名字判断支不支持向量：Embedding 测试一定发一次真实 embeddings 调用。
import { resolveOpenAIEndpoint, resolveGeminiEndpoint, isBlockedUrl } from './providerAdapter.js';
import { pickKey } from './utils.js';

/** 去尾斜杠，并去掉已带上的 /v1 或 /v1/chat/completions，得到干净的 base。 */
export function resolveBase(baseUrl) {
  return String(baseUrl || '').replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
}

/** OpenAI 兼容：GET {base}/v1/models（拉取模型列表用）。 */
export function resolveModelsEndpoint(baseUrl) {
  return `${resolveBase(baseUrl)}/v1/models`;
}

/** OpenAI 兼容：POST {base}/v1/embeddings（向量接口）。 */
export function resolveEmbeddingsEndpoint(baseUrl) {
  return `${resolveBase(baseUrl)}/v1/embeddings`;
}

/** Gemini：GET {base}/v1beta/models?key=（与 providerAdapter.testConnection 同一路）。 */
export function resolveGeminiModelsEndpoint(baseUrl) {
  return `${resolveBase(baseUrl)}/v1beta/models`;
}

/** Gemini 原生向量：POST {base}/v1beta/models/{model}:embedContent?key=。 */
export function resolveGeminiEmbedEndpoint(baseUrl, model) {
  return `${resolveBase(baseUrl)}/v1beta/models/${encodeURIComponent(model)}:embedContent`;
}

/** 去掉凭据，只留非 Key 字段（导入备份待确认、日志等场景用）。 */
export function withoutKey(cfg) {
  const { key, ...rest } = cfg || {};
  void key;
  return rest;
}

/**
 * 把 fetch / HTTP 错误转成给 Dolores 看的中文原因。
 * 失败、未配置、鉴权失败、模型不支持、跨域/CORS 都明确说出来，绝不显示虚假成功。
 */
export function classifyApiError(e, context = '请求') {
  const status = e?.status ?? e?.response?.status;
  if (status) {
    switch (status) {
      case 400: return `${context}失败（400）：请求有误，通常是模型名不对，或该模型不支持这个接口，请更换模型再试。`;
      case 401:
      case 403: return `${context}失败（${status}）：鉴权失败，API Key 无效或没有权限，请检查 Key。`;
      case 404: return `${context}失败（404）：接口不存在，请检查 Base URL 是否正确，或该模型不支持这个接口。`;
      case 429: return `${context}失败（429）：请求太频繁或额度不足，请稍后再试。`;
      case 500:
      case 502:
      case 503:
      case 504: return `${context}失败（${status}）：服务商那边出问题了，请稍后再试。`;
      default: return `${context}失败（${status}）：${String(e?.message || '服务器返回错误').slice(0, 120)}`;
    }
  }
  if (e instanceof TypeError || /failed to fetch|networkerror|load failed/i.test(e?.message || '')) {
    return `${context}失败：无法连接到服务器，可能是地址写错、网络问题，或浏览器跨域（CORS）拦截了请求。`;
  }
  if (/HTML|<!doctype|<html/i.test(e?.message || '')) {
    return `${context}失败：服务器返回了网页而不是 JSON，请检查 Base URL 是否正确。`;
  }
  return `${context}失败：${e?.message || '未知错误'}`;
}

function checkAuxConfig(cfg) {
  if (!cfg?.url || !cfg?.key || !cfg?.model) {
    return { ok: false, message: '请先填写 Base URL、API Key 和模型。' };
  }
  if (isBlockedUrl(cfg.url)) return { ok: false, message: '当前 API 站点已被屏蔽，无法连接。' };
  return null;
}

async function readJsonSafe(res) {
  const text = await res.text().catch(() => '');
  try { return JSON.parse(text); } catch { return { _raw: text }; }
}

function throwHttp(res, bodyText) {
  const err = new Error(`API Error: ${res.status} ${String(bodyText || '').slice(0, 200)}`);
  err.status = res.status;
  err.body = bodyText;
  throw err;
}

/**
 * 拉取模型列表。OpenAI 兼容走 GET {base}/v1/models；
 * Gemini 走 GET /v1beta/models?key=（与现有 testConnection 同一路）。
 * 返回 { ok, models, message }；失败时 models 为 []，仍允许手动填写模型。
 */
export async function fetchModels(config, fetchImpl = fetch) {
  const bad = checkAuxConfig(config);
  if (bad) return { ...bad, models: [] };
  const { provider = 'openai', url, key } = config;
  try {
    if (provider === 'gemini') {
      const res = await fetchImpl(`${resolveGeminiModelsEndpoint(url)}?key=${encodeURIComponent(pickKey(key))}`);
      if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
      const data = await readJsonSafe(res);
      const models = (data.models || []).map((m) => String(m.name || '').replace(/^models\//, '')).filter(Boolean);
      return { ok: true, models, message: models.length ? `已拉取 ${models.length} 个模型。` : '连接成功，但模型列表为空，请手动填写模型。' };
    }
    const res = await fetchImpl(resolveModelsEndpoint(url), {
      headers: { Authorization: `Bearer ${pickKey(key)}` },
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
    const data = await readJsonSafe(res);
    const models = (data.data || []).map((m) => m.id).filter(Boolean);
    return { ok: true, models, message: models.length ? `已拉取 ${models.length} 个模型。` : '连接成功，但模型列表为空，请手动填写模型。' };
  } catch (e) {
    return { ok: false, models: [], message: classifyApiError(e, '拉取模型列表') };
  }
}

function extractChatText(data, provider) {
  if (provider === 'gemini') {
    const parts = data?.candidates?.[0]?.content?.parts || [];
    return parts.map((p) => p.text || '').join('').trim();
  }
  return String(data?.choices?.[0]?.message?.content || '').trim();
}

/**
 * 总结副 API 测试：发一次最小的真实 chat 调用，以“能出字”为标准。
 * 只调 models 列表不算通过；有响应但没出字也算失败。
 */
export async function testSummaryApi(config, fetchImpl = fetch) {
  const bad = checkAuxConfig(config);
  if (bad) return bad;
  const { provider = 'openai', url, key, model } = config;
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetchImpl(`${resolveGeminiEndpoint(url, model, false)}?key=${encodeURIComponent(pickKey(key))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: '你好，请只回一个字：好' }] }],
          generationConfig: { maxOutputTokens: 8 },
        }),
      });
    } else {
      res = await fetchImpl(resolveOpenAIEndpoint(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pickKey(key)}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: '你好，请只回一个字：好' }],
          max_tokens: 8,
          temperature: 0,
          stream: false,
        }),
      });
    }
    if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
    const data = await readJsonSafe(res);
    const text = extractChatText(data, provider);
    if (!text) return { ok: false, message: '副 API 有响应，但没有返回任何文字，请检查模型是否支持聊天调用。' };
    return { ok: true, message: `连接成功：副 API 可以正常出字（模型 ${model}，回了「${text.slice(0, 12)}」）。` };
  } catch (e) {
    return { ok: false, message: classifyApiError(e, '测试总结副 API') };
  }
}

/**
 * 校验 embeddings 响应。OpenAI 格式：{ data: [{ embedding: [数值…] }] }；
 * Gemini 格式：{ embedding: { values: [数值…] } }。
 * 要求 embedding 是数值数组、长度 > 0；多条时维度一致。
 * 返回 { ok, dimensions, count, message }。
 */
export function validateEmbeddingResponse(data, provider = 'openai') {
  const fail = (message) => ({ ok: false, dimensions: 0, count: 0, message });
  if (provider === 'gemini') {
    const values = data?.embedding?.values;
    if (!Array.isArray(values) || !values.length) return fail('向量接口返回格式不对：没有取到 embedding.values 数组。');
    if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return fail('向量接口返回格式不对：embedding.values 里有非数值。');
    }
    return { ok: true, dimensions: values.length, count: 1, message: `向量正常，维度 ${values.length}。` };
  }
  const rows = data?.data;
  if (!Array.isArray(rows) || !rows.length) return fail('向量接口返回格式不对：没有取到 data 数组。');
  const dim = rows[0]?.embedding?.length;
  if (!Array.isArray(rows[0]?.embedding) || !dim) return fail('向量接口返回格式不对：data[0].embedding 不是数值数组。');
  for (const r of rows) {
    if (!Array.isArray(r?.embedding) || r.embedding.length !== dim) {
      return fail('向量接口返回格式不对：各条 embedding 维度不一致。');
    }
    if (!r.embedding.every((v) => typeof v === 'number' && Number.isFinite(v))) {
      return fail('向量接口返回格式不对：embedding 里有非数值。');
    }
  }
  return { ok: true, dimensions: dim, count: rows.length, message: `向量正常，${rows.length} 条，维度 ${dim}。` };
}

/**
 * 向量 Embedding API 测试：发一次真实 embeddings 调用，校验返回的向量。
 * 不只看模型名字判断支不支持向量；模型不支持会在这里直接报错。
 */
export async function testEmbeddingApi(config, fetchImpl = fetch) {
  const bad = checkAuxConfig(config);
  if (bad) return bad;
  const { provider = 'openai', url, key, model } = config;
  try {
    let res;
    if (provider === 'gemini') {
      res = await fetchImpl(`${resolveGeminiEmbedEndpoint(url, model)}?key=${encodeURIComponent(pickKey(key))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: { parts: [{ text: '测试向量' }] } }),
      });
    } else {
      res = await fetchImpl(resolveEmbeddingsEndpoint(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pickKey(key)}` },
        body: JSON.stringify({ model, input: ['测试向量'] }),
      });
    }
    if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
    const data = await readJsonSafe(res);
    const v = validateEmbeddingResponse(data, provider);
    if (!v.ok) return v;
    return { ok: true, dimensions: v.dimensions, message: `连接成功：向量接口可用，${v.message}` };
  } catch (e) {
    return { ok: false, message: classifyApiError(e, '测试向量 Embedding API') };
  }
}

/**
 * 用总结副 API 做一次非流式聊天调用（记忆总结用）。返回纯文本。
 * 出错时抛 Error（message 已是中文友好提示，带 .status）。
 */
export async function callSummaryChat(config, messages, fetchImpl = fetch) {
  const bad = checkAuxConfig(config);
  if (bad) { const e = new Error(bad.message); e.status = 0; throw e; }
  const { provider = 'openai', url, key, model } = config;
  try {
    let res;
    if (provider === 'gemini') {
      const system = (messages.find((m) => m.role === 'system')?.content) || '';
      const userParts = messages.filter((m) => m.role !== 'system').map((m) => ({ text: m.content || '' }));
      res = await fetchImpl(`${resolveGeminiEndpoint(url, model, false)}?key=${encodeURIComponent(pickKey(key))}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: userParts }],
          system_instruction: system ? { parts: [{ text: system }] } : undefined,
          generationConfig: { temperature: 0.3, maxOutputTokens: 2000 },
        }),
      });
    } else {
      res = await fetchImpl(resolveOpenAIEndpoint(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pickKey(key)}` },
        body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 2000, stream: false }),
      });
    }
    if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
    const data = await readJsonSafe(res);
    return extractChatText(data, provider);
  } catch (e) {
    if (e.status !== undefined) throw e;
    const err = new Error(classifyApiError(e, '调用总结副 API'));
    err.status = 0;
    throw err;
  }
}

/**
 * 调向量接口取文本向量（后续向量检索用，本轮只提供可测试的调用层）。
 * 返回 { vectors: number[][], dimensions }；出错时抛中文 Error。
 */
export async function callEmbeddings(config, texts, fetchImpl = fetch) {
  const bad = checkAuxConfig(config);
  if (bad) { const e = new Error(bad.message); e.status = 0; throw e; }
  const { provider = 'openai', url, key, model } = config;
  const inputs = (Array.isArray(texts) ? texts : [texts]).filter((t) => String(t || '').trim());
  if (!inputs.length) return { vectors: [], dimensions: 0 };
  try {
    if (provider === 'gemini') {
      const vectors = [];
      for (const text of inputs) {
        const res = await fetchImpl(`${resolveGeminiEmbedEndpoint(url, model)}?key=${encodeURIComponent(pickKey(key))}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: { parts: [{ text }] } }),
        });
        if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
        const data = await readJsonSafe(res);
        const v = validateEmbeddingResponse(data, 'gemini');
        if (!v.ok) throw new Error(v.message);
        vectors.push(data.embedding.values);
      }
      return { vectors, dimensions: vectors[0]?.length || 0 };
    }
    const res = await fetchImpl(resolveEmbeddingsEndpoint(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pickKey(key)}` },
      body: JSON.stringify({ model, input: inputs }),
    });
    if (!res.ok) { const t = await res.text().catch(() => ''); throwHttp(res, t); }
    const data = await readJsonSafe(res);
    const v = validateEmbeddingResponse(data, 'openai');
    if (!v.ok) throw new Error(v.message);
    return { vectors: data.data.map((r) => r.embedding), dimensions: v.dimensions };
  } catch (e) {
    if (e.status !== undefined) throw e;
    const err = new Error(classifyApiError(e, '调用向量 Embedding API'));
    err.status = 0;
    throw err;
  }
}
