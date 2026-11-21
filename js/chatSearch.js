// chatSearch.js — 聊天记录中心：数据层（A 组）。
// 纯函数 + backend 注入，不 import app.js；聊天搜索不建倒排索引，
// 用 backend.getMessagesPage 按 byChar 索引分批扫 + 文本匹配。
// 中文分词复用 js/keywordSearch.js 的 tokenize（CJK bigram + 全词），
// 只用来辅助定位命中位置，是否命中以子串匹配为准（单字中文也能命中）。
// 每次调用都重新扫库，不做跨调用的结果缓存（编辑/删除后重查即更新）。
import { tokenize } from './keywordSearch.js';

/** 搜索每批扫的消息条数（getMessagesPage 一次取的上限）。 */
export const SEARCH_BATCH_SIZE = 100;
/** 收藏列表每批扫的消息条数。 */
export const FAVORITES_BATCH_SIZE = 100;
/** 日期枚举每批扫的消息条数。 */
export const CHAT_DATES_BATCH_SIZE = 200;

/** 被撤回消息的可见占位文本（界面显示“你撤回了一则讯息”，原文不参与搜索）。 */
export const WITHDRAWN_PLACEHOLDER = '你撤回了一则讯息';

/** snippet 命中前后各截的字数；无关键词时 snippet 取正文前 80 字。 */
export const SNIPPET_CONTEXT = 40;
export const SNIPPET_HEAD = 80;

// ---------- 发送者 / 类型归一化 ----------

/** role/sender 归一化为 'me' | 'ai'。消息记录以 role 为主（user/assistant），sender 字段为辅。 */
export function normalizeSender(msg) {
  const s = String(msg?.sender || '').toLowerCase();
  if (s === 'me' || s === 'user' || s === 'user_me') return 'me';
  if (s === 'ai' || s === 'assistant' || s === 'model') return 'ai';
  return msg?.role === 'user' ? 'me' : 'ai';
}

const KIND_ALIASES = {
  photo: 'image',
  stickerunknown: 'sticker',
  withdraw: 'text',
  bilingual: 'text',
  mixed: 'text',
  html: 'status',
  forward: 'text',
  transferresponse: 'transfer',
  giftresponse: 'gift',
};

/** 内容里的协议壳（不需要角色名即可判定，供 kind 推断与文本抽取共用）。 */
const PROTOCOL_RE = {
  sticker: /的表情包[：:]/,
  photo: /发来的照片\/视频[：:]/,
  voice: /的语音[：:]/,
  transfer: /的转账[：:]/,
  gift: /送来的礼物[：:]/,
  status: /更新状态为[：:]/,
  giftResponse: /已接收礼物/,
  transferResponse: /(?:接收|退回).{0,20}的转账/,
  quote: /引用["“][\s\S]*?["”]并回复[：:]/,
  withdraw: /撤回了一条消息[：:]/,
  message: /的消息[：:]/,
};

/**
 * kind 归一化：优先用记录自带的 kind / parsedKind（parsedKind 在现有源码里
 * 尚未出现，仍按契约当作候补字段支持）；没有时按 parts 与协议内容推断；
 * photo 统一成 image，withdraw / bilingual / mixed 统一成 text。
 */
export function normalizeKind(msg) {
  if (!msg || typeof msg !== 'object') return 'text';
  const raw = msg.kind ?? msg.parsedKind;
  if (typeof raw === 'string' && raw.trim()) {
    const key = raw.trim().toLowerCase();
    return KIND_ALIASES[key] || raw.trim();
  }
  if (msg.isWithdrawn) return 'text'; // 可见的只是撤回占位文本
  if (msg.isStatusUpdate) return 'status';
  const parts = Array.isArray(msg.parts) ? msg.parts : [];
  if (parts.some((p) => p?.type === 'image')) return 'image';
  const content = typeof msg.content === 'string' ? msg.content : '';
  if (PROTOCOL_RE.sticker.test(content)) return 'sticker';
  if (PROTOCOL_RE.photo.test(content)) return 'image';
  if (PROTOCOL_RE.voice.test(content)) return 'voice';
  if (PROTOCOL_RE.transfer.test(content) || PROTOCOL_RE.transferResponse.test(content)) return 'transfer';
  if (PROTOCOL_RE.gift.test(content) || PROTOCOL_RE.giftResponse.test(content)) return 'gift';
  if (PROTOCOL_RE.status.test(content)) return 'status';
  if (PROTOCOL_RE.quote.test(content) || msg.quote) return 'quote';
  return 'text';
}

