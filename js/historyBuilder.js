// historyBuilder.js — 上下文组装（historyBuilder，与提示词、网络、界面分离）。
// 规则来源：chat_ai.js getAiReply + utils.js filterHistoryForAI。
// 有意修正（见 MIGRATION.md）：
//  1. 缺少 statusSnapshot 的 isStatusUpdate 消息不再被剔除，照原文序列化；
//  2. 状态栏正则不再从普通消息里剥离内容（只在请求副本上清洗 <thinking> 与双语标点）；
//  3. 所有清洗只作用于请求副本，不改写已保存的原始历史；
//  4. content 与 parts.text 二选一，绝不拼接。
import { pad, parseMaxMemory } from './utils.js';
import { HISTORY_PLACEHOLDER } from './promptBuilder.js';

const THINKING_RE = /<thinking>[\s\S]*?<\/thinking>/g;

/** 取一条消息在请求里实际可用的 parts：优先有效 parts，否则回退 content。 */
export function effectiveParts(msg) {
  if (msg?.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
    return msg.parts.filter((p) => p && (p.type === 'text' || p.type === 'html' || p.type === 'image'));
  }
  if (typeof msg?.content === 'string' && msg.content !== '') {
    return [{ type: 'text', text: msg.content }];
  }
  return [];
}

/** 消息的纯文本（用于引用匹配、撤回占位、历史文本化）。 */
export function messageText(msg) {
  const parts = effectiveParts(msg);
  return parts.filter((p) => p.type === 'text' || p.type === 'html').map((p) => p.text || '').join('');
}

/** 从 [X的消息：正文] 协议里取出正文；不是协议格式则原样返回。 */
export function extractProtocolText(content) {
  if (typeof content !== 'string') return '';
  const m = content.match(/^\[.*?的消息[：:]([\s\S]*)\]$/);
  return m ? m[1].trim() : content.trim();
}

/** 被撤回消息的可见占位：只保留占位文字，绝不把原 文重新加入上下文。 */
export function withdrawnPlaceholder(msg, character) {
  const name = msg?.role === 'user' ? (character?.myName || '我') : (character?.realName || '对方');
  const orig = msg?.originalContent
    || extractProtocolText(msg?.content || '')
    || '';
  const sep = msg?.role === 'user' ? ' ' : '';
  return `[${name}${sep}撤回了一条消息：${orig}]`;
}

function cleanTextForRequest(text, bilingual, role) {
  let t = String(text ?? '').replace(THINKING_RE, '').trim();
  if (bilingual && role === 'assistant') {
    // UWU 原 filterHistoryForAI：尾部（中文）翻译改为「中文」
    t = t.replace(/[\s\n]*[\(（]([^\)）]+)[\)）]([\s\n]*\])$/, '「$1」$2');
    t = t.replace(/[\s\n]*[\(（]([^\)）]+)[\)）]$/, '「$1」');
  }
  return t;
}

/**
 * 请求副本清洗（只处理本次请求所需的数据，不深拷贝全部历史）。
 * 输入已是 slice(-maxMemory) 的浅拷贝；这里对每条做轻量拷贝。
 * 排除：isContextDisabled、isThinking、内容以 <thinking> 开头、空消息。
 */
export function filterHistoryForRequest(character, historySlice) {
  const bilingual = !!character?.bilingualModeEnabled;
  const out = [];
  for (const raw of historySlice || []) {
    if (!raw) continue;
    if (raw.isContextDisabled || raw.isThinking) continue;
    if (typeof raw.content === 'string' && raw.content.trim().startsWith('<thinking>')) continue;
    const msg = { ...raw };
    if (msg.isWithdrawn) {
      msg.content = withdrawnPlaceholder(msg, character);
      msg.parts = [{ type: 'text', text: msg.content }];
      out.push(msg);
      continue;
    }
    const parts = effectiveParts(msg);
    const cleanedParts = [];
    for (const p of parts) {
      if (p.type === 'text' || p.type === 'html') {
        const t = cleanTextForRequest(p.text, bilingual, msg.role);
        if (t) cleanedParts.push({ type: 'text', text: t });
      } else if (p.type === 'image') {
        cleanedParts.push(p); // 图像 parts 不能丢失
      }
    }
    if (!cleanedParts.length) continue;
    msg.parts = cleanedParts;
    msg.content = cleanedParts.filter((p) => p.type === 'text').map((p) => p.text).join('');
    out.push(msg);
  }
  return out;
}

