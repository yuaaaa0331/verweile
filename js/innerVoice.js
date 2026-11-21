// innerVoice.js — 心声解析：从助理文本里剥离可选的 [inner_voice]…[/inner_voice] 块。
//
// 协议：模型在回复里用 [inner_voice]…[/inner_voice] 包裹 1–3 句内心独白；
// 正文（cleanContent）里绝不能残留协议标记。
//
// 重要边界（写死在本模块，不依赖调用方自觉）：
// - 本模块只处理“文本字段”（message.content / 段落文本）。它从不读取、
//   不展示 API 返回的 reasoning / thinking / reasoning_content 等字段；
//   那些字段根本不会传进本模块——调用方只把已渲染的正文文本交过来。
// - 心声是“可选的独立输出字段”，不是推理过程：解析失败时安静降级
//   （innerVoice=null），不报错、不把半截协议留在正文里。
// - 默认 1～3 句：超过 3 句截断并标记 truncated=true。

export const INNER_VOICE_OPEN = '[inner_voice]';
export const INNER_VOICE_CLOSE = '[/inner_voice]';
/** 默认保留的心声句数上限。 */
export const INNER_VOICE_MAX_SENTENCES = 3;
/** 心声字符上限（与句数上限取先到者，防模型一次吐出大段独白）。 */
export const INNER_VOICE_MAX_CHARS = 240;

/** 是否含有心声开标签（不保证闭合）。 */
export function hasInnerVoice(content) {
  return String(content ?? '').includes(INNER_VOICE_OPEN);
}

/** 按中文/英文句末标点切句，保留标点；空行不计为句。 */
export function splitSentences(text) {
  const out = [];
  const re = /[^。！？!?…\n]+[。！？!?…\n]?/g;
  for (const m of String(text ?? '').matchAll(re)) {
    const s = m[0].trim();
    if (s) out.push(s);
  }
  return out;
}

/** 把心声截到上限句数/字符数，返回 { text, truncated }。 */
export function truncateInnerVoice(text, opts = {}) {
  const maxSentences = opts.maxSentences ?? INNER_VOICE_MAX_SENTENCES;
  const maxChars = opts.maxChars ?? INNER_VOICE_MAX_CHARS;
  let sentences = splitSentences(text);
  let truncated = false;
  if (sentences.length > maxSentences) {
    sentences = sentences.slice(0, maxSentences);
    truncated = true;
  }
  let out = sentences.join('');
  // 句数够了但仍超长：按字符截断（不截半个词以外的东西，只截尾不断句中）。
  if ([...out].length > maxChars) {
    out = [...out].slice(0, maxChars).join('').trimEnd();
    truncated = true;
  }
  return { text: out, truncated };
}

/**
 * 解析助理内容里的心声块。
 * @returns { cleanContent, innerVoice, truncated }
 * - 正常：取第一个完整块，cleanContent 删掉该块（多余空行并掉），
 *   innerVoice 为截断后的文本（1～3 句）。
 * - 开标签存在但闭标签缺失：解析失败 → innerVoice=null，且把从开标签
 *   起到文末的半截协议整个从正文里删掉（绝不把协议代码留在正文里）。
 * - 只有闭标签（无开标签）：删掉孤闭标签，innerVoice=null。
 * - 块内空白：innerVoice=null，但仍删掉空块。
 * - 多个块：只取第一个，其余块同样从正文里删掉（不残留协议标记）。
 */
export function parseInnerVoice(content, opts = {}) {
  const raw = String(content ?? '');
  if (!raw.includes(INNER_VOICE_OPEN) && !raw.includes(INNER_VOICE_CLOSE)) {
    return { cleanContent: raw, innerVoice: null, truncated: false };
  }
  let clean = raw;
  let innerVoice = null;
  let truncated = false;
  const firstOpen = raw.indexOf(INNER_VOICE_OPEN);
  if (firstOpen >= 0) {
    const closeIdx = raw.indexOf(INNER_VOICE_CLOSE, firstOpen + INNER_VOICE_OPEN.length);
    if (closeIdx >= 0) {
      const body = raw.slice(firstOpen + INNER_VOICE_OPEN.length, closeIdx).trim();
      // 删掉全部心声块（第一个 + 之后残留的），正文不留协议标记。
      clean = stripAllInnerVoiceBlocks(raw);
      if (body) {
        const t = truncateInnerVoice(body, opts);
        innerVoice = t.text || null;
        truncated = t.truncated;
      }
    } else {
      // 闭标签缺失：安静降级——心声丢弃，半截块整体从正文删除。
      clean = raw.slice(0, firstOpen);
      innerVoice = null;
    }
  }
  // 孤闭标签（无开标签）也删掉。
  clean = stripAllInnerVoiceBlocks(clean);
  clean = collapseBlankLines(clean);
  return { cleanContent: clean, innerVoice, truncated };
}

/** 删掉文本里所有心声块与孤标签（完整块、半截块、孤闭标签）。 */
export function stripAllInnerVoiceBlocks(content) {
  let out = String(content ?? '');
  // 完整块（可能多个）。
  let prev;
  do {
    prev = out;
    const open = out.indexOf(INNER_VOICE_OPEN);
    if (open < 0) break;
    const close = out.indexOf(INNER_VOICE_CLOSE, open + INNER_VOICE_OPEN.length);
    if (close >= 0) out = out.slice(0, open) + out.slice(close + INNER_VOICE_CLOSE.length);
    else out = out.slice(0, open);
  } while (out !== prev);
  // 孤闭标签。
  out = out.split(INNER_VOICE_CLOSE).join('');
  return out;
}

/** 正文里连续 3 个以上换行并为最多 2 个，首尾去空白。 */
export function collapseBlankLines(text) {
  return String(text ?? '').replace(/\n{3,}/g, '\n\n').trim();
}