// ---------- 可搜索纯文本 ----------

/** 去掉 data: URI（base64 图片数据绝不进搜索文本）。 */
const DATA_URI_RE = /data:[a-zA-Z]+\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;
/** 非文本协议段：表情包 / 照片 / 语音 / 转账 / 礼物 / 状态更新，整段剔除。 */
const NON_TEXT_PROTOCOL_RE = /\[[^\]\n]*?(?:的表情包|发来的照片\/视频|的语音|的转账|送来的礼物|更新状态为)[：:][^\]\n]*?\]/g;
const RECEIPT_PROTOCOL_RE = /\[[^\]\n]*?(?:已接收礼物|接收[^\]\n]*?的转账|退回[^\]\n]*?的转账)\]/g;
/** 引用协议只留回复正文；普通消息协议只留冒号后的正文。 */
const QUOTE_PROTOCOL_RE = /\[[^\]\n]*?引用["“][\s\S]*?["”]并回复[：:]([\s\S]*?)\]/g;
const MESSAGE_PROTOCOL_RE = /\[[^\]\n]*?的消息[：:]([\s\S]*?)\]/g;

/**
 * 从一条消息记录抽可搜索纯文本。
 * 只取文本类内容（parts[].text / content）；排除 base64 图片数据、HTML/CSS
 * 状态模板、系统提示词、<thinking> 推理内容、协议壳本身；被撤回消息只按
 * 可见占位文本算（原文存在 originalContent / content 里也不算）。
 * 无文本的消息返回 ''，这类消息只能靠类型/日期筛选命中，不能靠关键词命中。
 */
export function getMessageText(msg) {
  if (!msg || typeof msg !== 'object') return '';
  if (msg.isWithdrawn) return WITHDRAWN_PLACEHOLDER;
  if (msg.isStatusUpdate || msg.isThinking) return '';
  let raw = '';
  if (Array.isArray(msg.parts) && msg.parts.length) {
    // 只取 type==='text' 的 parts：image part 的 base64、html part 的状态模板都不取。
    raw = msg.parts
      .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text).join('');
  }
  if (!raw && typeof msg.content === 'string') raw = msg.content;
  if (!raw) return '';
  let t = String(raw);
  t = t.replace(DATA_URI_RE, '');
  t = t.replace(/<thinking>[\s\S]*?<\/thinking>/gi, ''); // 推理内容不参与搜索
  t = t.replace(/\[\/?inner_voice\]/gi, ''); // 只去标签本身，心声正文保留
  t = t.replace(/\[system:[^\]\n]*\]/gi, ''); // 系统提示词不参与搜索
  const trimmed = t.trim();
  // 无 isWithdrawn 标记、但内容本身就是撤回协议的旧数据：同样只按占位算。
  if (/^\[[^\]\n]*?撤回了一条消息[：:][\s\S]*\]$/.test(trimmed)) return WITHDRAWN_PLACEHOLDER;
  t = t.replace(NON_TEXT_PROTOCOL_RE, '');
  t = t.replace(RECEIPT_PROTOCOL_RE, '');
  t = t.replace(QUOTE_PROTOCOL_RE, '$1');
  t = t.replace(MESSAGE_PROTOCOL_RE, '$1');
  const tt = t.trim();
  // 整段就是 HTML 文档/状态模板（<div>/<style>/<html> 开头且含闭合标签）：不算文本。
  if (/^<(?:html|div|style|span|template)\b/i.test(tt) && /<\/[a-zA-Z][^<>]*>/.test(tt)) return '';
  t = t.replace(/<\/?[a-zA-Z][^<>\n]{0,80}>/g, ''); // 残留的 HTML 标签碎片
  return t.replace(/\s+/g, ' ').trim();
}

// ---------- 关键词命中位置 ----------

function allOccurrences(lowerText, lowerNeedle) {
  const out = [];
  if (!lowerNeedle) return out;
  let i = 0;
  for (;;) {
    const j = lowerText.indexOf(lowerNeedle, i);
    if (j === -1) return out;
    out.push([j, j + lowerNeedle.length]);
    i = j + Math.max(1, lowerNeedle.length);
  }
}

/** 去掉被别的 term 包含的子 term（全词串留，bigram 去），只留“最大词”。 */
function maximalTerms(terms) {
  const uniq = [...new Set((terms || []).filter((t) => typeof t === 'string' && t.length >= 2))];
  return uniq.filter((t) => !uniq.some((u) => u !== t && u.includes(t)));
}

