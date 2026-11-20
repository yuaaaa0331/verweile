// sse.js — 流式 SSE 解析（providerAdapter 用）。
// 按真正的 SSE 事件缓冲处理：TextDecoder 流式解码（拆开的 UTF-8 字符不错位），
// 按 \n\n 切事件，data: 行可跨 chunk、跨 JSON；[DONE] 结束；
// 未闭合的事件不提前吐内容；非流式 JSON 另有 parseNonStream 处理。

export function createSSEParser({ onDelta, onEvent } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;

  function handleEvent(rawEvent) {
    const lines = rawEvent.split('\n');
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      else if (line.startsWith(':')) { /* 注释/心跳，忽略 */ }
    }
    if (!dataLines.length) return;
    const data = dataLines.join('\n');
    if (data.trim() === '[DONE]') { done = true; onEvent?.({ type: 'done' }); return; }
    try {
      const json = JSON.parse(data);
      const delta = json?.choices?.[0]?.delta?.content
        ?? json?.choices?.[0]?.message?.content
        ?? json?.candidates?.[0]?.content?.parts?.[0]?.text
        ?? '';
      if (delta) onDelta?.(delta);
      onEvent?.({ type: 'json', json });
    } catch {
      // 跨 chunk 的 JSON 在事件未闭合前不会到这里；真解析失败则忽略该事件，不丢已有内容。
      onEvent?.({ type: 'unparsable', data });
    }
  }

  return {
    get done() { return done; },
    feed(chunk) {
      buffer += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        handleEvent(event.replace(/\r\n/g, '\n').replace(/\r/g, '\n'));
        if (done) break;
      }
    },
    flush() {
      buffer += decoder.decode();
      if (buffer.trim()) handleEvent(buffer.replace(/\r\n/g, '\n'));
      buffer = '';
    },
  };
}

/** 对一段完整响应文本做 SSE 提取（用于非流式却返回 text/event-stream 的情况）。 */
export function extractSSEText(text) {
  let out = '';
  const parser = createSSEParser({ onDelta: (d) => { out += d; } });
  parser.feed(String(text ?? ''));
  parser.flush();
  return out;
}

/** 非流式 JSON 响应取正文；返回 HTML 文本时抛错（调用方转友好提示）。 */
export function parseNonStreamText(text, provider = 'openai') {
  const t = String(text ?? '').trim();
  if (/^<!doctype html|^<html/i.test(t)) {
    const err = new Error('API返回了网页 HTML 而不是 JSON，请检查 Base URL。');
    err.status = 0; err.isHtml = true;
    throw err;
  }
  let data;
  try {
    data = JSON.parse(t);
  } catch {
    // 有的服务把 SSE 当普通响应返回
    if (t.includes('data:')) {
      const sse = extractSSEText(t);
      if (sse) return sse;
    }
    throw new Error(`API 返回了非 JSON 数据。开头：${t.slice(0, 80)}`);
  }
  if (provider === 'gemini') {
    return data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (data?.error) {
    const err = new Error(data.error.message || JSON.stringify(data.error));
    err.status = data.error.code || 0;
    throw err;
  }
  return '';
}

/** Gemini 流式：原实现把整段累积按 JSON 数组解析；保留该行为，失败则返回空并由调用方提示。 */
export function parseGeminiStreamText(text) {
  const t = String(text ?? '').trim();
  if (!t) return '';
  try {
    const arr = JSON.parse(t);
    if (Array.isArray(arr)) {
      return arr.map((item) => item?.candidates?.[0]?.content?.parts?.[0]?.text || '').join('');
    }
    return arr?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  } catch {
    return extractSSEText(t);
  }
}
