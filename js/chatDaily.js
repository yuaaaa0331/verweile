// chatDaily.js — 日常体验纯逻辑：草稿、阅读位置、发送失败重试、生成状态恢复。
//
// 本模块不碰 DOM、不 import app.js、不读写 IndexedDB；持久化由调用方
// 传入一个类 localStorage 的 storage（{ getItem, setItem, removeItem }），
// 集成时 app.js 传入 localStorage 即可。所有函数都是纯函数或只通过
// 传入的 storage 读写，便于 Node 测试。

/** 草稿：按角色保存。 */
export function draftKey(charId) {
  return `uwu-chat.draft.${charId}`;
}

/** 立即保存草稿；空文本则清除（不留空串占位）。返回保存后的文本（'' 表示已清除）。 */
export function saveDraft(storage, charId, text) {
  if (!storage || !charId) return '';
  const t = String(text ?? '');
  if (t.trim() === '') {
    storage.removeItem?.(draftKey(charId));
    return '';
  }
  storage.setItem?.(draftKey(charId), t);
  return t;
}

/** 读草稿（没有返回 ''）。 */
export function loadDraft(storage, charId) {
  if (!storage || !charId) return '';
  return String(storage.getItem?.(draftKey(charId)) ?? '');
}

/** 发送成功后清除草稿。 */
export function clearDraft(storage, charId) {
  if (!storage || !charId) return;
  storage.removeItem?.(draftKey(charId));
}

/**
 * 防抖草稿保存器：输入时 schedule(text)，停稳 debounceMs 后才写 storage；
 * 切页/发送前调 flush() 立即落盘；cancel() 丢弃未落盘的输入。
 * （storage 仍由调用方传入；定时器用全局 setTimeout，便于测试注入小间隔。）
 */
export function createDraftSaver(storage, charId, opts = {}) {
  const debounceMs = opts.debounceMs ?? 300;
  let timer = null;
  let pending = null;
  let hasPending = false;
  return {
    schedule(text) {
      pending = String(text ?? '');
      hasPending = true;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        hasPending = false;
        saveDraft(storage, charId, pending);
      }, debounceMs);
    },
    flush() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      if (hasPending) {
        hasPending = false;
        saveDraft(storage, charId, pending);
      }
    },
    cancel() {
      if (timer !== null) { clearTimeout(timer); timer = null; }
      hasPending = false;
      pending = null;
    },
    get pending() { return hasPending; },
  };
}

/** 阅读位置：按角色保存。 */
export function readingPositionKey(charId) {
  return `uwu-chat.readpos.${charId}`;
}

/**
 * 保存阅读位置：最后可见消息 id + 距底偏移（px）。
 * 距底偏移 = scrollHeight - scrollTop - clientHeight，刷新/切回后用它还原视口。
 */
export function saveReadingPosition(storage, charId, pos) {
  if (!storage || !charId || !pos) return null;
  const value = {
    lastVisibleMessageId: pos.lastVisibleMessageId ?? null,
    distanceFromBottom: Math.max(0, Math.floor(pos.distanceFromBottom ?? 0)),
    savedAt: Date.now(),
  };
  storage.setItem?.(readingPositionKey(charId), JSON.stringify(value));
  return value;
}

/** 读阅读位置（没有/损坏返回 null）。 */
export function loadReadingPosition(storage, charId) {
  if (!storage || !charId) return null;
  try {
    const raw = storage.getItem?.(readingPositionKey(charId));
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object') return null;
    return {
      lastVisibleMessageId: v.lastVisibleMessageId ?? null,
      distanceFromBottom: Number.isFinite(v.distanceFromBottom) ? v.distanceFromBottom : 0,
      savedAt: v.savedAt ?? 0,
    };
  } catch {
    return null;
  }
}

/**
 * 新消息到达时的拉底判定（核心日常体验规则）。
 * @param {Object} state { distanceFromBottom } 当前距底偏移（px）
 * @param {number} threshold 距底多少 px 内算“贴在底部”（默认 48）
 * @returns { shouldStickToBottom, showNewMessagesPill }
 * - 用户贴在底部（或就是底部）→ 跟随拉底，不显示“新消息” pill。
 * - 用户上翻了（距底超过阈值）→ 不强制拉到底，显示“新消息 ↓” pill，点 pill 再拉底。
 */