function timeMarkerPrefix(ts, lastMarker) {
  const isSameDay = new Date(ts).toDateString() === new Date(lastMarker).toDateString();
  if (lastMarker === 0 || ts - lastMarker >= 10 * 60 * 1000 || !isSameDay) {
    const d = new Date(ts);
    return `[system: ${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}]\n`;
  }
  return '';
}

/** 用户引用消息序列化：[我引用“原文”并回复：回复正文] */
export function serializeUserMessage(msg, character) {
  if (msg.role === 'user' && msg.quote) {
    const replyText = extractProtocolText(messageText(msg));
    return `[${character?.myName || '我'}引用“${msg.quote.content}”并回复：${replyText}]`;
  }
  return null;
}

/**
 * 把清洗后的历史转成 OpenAI messages（含同角色相邻合并、时间标记）。
 * 返回 { messages, lastMarker }，messages 元素为 {role, content}，
 * content 为 string 或 [{type:'text',text}|{type:'image_url',image_url:{url}}]。
 */
export function toOpenAIMessages(character, history, opts = {}) {
  const messages = [{ role: 'system', content: opts.systemPrompt || '' }];
  let lastMarker = 0;
  let lastMsgTime = 0;
  const pushOrMerge = (role, content) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && role !== 'system') {
      if (typeof last.content === 'string' && typeof content === 'string') {
        last.content += '\n' + content;
      } else {
        let lastArr = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
        let newArr = Array.isArray(content) ? content : [{ type: 'text', text: content }];
        const li = lastArr[lastArr.length - 1];
        const fi = newArr[0];
        if (li?.type === 'text' && fi?.type === 'text') {
          li.text += '\n' + fi.text;
          lastArr = lastArr.concat(newArr.slice(1));
        } else {
          if (li?.type === 'text') li.text += '\n';
          else lastArr.push({ type: 'text', text: '\n' });
          lastArr = lastArr.concat(newArr);
        }
        last.content = lastArr;
      }
    } else {
      messages.push({ role, content });
    }
  };

  for (const msg of history) {
    const prefix = timeMarkerPrefix(msg.timestamp, lastMarker);
    if (prefix) lastMarker = msg.timestamp;
    lastMsgTime = msg.timestamp;
    const quoted = serializeUserMessage(msg, character);
    if (quoted !== null) {
      pushOrMerge('user', prefix + quoted);
      continue;
    }
    const parts = effectiveParts(msg);
    if (parts.some((p) => p.type === 'image')) {
      let first = true;
      const content = parts.map((p) => {
        if (p.type === 'image') return { type: 'image_url', image_url: { url: p.data } };
        const text = first ? prefix + (p.text || '') : (p.text || '');
        first = false;
        return { type: 'text', text };
      });
      pushOrMerge(msg.role, content);
    } else {
      const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('');
      pushOrMerge(msg.role, prefix + text);
    }
  }
  return { messages, lastMarker, lastMsgTime };
}

