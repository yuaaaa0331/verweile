// replyParser.js — UWU/TT 文字协议解析（replyParser）。
// 兼容原 getMixedContent 的意图，但修正其“只在第一个 ] 处分割”的脆弱实现：
//  - 每种已知指令用带终止前瞻的模式匹配，正文里的普通方括号不再截断消息；
//  - 未闭合的 [ 或 <…> 不执行，当作可读纯文本保留；
//  - 无法识别的内容保留为可读文本，不丢字；
//  - 名称是变量（realName/myName 传入），中文/英文冒号、换行、多片段都处理。
// 种类：text | quote | bilingual | sticker | stickerUnknown | photo | voice |
//       status | withdraw | transfer | gift | transferResponse | giftResponse |
//       forward | html | system

export function escapeRegExp(s) {
  return String(s ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 双语解析：优先「」，回退（）。返回 {foreign, chinese} 或 null。 */
export function parseBilingual(mainText) {
  const text = String(mainText ?? '').trim();
  const lastClose = text.lastIndexOf('」');
  if (lastClose > -1) {
    const lastOpen = text.lastIndexOf('「', lastClose);
    if (lastOpen > -1) {
      const foreign = text.substring(0, lastOpen).trim();
      const chinese = text.substring(lastOpen + 1, lastClose).trim();
      if (foreign && chinese) return { foreign, chinese };
    }
  }
  const lastCloseP = Math.max(text.lastIndexOf(')'), text.lastIndexOf('）'));
  if (lastCloseP > -1) {
    const lastOpenP = Math.max(text.lastIndexOf('(', lastCloseP), text.lastIndexOf('（', lastCloseP));
    if (lastOpenP > -1) {
      const foreign = text.substring(0, lastOpenP).trim();
      const chinese = text.substring(lastOpenP + 1, lastCloseP).trim();
      if (foreign && chinese) return { foreign, chinese };
    }
  }
  return null;
}

/**
 * 逐段解析模型原始输出。返回 segments 数组，每项 { kind, content, ... }。
 * content 始终保留原始协议文本（渲染与复制用协议文本，编辑时再取正文）。
 */
export function parseReplyText(raw, character, opts = {}) {
  const realName = character?.realName || '';
  const myName = character?.myName || '';
  const rn = escapeRegExp(realName);
  const mn = escapeRegExp(myName);
  const text = String(raw ?? '');
  const segments = [];
  // 终止前瞻：指令结束后是下一个 [ / < 或字符串结尾；正文里的 ] 后若不是这些，就继续向后找。
  const END = '(?=\\s*(?:\\[|<|$))';
  const patterns = [
    { kind: 'withdraw', re: new RegExp(`^\\[(?:${rn}|${mn})撤回了一条消息[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'quote', re: new RegExp(`^\\[${rn}引用[“"]([\\s\\S]*?)["”]并回复[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'sticker', re: new RegExp(`^\\[(?:${rn}|${mn})(?:发送)?的表情包[：:]([\\s\\S]*?)\\]${END}`) },
    // 语音与照片描述：面板发出的消息用的是 myName（[朵朵的语音：…] /
    // [朵朵发来的照片/视频：…]），与 sticker 同款写法认 (realName|myName)。
    { kind: 'photo', re: new RegExp(`^\\[(?:${rn}|${mn})发来的照片\\/视频[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'voice', re: new RegExp(`^\\[(?:${rn}|${mn})的语音[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'transfer', re: new RegExp(`^\\[${rn}的转账[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'gift', re: new RegExp(`^\\[${rn}送来的礼物[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'status', re: new RegExp(`^\\[${rn}更新状态为[：:]([\\s\\S]*?)\\]${END}`) },
    { kind: 'giftResponse', re: new RegExp(`^\\[${rn}已接收礼物\\]${END}`) },
    { kind: 'transferResponse', re: new RegExp(`^\\[${rn}(?:接收|退回)${mn}的转账\\]${END}`) },
    { kind: 'text', re: new RegExp(`^\\[${rn}的消息[：:]([\\s\\S]*?)\\]${END}`) },
  ];

  let i = 0;
  const pushText = (t) => {
    const s = String(t ?? '').trim();
    if (s) segments.push({ kind: 'text', content: s, plain: true });
  };

  while (i < text.length) {
    const rest = text.slice(i);
    // 空白分隔直接跳过
    const ws = rest.match(/^\s+/);
    if (ws) { i += ws[0].length; continue; }

    // 转发块 <X转发的聊天记录>…</X转发的聊天记录>：按原 getMixedContent 的嵌套计数扫描
    if (rest[0] === '<') {
      const tagMatch = rest.match(/^<([a-zA-Z0-9\u4e00-\u9fa5_.-]+)/);
      if (tagMatch) {
        const tagName = tagMatch[1];
        let openCount = 0, searchIndex = 0, blockEnd = -1;
        while (searchIndex < rest.length) {
          const openPos = rest.indexOf('<' + tagName, searchIndex);
          const closePos = rest.indexOf('</' + tagName, searchIndex);
          if (openPos !== -1 && (closePos === -1 || openPos < closePos)) {
            openCount++; searchIndex = openPos + 1;
          } else if (closePos !== -1) {
            openCount--; searchIndex = closePos + 1;
            if (openCount === 0) { blockEnd = closePos + `</${tagName}>`.length; break; }
          } else break;
        }
        if (blockEnd !== -1) {
          const block = rest.substring(0, blockEnd);
          if (tagName.endsWith('转发的聊天记录')) {
            segments.push({ kind: 'forward', content: block });
          } else {
            // 本阶段未实现 HTML 模块：保留原始内容，显示为可读占位卡
            segments.push({ kind: 'html', content: block });
          }
          i += blockEnd;
          continue;
        }
        // 未闭合的 <…>：剩余全部当纯文本，不执行
        pushText(rest);
        break;
      }
      // 孤立的 <：当纯文本处理
      const nextSpecial = Math.min(
        ...[text.indexOf('[', i + 1), text.indexOf('<', i + 1)].filter((x) => x !== -1),
      );
      const end = Number.isFinite(nextSpecial) ? nextSpecial : text.length;
      pushText(text.slice(i, end));
      i = end;
      continue;
    }

    if (rest[0] === '[') {
      let matched = false;
      for (const p of patterns) {
        const m = rest.match(p.re);
        if (!m) continue;
        matched = true;
        const full = m[0];
        if (p.kind === 'quote') {
          segments.push({ kind: 'quote', content: full, quoted: m[1].trim(), reply: m[2].trim() });
        } else if (p.kind === 'text') {
          const inner = m[1].trim();
          const bi = character?.bilingualModeEnabled ? parseBilingual(inner) : null;
          if (bi) segments.push({ kind: 'bilingual', content: full, foreign: bi.foreign, chinese: bi.chinese });
          else segments.push({ kind: 'text', content: full, body: inner });
        } else if (p.kind === 'sticker') {
          const name = m[1].trim();
          const allowed = opts.allowedStickers || null;
          if (allowed && !allowed.includes(name)) {
            // 未知名称回退为文字，不显示坏图（相对原版静默剔除的有意修正）
            segments.push({ kind: 'stickerUnknown', content: full, name });
          } else {
            segments.push({ kind: 'sticker', content: full, name });
          }
        } else if (p.kind === 'withdraw') {
          segments.push({ kind: 'withdraw', content: full, original: m[1].trim() });
        } else {
          segments.push({ kind: p.kind, content: full, body: (m[1] ?? '').trim() });
        }
        i += full.length;
        break;
      }
      if (matched) continue;
      // [ 开头但匹配不上任何已知指令：找下一个 [ 或 <，中间全部当纯文本（不丢字）
      const next1 = text.indexOf('[', i + 1);
      const next2 = text.indexOf('<', i + 1);
      const candidates = [next1, next2].filter((x) => x !== -1);
      const end = candidates.length ? Math.min(...candidates) : text.length;
      pushText(text.slice(i, end));
      i = end;
      continue;
    }

    // 普通纯文本：直到下一个 [ 或 <
    const next1 = text.indexOf('[', i);
    const next2 = text.indexOf('<', i);
    const candidates = [next1, next2].filter((x) => x !== -1);
    const end = candidates.length ? Math.min(...candidates) : text.length;
    pushText(text.slice(i, end));
    i = end;
  }
  return segments;
}

/** 把一段解析结果转成可落库的消息对象（调用方再补 id/timestamp/roundId）。 */
export function segmentToMessage(segment, character, roundId) {
  const base = {
    role: 'assistant',
    content: segment.content,
    parts: [{ type: 'text', text: segment.content }],
    timestamp: Date.now(),
    roundId: roundId || null,
  };
  switch (segment.kind) {
    case 'quote':
      return { ...base, quote: { content: segment.quoted, messageId: null, senderId: 'user_me' }, _replyText: segment.reply };
    case 'bilingual':
      return { ...base, _foreign: segment.foreign, _chinese: segment.chinese };
    case 'sticker':
      return { ...base, stickerName: segment.name };
    case 'stickerUnknown':
      return { ...base, kind: 'text' };
    case 'photo':
      return { ...base, photoDescription: segment.body };
    case 'voice':
      return { ...base, voiceText: segment.body };
    case 'status':
      return { ...base, isStatusUpdate: true, statusText: segment.body };
    case 'withdraw':
      return { ...base, _withdrawOriginal: segment.original };
    case 'transfer':
      return { ...base, transferStatus: 'pending' };
    case 'gift':
      return { ...base, giftStatus: 'sent' };
    case 'transferResponse':
    case 'giftResponse':
      return { ...base, isContextDisabled: true, _hiddenInstruction: true };
    case 'forward':
    case 'html':
      return { ...base, _placeholderKind: segment.kind };
    default:
      return base;
  }
}

/** 渲染/导入时用的内容分类（与解析器同一套规则）。 */
export function classifyContent(content, character, opts = {}) {
  const segs = parseReplyText(content || '', character, opts);
  if (segs.length === 1) return segs[0];
  if (segs.length === 0) return { kind: 'text', content: content || '', plain: true };
  return { kind: 'mixed', content, segments: segs };
}