export function decideNewMessageDisplay(state = {}, threshold = 48) {
  const distance = Math.max(0, Number(state.distanceFromBottom) || 0);
  const nearBottom = distance <= threshold;
  return {
    shouldStickToBottom: nearBottom,
    showNewMessagesPill: !nearBottom,
  };
}

/** 距底偏移换算：scrollHeight/scrollTop/clientHeight → px（钳制 ≥ 0）。 */
export function distanceFromBottom(scrollState = {}) {
  const { scrollHeight = 0, scrollTop = 0, clientHeight = 0 } = scrollState;
  return Math.max(0, scrollHeight - scrollTop - clientHeight);
}

/** 发送状态：消息对象上的 sendState 字段（'sending' | 'sent' | 'failed' | 'interrupted'）。 */
export function isFailed(msg = {}) {
  return msg.sendState === 'failed';
}

export function canRetry(msg = {}) {
  return isFailed(msg) && typeof msg.id === 'string' && msg.id !== '';
}

/** 标记发送失败：返回新对象（不改原对象），保留 id / 内容 / 时间戳。 */
export function markFailed(msg = {}, error = null) {
  return {
    ...msg,
    sendState: 'failed',
    sendError: error ? String(error) : (msg.sendError ?? null),
    failedAt: Date.now(),
  };
}

/**
 * 重试失败消息：复用同一个 messageId（不产生重复记录），状态回到 sending，
 * 清掉失败标记。调用方随后用同一 id 写回 IndexedDB（put 而非 add）。
 */
export function retryMessage(msg = {}) {
  if (!canRetry(msg)) return null;
  const { sendError: _e, failedAt: _f, ...rest } = msg;
  return { ...rest, sendState: 'sending' };
}

/**
 * 生成状态恢复（刷新/重进后调用）：把残留的 generating 标为 interrupted。
 * @param {Array} messages 消息数组；生成中的消息以 sendState==='generating'
 *   或 generating===true 标记（两种写法都认，因为旧数据两种都可能有）。
 * @returns { messages, wasGenerating }
 * - wasGenerating：恢复前是否真有生成中的消息（供调用方决定是否提示“上次生成已中断”）。
 * - 恢复后绝不自动续生成：调用方不要因此再调 getReply()；用户要点“获取回复”才重新生成。
 */
export function recoverInterruptedMessages(messages = []) {
  let wasGenerating = false;
  const out = (Array.isArray(messages) ? messages : []).map((m) => {
    const generating = m && (m.sendState === 'generating' || m.generating === true);
    if (!generating) return m;
    wasGenerating = true;
    const { generating: _g, ...rest } = m;
    return { ...rest, sendState: 'interrupted', interruptedAt: Date.now() };
  });
  return { messages: out, wasGenerating };
}

/** 刷新后是否应自动续生成：永远 false（不假装还在生成、不重复生成）。 */
export function shouldResumeGeneration() {
  return false;
}

/** 同组消息的最大间隔（ms）：与 app.js 渲染里的连续判定一致（10 分钟）。 */
export const GROUP_GAP_MS = 10 * 60 * 1000;

/**
 * 组末判定（iMessage 尾巴规则的纯函数版，与 .continuous 方向相反）：
 * continuous 标“非首条”，这里标“组内最后一条”。一条消息是组末，当且仅当
 * 下一条不存在、角色不同、间隔 >= 10 分钟或跨天。app.js 的 renderMessages /
 * appendMessageElement 与测试共用这一份判定，不各自另写。
 */
export function groupLastFlags(messages = []) {
  const list = Array.isArray(messages) ? messages : [];
  return list.map((m, i) => {
    const next = list[i + 1];
    if (!next) return true;
    if (next.role !== m.role) return true;
    if (Number.isFinite(next.timestamp) && Number.isFinite(m.timestamp)) {
      if (next.timestamp - m.timestamp >= GROUP_GAP_MS) return true;
      if (new Date(next.timestamp).toDateString() !== new Date(m.timestamp).toDateString()) return true;
    }
    return false;
  });
}
