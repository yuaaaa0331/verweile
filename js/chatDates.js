// chatDates.js — 聊天记录中心：日期层（A 组）。
// 纯函数 + backend 注入；日期一律按本机时区划分（本地 getFullYear /
// getMonth / getDate），不用 UTC。扫描复用 js/chatSearch.js 的分批扫描器。
import { createChatScanner, getMessageText, normalizeSender, normalizeKind, CHAT_DATES_BATCH_SIZE } from './chatSearch.js';
import { pad } from './utils.js';

/** 按日取消息时每批扫的消息条数（与搜索同一游标机制）。 */
export const DAY_MESSAGES_BATCH_SIZE = 100;
/** 无关键词的 snippet 取正文前 80 字。 */
export const DAY_SNIPPET_HEAD = 80;

/** 时间戳 → 本地时区 'YYYY-MM-DD'。 */
export function localDateString(timestamp) {
  const d = new Date(timestamp);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * 返回 ['YYYY-MM-DD', ...] 升序，只含实际存在聊天记录的日期。
 * 分批扫 messages 表（每批 200 条，只取时间戳做日期归集）。
 */
export async function getChatDates(backend, charId) {
  if (!charId) throw new Error('取聊天日期需要 charId。');
  const scanner = createChatScanner(backend, charId, CHAT_DATES_BATCH_SIZE);
  const dates = new Set();
  for (;;) {
    const msg = await scanner.next();
    if (!msg) break;
    if (Number.isFinite(msg.timestamp)) dates.add(localDateString(msg.timestamp));
  }
  return [...dates].sort();
}

/**
 * 输入 'YYYY-MM-DD'，返回 { start, end } 时间戳：
 * 本地时区当天 00:00:00.000 到 23:59:59.999。非法日期抛错。
 */
export function dayBounds(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw new Error('日期格式应为 YYYY-MM-DD。');
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const startDate = new Date(y, mo - 1, d, 0, 0, 0, 0);
  if (startDate.getFullYear() !== y || startDate.getMonth() !== mo - 1 || startDate.getDate() !== d) {
    throw new Error('不存在的日期。');
  }
  const start = startDate.getTime();
  const end = new Date(y, mo - 1, d + 1, 0, 0, 0, 0).getTime() - 1;
  return { start, end };
}

/**
 * 返回当天消息（时间正序），每项为轻字段 + snippet
 * { id, charId, timestamp, sender, kind, snippet, matchRanges }。
 * 分页：先取当天最新的 limit 条再翻成正序，游标与搜索同一机制，
 * 原样回传即可接着往更旧的消息翻；扫完 nextCursor 为 null。
 */
export async function messagesForDay(backend, charId, dateStr, { limit = 50, cursor = null } = {}) {
  if (!charId) throw new Error('按日取消息需要 charId。');
  const { start, end } = dayBounds(dateStr);
  const take = Math.max(0, Math.floor(limit) || 0);
  const scanner = createChatScanner(backend, charId, DAY_MESSAGES_BATCH_SIZE, cursor);
  const desc = [];
  for (;;) {
    if (desc.length >= take) break;
    const msg = await scanner.next();
    if (!msg) break;
    if (msg.timestamp >= start && msg.timestamp <= end) {
      desc.push({
        id: msg.id,
        charId: msg.charId || charId,
        timestamp: msg.timestamp,
        sender: normalizeSender(msg),
        kind: normalizeKind(msg),
        snippet: getMessageText(msg).slice(0, DAY_SNIPPET_HEAD),
        matchRanges: [],
      });
    }
  }
  return { results: desc.reverse(), nextCursor: scanner.cursor() };
}