/** Gemini contents：不合并相邻同角色，role user/model，image → inline_data。 */
export function toGeminiContents(character, history, opts = {}) {
  const contents = [];
  let lastMarker = 0;
  let lastMsgTime = 0;
  for (const msg of history) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    let prefix = timeMarkerPrefix(msg.timestamp, lastMarker);
    if (prefix) lastMarker = msg.timestamp;
    if (opts.timePerceptionEnabled && lastMsgTime !== 0 && msg.timestamp - lastMsgTime > 30 * 60 * 1000) {
      const { formatTimeGap } = opts;
      prefix += `[system: 距离上次互动已过去 ${formatTimeGap ? formatTimeGap(msg.timestamp - lastMsgTime) : ''}。话题可能已中断，请自然地开启新话题或对时间流逝做出反应。]\n`;
    }
    lastMsgTime = msg.timestamp;
    const quoted = serializeUserMessage(msg, character);
    let parts;
    if (quoted !== null) {
      parts = [{ text: prefix + quoted }];
    } else {
      const ep = effectiveParts(msg);
      parts = ep.map((p) => {
        if (p.type === 'image') {
          const m = String(p.data || '').match(/^data:(image\/(.+));base64,(.*)$/);
          return m ? { inline_data: { mime_type: m[1], data: m[3] } } : null;
        }
        return { text: p.text || '' };
      }).filter(Boolean);
      if (prefix && parts.length > 0 && parts[0].text !== undefined) parts[0].text = prefix + parts[0].text;
      else if (prefix) parts.unshift({ text: prefix });
    }
    if (parts.length) contents.push({ role, parts });
  }
  return { contents, lastMarker };
}

/** 找到最新一轮用户消息在数组中的起止下标（连续的 user 角色段）。 */
export function latestUserRoundRange(items, roleOf) {
  let end = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (roleOf(items[i]) === 'user') { end = i; break; }
  }
  if (end === -1) return null;
  let start = end;
  while (start > 0 && roleOf(items[start - 1]) === 'user') start--;
  return { start, end };
}

function wrapUserInputOpenAI(msg) {
  if (typeof msg.content === 'string') {
    msg.content = `<user_input>\n${msg.content}\n</user_input>`;
  } else if (Array.isArray(msg.content)) {
    msg.content.unshift({ type: 'text', text: '<user_input>\n' });
    msg.content.push({ type: 'text', text: '\n</user_input>' });
  }
}

function wrapUserInputGemini(content, which = 'both') {
  const parts = content.parts;
  if ((which === 'both' || which === 'open') && parts.length > 0 && parts[0].text !== undefined) parts[0].text = `<user_input>\n${parts[0].text}`;
  else if (which === 'open' || which === 'both') parts.unshift({ text: `<user_input>\n` });
  if ((which === 'both' || which === 'close') && parts.length > 0 && parts[parts.length - 1].text !== undefined) parts[parts.length - 1].text += `\n</user_input>`;
  else if (which === 'close' || which === 'both') parts.push({ text: `\n</user_input>` });
}

function historyTextOpenAI(messages, character, from, to) {
  let t = '<chat_history>\n';
  for (let i = from; i < to; i++) {
    const msg = messages[i];
    const roleName = msg.role === 'assistant' ? character?.realName : character?.myName;
    const text = typeof msg.content === 'string'
      ? msg.content
      : (Array.isArray(msg.content) ? msg.content.map((p) => p.text || '').join('') : '');
    t += `${roleName}: ${text}\n`;
  }
  return t + '</chat_history>';
}

function historyTextGemini(contents, character, from, to) {
  let t = '<chat_history>\n';
  for (let i = from; i < to; i++) {
    const c = contents[i];
    const roleName = c.role === 'model' ? character?.realName : character?.myName;
    t += `${roleName}: ${c.parts.map((p) => p.text || '').join('')}\n`;
  }
  return t + '</chat_history>';
}

/**
 * 组装一次请求的完整内容（OpenAI 兼容 / Gemini 两路）。
 * 输入：character、fullHistory（全部历史，只取尾部 maxMemory 条处理）、systemPromptResult。
 * 输出：{ provider, body, systemPrompt, stats }。body 与“本次发送内容预览”用同一份结果。
 * stats：historyMessages（进入请求的历史条数）、userInputRounds、chatHistoryChars、
 *   mergedMessages、droppedContextDisabled、placeholdersUsed 等，供预览与自检使用。
 */
