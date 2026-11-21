// 引用定位：ID 优先；旧记录只接受当前角色、时间在引用之前、唯一的原文匹配。
// 不把相同文案当成相同消息，不跨角色跳转，不在缺失 ID 时偷偷跳到别的记录。
export function normalizeQuoteReference(value = {}) {
  const q = value && typeof value === 'object' ? value : { content:String(value || '') };
  return {
    messageId: q.messageId ?? q.originalMessageId ?? q.targetId ?? null,
    senderId: q.senderId ?? q.role ?? null,
    content: String(q.content ?? q.text ?? ''),
    senderName: String(q.senderName ?? q.name ?? ''),
  };
}

export function matchQuoteSource(quote, messages, { charId, sourceMessage, getText = m => m.content || '' } = {}) {
  const ref = normalizeQuoteReference(quote);
  const available = (messages || []).filter(m => m && m.charId === charId && m.id !== sourceMessage?.id
    && (!Number.isFinite(sourceMessage?.timestamp) || !Number.isFinite(m.timestamp) || m.timestamp <= sourceMessage.timestamp));
  if (ref.messageId != null) {
    const target = available.find(m => String(m.id) === String(ref.messageId));
    return target ? { ok:true, target, matchedBy:'id' } : { ok:false, reason:'missing' };
  }
  const normalize = text => String(text || '').replace(/\s+/g, ' ').trim();
  const text = normalize(ref.content);
  if (!text) return { ok:false, reason:'missing' };
  const role = ref.senderId === 'user_me' || ref.senderId === 'user' ? 'user'
    : ref.senderId === 'assistant' ? 'assistant' : null;
  const hits = available.filter(m => (!role || m.role === role) && normalize(getText(m)) === text);
  if (hits.length === 1) return { ok:true, target:hits[0], matchedBy:'text' };
  return { ok:false, reason:hits.length > 1 ? 'ambiguous' : 'missing' };
}

export async function resolveQuoteSource({ backend, charId, quote, sourceMessage, getText }) {
  const ref = normalizeQuoteReference(quote);
  // An explicit stale ID stays missing. Never silently fall back to a different same-text message.
  const messages = ref.messageId != null
    ? [await backend.get('messages', ref.messageId)].filter(Boolean)
    : await backend.getAllMessages(charId);
  const result = matchQuoteSource(ref, messages, { charId, sourceMessage, getText });
  if (result.ok && (result.target.isWithdrawn || result.target.isDeleted)) return { ok:false, reason:'withdrawn' };
  return result;
}

// UI supplies showTarget so navigation can render a bounded historical page around the original.
export async function followQuoteReference(options) {
  const result = await resolveQuoteSource(options);
  if (!result.ok) return result;
  const shown = await options.showTarget(result.target);
  return shown === false ? { ok:false, reason:'hidden' } : result;
}
