// chatCenter.js — 聊天记录中心（B 组）：搜索 / 消息收藏 / 按日期查看的
// 纯逻辑与渲染字符串。
// 只依赖 utils，不 import A 组模块；A 组函数（searchChatMessages /
// listFavoriteMessages / getMessageText / getChatDates / messagesForDay）
// 由 app.js 在调用点传入——A 模块未落盘时本模块在 Node 测试里仍可解析。
// 渲染只产 HTML 字符串，事件接线在 app.js 里做委托；样式见 styles.css
// 的「B 组：聊天记录中心」一段，黑白灰，沿用 .subpage / .setting-row。
import { uid, escapeHtml } from './utils.js';

/** 搜索与收藏列表的每页条数（与 A 组契约默认值一致）。 */
export const SEARCH_PAGE_SIZE = 30;
export const FAVORITES_PAGE_SIZE = 30;

/** 消息类型筛选选项（value 与 A 组契约的 kind 一致）。 */
export const CHAT_CENTER_TYPES = [
  { value: 'text', label: '文本' },
  { value: 'sticker', label: '表情包' },
  { value: 'image', label: '图片' },
  { value: 'voice', label: '语音' },
  { value: 'transfer', label: '转账' },
  { value: 'gift', label: '礼物' },
  { value: 'quote', label: '引用' },
  { value: 'status', label: '状态' },
];

const KIND_LABELS = Object.fromEntries(CHAT_CENTER_TYPES.map((t) => [t.value, t.label]));

/** 'YYYY-MM-DD'（本机时区）→ 当天起止时间戳，与 A 组 dayBounds 同口径。
 *  非法日期返回 null（调用方当作不过滤这一项，不抛错）。
 *  转换必须在这里做：A 组契约要求 dateFrom/dateTo 是时间戳，UI 日期输入
 *  给的是字符串，直接透传会在 messageMatchesFilters 里与 NaN 比较、
 *  把全部消息滤掉（集成验证 2c 实测：11-18 当天 28 条 → 0 条）。 */
function dateStrToDayStart(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}
function dateStrToDayEnd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 23, 59, 59, 999);
  if (d.getFullYear() !== Number(m[1]) || d.getMonth() !== Number(m[2]) - 1 || d.getDate() !== Number(m[3])) return null;
  return d.getTime();
}

/** UI 筛选状态 → 传给 A 组 searchChatMessages 的 filters。
 *  sender 'all'、空日期、空类型都不传（不等于不过滤，等于不过滤这一项）；
 *  keyword 始终传（去首尾空白后，空串表示不限关键词）。
 *  日期输入是 'YYYY-MM-DD' 字符串，这里转成本机时区当天起止时间戳再传，
 *  与 A 组 messageMatchesFilters 的时间戳比较口径一致。 */
export function buildSearchFilters(state) {
  const keyword = String(state?.keyword ?? '').trim();
  const sender = state?.sender === 'me' || state?.sender === 'ai' ? state.sender : null;
  const dateFrom = dateStrToDayStart(state?.dateFrom);
  const dateTo = dateStrToDayEnd(state?.dateTo);
  const types = [...new Set(state?.types || [])]
    .filter((t) => KIND_LABELS[t]);
  const out = { keyword };
  if (sender) out.sender = sender;
  if (dateFrom != null) out.dateFrom = dateFrom;
  if (dateTo != null) out.dateTo = dateTo;
  if (types.length) out.types = types;
  return out;
}