export function buildRequest(character, fullHistory, systemPromptResult, opts = {}) {
  const provider = opts.provider || 'openai';
  const maxMemory = parseMaxMemory(character?.maxMemory, 80);
  const slice = (fullHistory || []).slice(-maxMemory);
  const droppedContextDisabled = slice.filter((m) => m?.isContextDisabled).length;
  const history = filterHistoryForRequest(character, slice);
  const hasPlaceholder = !!systemPromptResult.hasHistoryPlaceholder;
  let systemPrompt = systemPromptResult.systemPrompt;
  const stats = {
    maxMemory, sliced: slice.length, historyMessages: history.length,
    droppedContextDisabled, mergedMessages: 0, userInputCount: 0,
    chatHistoryUsed: false, chatHistoryChars: 0, timeMarkers: 0,
  };

  if (provider === 'gemini') {
    const { contents } = toGeminiContents(character, history, opts);
    const range = latestUserRoundRange(contents, (c) => c.role);
    if (range) {
      if (range.start === range.end) wrapUserInputGemini(contents[range.start], 'both');
      else { wrapUserInputGemini(contents[range.start], 'open'); wrapUserInputGemini(contents[range.end], 'close'); }
      stats.userInputCount = range.end - range.start + 1;
    }
    let finalContents = contents;
    if (hasPlaceholder) {
      const endIndex = range ? range.start : contents.length;
      if (endIndex === 0) {
        systemPrompt = systemPrompt.replace(HISTORY_PLACEHOLDER, '');
        finalContents = range ? contents.slice(range.start) : [];
      } else {
      const ht = historyTextGemini(contents, character, 0, endIndex);
      stats.chatHistoryUsed = true;
      stats.chatHistoryChars = ht.length;
      systemPrompt = systemPrompt.replace(HISTORY_PLACEHOLDER, ht);
      finalContents = range ? contents.slice(range.start) : [];
      }
    } else {
      systemPrompt += '\n\n以下为当前聊天记录：\n';
    }
    if (history.length > 0 && history[history.length - 1].role === 'assistant') {
      finalContents.push({ role: 'user', parts: [{ text: `[系统通知：我暂未回复，${character?.realName}再次主动发送了消息]` }] });
    }
    return {
      provider, systemPrompt,
      body: { contents: finalContents, system_instruction: { parts: [{ text: systemPrompt }] } },
      stats,
    };
  }

  // OpenAI 兼容分支
  const { messages } = toOpenAIMessages(character, history, { systemPrompt });
  stats.mergedMessages = Math.max(0, history.length - (messages.length - 1));
  const range = latestUserRoundRange(messages.slice(1), (m) => m.role);
  const absRange = range ? { start: range.start + 1, end: range.end + 1 } : null;
  if (absRange) {
    wrapUserInputOpenAI(messages[absRange.end]);
    // 最新一轮可能有多条 user 消息（合并后通常为 1 条）；wrap 只包最后一合并条，
    // 与 UWU 原实现一致：它只包 messages 数组里最后一条 user 消息。
    stats.userInputCount = 1;
  }
  let finalMessages = messages;
  if (hasPlaceholder) {
    const endIndex = absRange ? absRange.start : messages.length;
    if (endIndex <= 1) {
      messages[0].content = messages[0].content.replace(HISTORY_PLACEHOLDER, '');
      finalMessages = absRange ? [messages[0], ...messages.slice(absRange.start)] : [messages[0]];
    } else {
    const ht = historyTextOpenAI(messages, character, 1, endIndex);
    stats.chatHistoryUsed = true;
    stats.chatHistoryChars = ht.length;
    messages[0].content = messages[0].content.replace(HISTORY_PLACEHOLDER, ht);
    if (absRange) finalMessages = [messages[0], ...messages.slice(absRange.start)];
    else finalMessages = [messages[0]];
    }
  } else {
    messages[0].content += '\n\n以下为当前聊天记录：\n';
  }
  if (history.length > 0 && history[history.length - 1].role === 'assistant') {
    const last = finalMessages[finalMessages.length - 1];
    const note = `[系统通知：我暂未回复，${character?.realName}再次主动发送了消息]`;
    if (last && last.role === 'user') {
      if (typeof last.content === 'string') last.content += '\n' + note;
      else last.content.push({ type: 'text', text: '\n' + note });
    } else {
      finalMessages.push({ role: 'user', content: note });
    }
  }
  return { provider, systemPrompt: finalMessages[0]?.content || systemPrompt, body: { messages: finalMessages }, stats };
}