function mergeRanges(ranges) {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out = [];
  for (const [s, e] of sorted) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * 关键词在文本中的命中区间（相对文本本身的 [start, end) 字符偏移）。
 * 命中规则：① 原关键词子串（英文大小写不敏感，中文子串，单字也命中）；
 * ② 原子串没命中时，tokenize 的全部“最大词”都出现才算命中（多词 AND，
 * 如“海边 日落”；bigram 不单独算命中，避免“我们”这类词误召回）。
 * 返回 [] 表示不命中。
 */
export function findKeywordRanges(text, keyword) {
  const t = String(text || '');
  const kw = String(keyword ?? '').trim();
  if (!t || !kw) return [];
  const lower = t.toLowerCase();
  const lowerKw = kw.toLowerCase();
  const raw = allOccurrences(lower, lowerKw);
  if (raw.length) {
    // 原子串命中：再把 token 命中位置并进来，方便高亮覆盖分词切出的词。
    return mergeRanges([...raw, ...tokenize(kw).flatMap((term) => allOccurrences(lower, term.toLowerCase()))]);
  }
  const terms = maximalTerms(tokenize(kw));
  if (!terms.length) return [];
  if (!terms.every((term) => lower.includes(term.toLowerCase()))) return [];
  return mergeRanges(terms.flatMap((term) => allOccurrences(lower, term.toLowerCase())));
}

/** 按第一处命中前后各截约 40 字；无命中区间时取正文前 80 字。matchRanges 相对 snippet。 */
export function buildSnippet(text, ranges) {
  const t = String(text || '');
  if (!ranges?.length) return { snippet: t.slice(0, SNIPPET_HEAD), matchRanges: [] };
  const first = ranges[0];
  const start = Math.max(0, first[0] - SNIPPET_CONTEXT);
  const end = Math.min(t.length, first[1] + SNIPPET_CONTEXT);
  const snippet = t.slice(start, end);
  const matchRanges = ranges
    .map(([s, e]) => [Math.max(s, start) - start, Math.min(e, end) - start])
    .filter(([s, e]) => e > s);
  return { snippet, matchRanges };
}

// ---------- 过滤器（纯函数） ----------

/**
 * 纯函数：一条消息是否命中 filters。
 * filters = { keyword, sender, dateFrom, dateTo, types }。
 * sender 为 'me' | 'ai' | 'all'（'all'/空 = 不筛选）；dateFrom/dateTo 为
 * 时间戳（含端点）；types 为 kind 数组（空 = 全部）。
 */
export function messageMatchesFilters(msg, filters = {}) {
  if (!msg || typeof msg !== 'object') return false;
  const f = filters || {};
  const ts = Number(msg.timestamp);
  if (f.dateFrom != null && !(ts >= f.dateFrom)) return false;
  if (f.dateTo != null && !(ts <= f.dateTo)) return false;
  if (f.sender && f.sender !== 'all' && normalizeSender(msg) !== f.sender) return false;
  if (Array.isArray(f.types) && f.types.length && !f.types.includes(normalizeKind(msg))) return false;
  if (typeof f.keyword === 'string' && f.keyword.trim() !== '') {
    if (!findKeywordRanges(getMessageText(msg), f.keyword).length) return false;
  }
  return true;
}

function toResult(msg, charId, keyword) {
  const text = getMessageText(msg);
  const { snippet, matchRanges } = typeof keyword === 'string' && keyword.trim() !== ''
    ? buildSnippet(text, findKeywordRanges(text, keyword))
    : { snippet: text.slice(0, SNIPPET_HEAD), matchRanges: [] };
  return {
    id: msg.id,
    charId: msg.charId || charId,
    timestamp: msg.timestamp,
    sender: normalizeSender(msg),
    kind: normalizeKind(msg),
    snippet,
    matchRanges,
  };
}

// ---------- 分批扫描器 ----------
// 用 backend.getMessagesPage（两后端都有）按 byChar 索引倒序分批扫。
// 游标是 opaque 字符串：JSON { v:1, before, overlap }，before = 下次取的
// 时间戳上界（boundaryTs + 1），overlap = 已扫过的、时间戳等于 boundaryTs
// 的消息条数（同一毫秒的多条消息靠它不断不漏；调用方原样回传即可）。
// MemoryBackend 同 id 多次 put 会在 msgOrder 留重复行：扫描器按 id 去重，
// 若一页全是重复行就加大 limit 重取，直到露出新行或取尽。

function decodeCursor(cursor) {
  if (cursor == null || cursor === '') return { before: Infinity, overlap: 0 };
  let obj;
  try { obj = JSON.parse(String(cursor)); } catch { throw new Error('无效的聊天搜索游标。'); }
  if (!obj || obj.v !== 1
    || !(obj.before === null || Number.isFinite(obj.before))
    || !Number.isInteger(obj.overlap) || obj.overlap < 0) {
    throw new Error('无效的聊天搜索游标。');
  }
  return { before: obj.before === null ? Infinity : obj.before, overlap: obj.overlap };
}

/**
 * 新建一个倒序（时间新 → 旧，(timestamp, id) 排序）扫描器。
 * next() 每次吐一条消息（已按 id 去重），扫完返回 null；
 * cursor() 返回当前可原样回传的游标，扫完返回 null。
 * batchSize 是每次向 backend 取的页大小（不含 overlap 补偿）。
 * 后端若没有 getMessagesPage，退化为 getAllMessages 一次读入本角色消息、
 * 内存内分页（两现有后端都有 getMessagesPage，此分支只是兜底）。
 */
export function createChatScanner(backend, charId, batchSize = SEARCH_BATCH_SIZE, cursor = null) {
  if (!backend) throw new Error('聊天扫描需要 backend。');
  if (!charId) throw new Error('聊天扫描需要 charId。');
  const size = Math.max(1, Math.floor(batchSize) || SEARCH_BATCH_SIZE);
  const start = decodeCursor(cursor);
  // 已吐出的最后一条消息的时间戳（null = 还没吐出任何一条）；countAtBoundary
  // 是已吐出的、时间戳等于 boundaryTs 的条数（即该毫秒里已扫的最大 id 之前缀）。
  let boundaryTs = start.before === Infinity ? null : start.before - 1;
  let countAtBoundary = start.overlap;
  let buffer = []; // 倒序、未吐出的本批消息
  let exhausted = false;
  const seenIds = new Set();
  let fallbackRows = null; // 兜底分支：本角色消息全量（倒序、按 id 去重后）
  let fallbackIdx = 0;
  let fallbackResumed = false;

  function cursorString() {
    if (exhausted && buffer.length === 0) return null;
    if (boundaryTs === null) return cursor ?? null;
    return JSON.stringify({ v: 1, before: boundaryTs + 1, overlap: countAtBoundary });
  }

  function computeFresh(rows) {
    let drop = null;
    if (boundaryTs !== null && countAtBoundary > 0) {
      // 该毫秒里已扫的 overlap 条是 id 最大的那几条：按 id 倒序取前 overlap 个。
      const ids = [...new Set(rows.filter((r) => r && r.timestamp === boundaryTs).map((r) => r.id))]
        .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
      drop = new Set(ids.slice(0, countAtBoundary));
    }
    const fresh = [];
    let seenRowCount = 0;
    const inPage = new Set(); // 同一页里同 id 的重复行（MemoryBackend 多次 put 留下的）只留一条
    for (const r of rows) {
      if (!r || r.id == null || inPage.has(r.id) || (drop && drop.has(r.id)) || seenIds.has(r.id)) { seenRowCount++; continue; }
      inPage.add(r.id);
      fresh.push(r);
    }
    return { fresh, seenRowCount };
  }

  async function fetchBatch() {
    if (exhausted) return;
    if (typeof backend.getMessagesPage === 'function') {
      let limit = size + countAtBoundary;
      for (;;) {
        const before = boundaryTs === null ? Infinity : boundaryTs + 1;
        const res = await backend.getMessagesPage(charId, { before, limit });
        const rows = Array.isArray(res?.messages) ? res.messages : [];
        const hasMore = !!res?.hasMore;
        const { fresh, seenRowCount } = computeFresh(rows);
        if (fresh.length > 0 || !hasMore || rows.length === 0) {
          for (const m of fresh) seenIds.add(m.id);
          buffer = fresh.slice().reverse(); // 后端返回正序，扫描器倒序吐出
          if (!hasMore) exhausted = true;
          return;
        }
        // 一页全是已扫过的重复行：加大 limit 重取，直到露出新行或取尽。
        limit += Math.max(1, seenRowCount);
      }
    }
    // 兜底：后端没有 getMessagesPage 时，一次读入本角色消息，内存内分页。
    if (fallbackRows === null) {
      const all = typeof backend.getAllMessages === 'function'
        ? await backend.getAllMessages(charId)
        : await backend.getAll('messages');
      const deduped = new Map();
      for (const m of (all || []).filter((x) => x && x.charId === charId)) {
        if (!deduped.has(m.id)) deduped.set(m.id, m);
      }
      fallbackRows = [...deduped.values()]
        .sort((a, b) => (b.timestamp - a.timestamp) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }
    if (!fallbackResumed) {
      fallbackResumed = true;
      let skippedAtBoundary = 0;
      while (fallbackIdx < fallbackRows.length) {
        const r = fallbackRows[fallbackIdx];
        if (boundaryTs === null) break;
        if (r.timestamp > boundaryTs) { fallbackIdx++; continue; }
        if (r.timestamp === boundaryTs && skippedAtBoundary < countAtBoundary) {
          skippedAtBoundary++; fallbackIdx++; continue;
        }
        break;
      }
    }
    buffer = fallbackRows.slice(fallbackIdx, fallbackIdx + size);
    fallbackIdx += buffer.length;
    if (fallbackIdx >= fallbackRows.length) exhausted = true;
  }

  async function next() {
    while (buffer.length === 0 && !exhausted) await fetchBatch();
    const msg = buffer.shift();
    if (!msg) return null;
    const ts = Number.isFinite(msg.timestamp) ? msg.timestamp : 0;
    if (boundaryTs === null || ts < boundaryTs) { boundaryTs = ts; countAtBoundary = 1; }
    else countAtBoundary += 1; // 同一毫秒：倒序保证不会大于 boundaryTs
    return msg;
  }

  return { next, cursor: cursorString };
}

// ---------- 对外接口 ----------

/**
 * 搜索当前角色的聊天记录（时间倒序，最新在前）。
 * opts = { keyword, sender, dateFrom, dateTo, types, limit = 30, cursor = null }。
 * 返回 { results, nextCursor, scanned }；results 每项为
 * { id, charId, timestamp, sender, kind, snippet, matchRanges }
 * （matchRanges 相对 snippet 的字符偏移，供 B 组渲染 <mark> 高亮）。
 * scanned 为本次调用实际扫过的消息条数。一次调用内部分批循环直到凑满
 * limit 或扫完；不缓存结果快照，每次调用都重新扫库。
 */
export async function searchChatMessages(backend, charId, opts = {}) {
  if (!charId) throw new Error('搜索聊天记录需要 charId。');
  const {
    keyword = '', sender, dateFrom, dateTo, types,
    limit = 30, cursor = null,
  } = opts || {};
  const take = Math.max(0, Math.floor(limit) || 0);
  const filters = { keyword, sender, dateFrom, dateTo, types };
  const scanner = createChatScanner(backend, charId, SEARCH_BATCH_SIZE, cursor);
  const results = [];
  let scanned = 0;
  for (;;) {
    if (results.length >= take) break;
    const msg = await scanner.next();
    if (!msg) break;
    scanned += 1;
    if (messageMatchesFilters(msg, filters)) results.push(toResult(msg, charId, keyword));
  }
  return { results, nextCursor: scanner.cursor(), scanned };
}

/**
 * 收藏消息列表（时间倒序，最新在前），只含 isFavorite 为真的消息。
 * journals 的 isFavorited（固定注入提示词的记忆收藏）是另一套，绝不混入。
 * 返回 { results, nextCursor }；snippet 为正文前 80 字，matchRanges 为 []。
 */
export async function listFavoriteMessages(backend, charId, { limit = 30, cursor = null } = {}) {
  if (!charId) throw new Error('查看消息收藏需要 charId。');
  const take = Math.max(0, Math.floor(limit) || 0);
  const scanner = createChatScanner(backend, charId, FAVORITES_BATCH_SIZE, cursor);
  const results = [];
  for (;;) {
    if (results.length >= take) break;
    const msg = await scanner.next();
    if (!msg) break;
    if (msg.isFavorite) {
      const text = getMessageText(msg);
      results.push({
        id: msg.id,
        charId: msg.charId || charId,
        timestamp: msg.timestamp,
        sender: normalizeSender(msg),
        kind: normalizeKind(msg),
        snippet: text.slice(0, SNIPPET_HEAD),
        matchRanges: [],
      });
    }
  }
  return { results, nextCursor: scanner.cursor() };
}
