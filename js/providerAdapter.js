// providerAdapter.js — 模型请求适配（providerAdapter）。
// OpenAI 兼容为主；Gemini 原生单独一路，绝不用 OpenAI 格式调 Gemini 端点。
// 遵守用户填入的完整地址，避免重复拼接 /v1。
import { createSSEParser, parseNonStreamText, parseGeminiStreamText } from './sse.js';
import { pickKey } from './utils.js';

export const BLOCKED_API_DOMAINS = ['api522.pro', 'api521.pro', 'api520.pro'];

export function resolveOpenAIEndpoint(baseUrl) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  if (url.endsWith('/chat/completions')) return url;
  if (url.endsWith('/v1')) return `${url}/chat/completions`;
  return `${url}/v1/chat/completions`;
}

export function resolveGeminiEndpoint(baseUrl, model, stream) {
  const url = String(baseUrl || '').replace(/\/+$/, '');
  const action = stream ? 'streamGenerateContent' : 'generateContent';
  return `${url}/v1beta/models/${encodeURIComponent(model)}:${action}`;
}

export function isBlockedUrl(url) {
  return BLOCKED_API_DOMAINS.some((d) => String(url || '').includes(d));
}

/** 连接检查：OpenAI 兼容用 GET {base}/models；Gemini 用 GET /v1beta/models?key=。 */
export async function testConnection(config, fetchImpl = fetch) {
  const { provider = 'openai', url, key, model } = config || {};
  if (!url || !key || !model) return { ok: false, message: '请先填写 Base URL、API Key 和模型。' };
  if (isBlockedUrl(url)) return { ok: false, message: '当前 API 站点已被屏蔽，无法连接。' };
  try {
    if (provider === 'gemini') {
      const base = String(url).replace(/\/+$/, '');
      const res = await fetchImpl(`${base}/v1beta/models?key=${encodeURIComponent(pickKey(key))}`);
      if (!res.ok) return { ok: false, status: res.status, message: `连接失败（${res.status}）。请检查 Base URL 与 Key。` };
      const data = await res.json().catch(() => ({}));
      const models = (data.models || []).map((m) => String(m.name || '').replace(/^models\//, ''));
      return { ok: true, message: models.includes(model) ? `连接成功，模型 ${model} 可用。` : `连接成功，但模型列表中未找到 ${model}，请核对模型名。`, models };
    }
    const base = String(url).replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/v1$/, '');
    const res = await fetchImpl(`${base}/v1/models`, {
      headers: { Authorization: `Bearer ${pickKey(key)}` },
    });
    if (!res.ok) return { ok: false, status: res.status, message: `连接失败（${res.status}）。请检查 Base URL 与 Key。` };
    const data = await res.json().catch(() => ({}));
    const models = (data.data || []).map((m) => m.id).filter(Boolean);
    return { ok: true, message: models.includes(model) ? `连接成功，模型 ${model} 可用。` : `连接成功，但模型列表中未找到 ${model}，请核对模型名。`, models };
  } catch (e) {
    return { ok: false, message: `无法连接：${e.message || e}` };
  }
}

/**
 * 发送一次聊天请求。
 * config: { provider, url, key, model, temperatureEnabled, temperature, streamEnabled }
 * request: buildRequest() 的 body（OpenAI: {messages}；Gemini: {contents, system_instruction}）
 * 返回 { text, streamed }；流式时 onDelta 逐段回调；signal 用于停止（AbortController）。
 * 出错时抛 Error（带 .status），调用方转友好提示；绝不吞掉用户已发送内容。
 */
export async function sendChat(config, request, { signal, onDelta, fetchImpl = fetch } = {}) {
  const { provider = 'openai', url, key, model } = config || {};
  const stream = !!config?.streamEnabled;
  if (!url || !key || !model) {
    const err = new Error('请先在 API 设置中填写 Base URL、API Key 和模型。');
    err.status = 0; throw err;
  }
  if (isBlockedUrl(url)) {
    const err = new Error('当前 API 站点已被屏蔽，无法发送消息。');
    err.status = 0; throw err;
  }
  const temperature = config?.temperatureEnabled && config?.temperature !== undefined
    ? Number(config.temperature) : 1.0;

  let endpoint, headers, body;
  if (provider === 'gemini') {
    endpoint = `${resolveGeminiEndpoint(url, model, stream)}?key=${encodeURIComponent(pickKey(key))}`;
    headers = { 'Content-Type': 'application/json' };
    body = { ...request, generationConfig: { temperature } };
  } else {
    endpoint = resolveOpenAIEndpoint(url);
    headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${pickKey(key)}` };
    body = { model, messages: request.messages, stream, temperature };
  }

  const response = await fetchImpl(endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    const err = new Error(`API Error: ${response.status} ${text.slice(0, 200)}`);
    err.status = response.status; err.body = text;
    throw err;
  }

  const contentType = response.headers?.get?.('content-type') || '';
  const looksStream = stream || contentType.includes('text/event-stream');
  if (looksStream && response.body && typeof response.body.getReader === 'function') {
    if (provider === 'gemini') {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let acc = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += decoder.decode(value, { stream: true });
      }
      acc += decoder.decode();
      const text = parseGeminiStreamText(acc);
      if (text && onDelta) onDelta(text);
      return { text, streamed: true };
    }
    const parser = createSSEParser({ onDelta });
    const reader = response.body.getReader();
    let full = '';
    const capture = (d) => { full += d; };
    const p2 = createSSEParser({ onDelta: (d) => { capture(d); onDelta?.(d); } });
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      p2.feed(value);
      if (p2.done) break;
    }
    p2.flush();
    void parser;
    return { text: full, streamed: true };
  }
  const text = await response.text();
  return { text: parseNonStreamText(text, provider), streamed: false };
}