/** 防抖（搜索框默认 300ms）：只执行最后一次调用。 */
export function debounce(fn, ms = 300) {
  let timer = null;
  return (...args) => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本机时区日期时间：YYYY-MM-DD HH:mm。 */
export function formatChatCenterDate(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 本机时区日期：YYYY-MM-DD（与 A 组 getChatDates 的口径一致）。 */
export function localDateStr(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function senderLabel(sender, myName, charName) {
  if (sender === 'me') return myName || '我';
  if (sender === 'ai') return charName || '对方';
  return sender || '';
}

/** 片段高亮：按 matchRanges 把命中区间包进 <mark>。
 *  matchRanges 接受 [{start,end}] 或 [[start,end]] 两种写法；
 *  区间先排序、夹到片段长度内、重叠的合并；片段本身先转义，绝不原样插 HTML。 */
export function highlightSnippet(snippet, matchRanges) {
  const text = String(snippet ?? '');
  const ranges = (matchRanges || [])
    .map((r) => (Array.isArray(r) ? { start: r[0], end: r[1] } : { start: r.start, end: r.end }))
    .map((r) => ({ start: Math.max(0, Math.min(text.length, r.start | 0)), end: Math.max(0, Math.min(text.length, r.end | 0)) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end);
    else merged.push({ ...r });
  }
  if (!merged.length) return escapeHtml(text);
  let out = '';
  let pos = 0;
  for (const r of merged) {
    out += escapeHtml(text.slice(pos, r.start));
    out += `<mark>${escapeHtml(text.slice(r.start, r.end))}</mark>`;
    pos = r.end;
  }
  out += escapeHtml(text.slice(pos));
  return out;
}

function resultMetaHTML(r, myName, charName) {
  return `<div class="cc-result-meta"><span>${escapeHtml(formatChatCenterDate(r.timestamp))}</span>`
    + `<span>${escapeHtml(senderLabel(r.sender, myName, charName))}</span>`
    + (r.kind ? `<span>${escapeHtml(KIND_LABELS[r.kind] || r.kind)}</span>` : '')
    + `</div>`;
}

/** 一条搜索结果（相同文案分条列出：每条按真实消息 id 渲染，绝不按文案去重）。 */
export function searchResultItemHTML(r, myName, charName) {
  return `<div class="cc-result" data-id="${escapeHtml(String(r.id))}" data-kind="${escapeHtml(String(r.kind || ''))}">`
    + resultMetaHTML(r, myName, charName)
    + `<div class="cc-result-snippet">${highlightSnippet(r.snippet || '', r.matchRanges || [])}</div></div>`;
}

/** 一条收藏消息：查看上下文 / 取消收藏 / 保存为记忆三个操作。 */
export function favoriteItemHTML(r, myName, charName) {
  return `<div class="cc-result cc-fav" data-id="${escapeHtml(String(r.id))}" data-kind="${escapeHtml(String(r.kind || ''))}">`
    + resultMetaHTML(r, myName, charName)
    + `<div class="cc-result-snippet">${escapeHtml(r.snippet || '')}</div>`
    + `<div class="cc-actions-row"><button data-cc-act="view" data-id="${escapeHtml(String(r.id))}">查看上下文</button>`
    + `<button data-cc-act="unfav" data-id="${escapeHtml(String(r.id))}">取消收藏</button>`
    + `<button data-cc-act="save-memory" data-id="${escapeHtml(String(r.id))}">保存为记忆</button></div></div>`;
}

/** 月份平移（month 为 0-11），返回 { year, month }。 */
export function shiftMonth(year, month, delta) {
  const d = new Date(year, month + delta, 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

/** 某月的日历格（周一起始）：weeks 是 7 列的行数组，格子为 null（空白）
 *  或 { dateStr: 'YYYY-MM-DD', day, hasRecords }；只有真实有记录的
 *  日期 hasRecords 为 true，其余日期渲染时置灰不可点。 */
export function buildCalendarMonth(year, month, dateSet) {
  const first = new Date(year, month, 1);
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const lead = (first.getDay() + 6) % 7; // 周一为每周第一列
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${pad2(month + 1)}-${pad2(d)}`;
    cells.push({ dateStr, day: d, hasRecords: dateSet.has(dateStr) });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { year, month, weeks };
}

/** 日历 HTML：有记录的日期是可点按钮，无记录的置灰 disabled。 */
export function calendarMonthHTML(cal) {
  const head = ['一', '二', '三', '四', '五', '六', '日']
    .map((w) => `<span class="cc-cal-weekday">${w}</span>`).join('');
  const body = cal.weeks.map((week) => week.map((cell) => {
    if (!cell) return '<span class="cc-cal-day cc-cal-blank"></span>';
    if (!cell.hasRecords) return `<span class="cc-cal-day" aria-disabled="true">${cell.day}</span>`;
    return `<button class="cc-cal-day cc-cal-has" data-date="${escapeHtml(cell.dateStr)}">${cell.day}</button>`;
  }).join('')).join('');
  return `<div class="cc-cal-grid"><div class="cc-cal-row cc-cal-head">${head}</div>${body}</div>`;
}

/** 取消一条消息的收藏（只改消息的 isFavorite，不动记忆收藏的 isFavorited）。 */
export async function unfavoriteMessage(backend, messageId) {
  const m = await backend.get('messages', messageId);
  if (!m) return null;
  m.isFavorite = false;
  await backend.put('messages', m);
  return m;
}

/** 手动把一条消息存为记忆：只在用户点「保存为记忆」时调用，绝不自动建。
 *  content 为消息文本（A 组 getMessageText），并带 sourceMessageId；
 *  isFavorited 保持 false——消息收藏与记忆收藏是两套，互不混淆。
 *  调用方随后走 attachJournals + scheduleReindexDocument（与手动建记忆同链路）。 */
export async function saveMessageAsMemory(backend, charId, msg, getText) {
  const raw = typeof getText === 'function' ? await getText(msg) : (msg?.content || '');
  const text = String(raw || '').trim();
  const journal = {
    id: uid('journal'),
    charId,
    title: text ? text.slice(0, 24) : '聊天消息',
    content: text,
    source: '聊天记录',
    sourceMessageId: msg.id,
    isFavorited: false,
    retrievalEnabled: true,
    timestamp: Date.now(),
  };
  await backend.put('journals', journal);
  return journal;
}

/** 按日期跳当天首条：messagesForDay 每页取当天最新的 limit 条再翻成页内正序，
 *  所以首条不在第一页——要顺着 nextCursor 往更旧翻到最后一页，取其第一条。
 *  pageSize 默认 500，减少长日期的翻页次数；游标重复或 200 页封顶时停下。
 *  当天无消息返回 null。 */
export async function findFirstMessageOfDay(messagesForDayFn, backend, charId, dateStr, { pageSize = 500, maxPages = 200 } = {}) {
  let cursor = null;
  let first = null;
  const seenCursors = new Set();
  for (let page = 0; page < maxPages; page++) {
    const res = await messagesForDayFn(backend, charId, dateStr, { limit: pageSize, cursor });
    const list = res?.results || (Array.isArray(res) ? res : []);
    if (list.length) first = list[0]; // 越往后的页越旧，首条以最后一页为准
    const next = res?.nextCursor ?? null;
    if (!next || seenCursors.has(next)) break;
    seenCursors.add(next);
    cursor = next;
  }
  return first;
}

/** 消息定位的核心循环（app.js jumpToMessage 与 openChatForBanner 共用，
 *  不另写第二套定位逻辑）。
 *  deps：backend/charId/messageId；findTarget(id) 在已渲染 DOM 里找气泡；
 *  renderLatest() 全量渲染最新一页（renderMessages(false)）；
 *  renderOlder() 再往前翻一页，返回 { hasMore, oldest }；
 *  scrollTo/highlight/onMissing 由调用方接 DOM。
 *  找不到消息记录时直接报 missing；翻页到 oldest 不再变小（同时间戳分页
 *  边界）或 hasMore 为 false 时停下，不死循环。 */
export async function runJumpToMessage({
  backend, charId, messageId,
  findTarget, renderLatest, renderOlder, scrollTo, highlight, onMissing,
  maxPages = 200,
}) {
  const msg = await backend.get('messages', messageId);
  if (!msg) { onMissing?.(); return { ok: false, reason: 'missing' }; }
  let target = findTarget(messageId);
  if (!target) {
    await renderLatest();
    target = findTarget(messageId);
  }
  let pagesLoaded = 0;
  const seenOldest = new Set();
  while (!target && pagesLoaded < maxPages) {
    const { hasMore, oldest } = await renderOlder();
    pagesLoaded++;
    target = findTarget(messageId); // 先查目标：最后一页（hasMore 为 false）也可能正好含目标
    if (target || !hasMore) break;
    if (oldest !== null && oldest !== undefined) {
      if (seenOldest.has(oldest)) break; // 分页边界不再前进
      seenOldest.add(oldest);
    }
  }
  if (!target) { onMissing?.(); return { ok: false, reason: 'not-rendered' }; }
  scrollTo(target);
  highlight(target);
  return { ok: true, timestamp: msg.timestamp, pagesLoaded };
}
