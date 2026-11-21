// chat-dates.test.mjs — 聊天记录中心数据层（A 组）：日期枚举 / 按日取消息。
import test from 'node:test';
import assert from 'node:assert/strict';
import { getChatDates, dayBounds, messagesForDay } from '../js/chatDates.js';
import { MemoryBackend } from '../js/storage.js';

const CHAR = 'char_1';

/** 本地时区构造时间戳：new Date(y, m0, d, h, mi) 永远是本机时区。 */
function localTs(y, m0, d, h = 12, mi = 0) {
  return new Date(y, m0, d, h, mi, 0, 0).getTime();
}

function M(over = {}) {
  const content = over.content ?? '你好';
  return {
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 9)}`,
    charId: over.charId ?? CHAR,
    role: over.role ?? 'assistant',
    content,
    parts: over.parts !== undefined ? over.parts : [{ type: 'text', text: content }],
    timestamp: over.timestamp ?? localTs(2026, 10, 20),
    ...Object.fromEntries(Object.entries(over).filter(([k]) => !['content', 'parts'].includes(k))),
    ...(over.parts !== undefined ? { parts: over.parts } : {}),
    ...(over.content !== undefined ? { content: over.content } : {}),
  };
}

async function seed(rows) {
  const backend = new MemoryBackend();
  await backend.init();
  for (const r of rows) await backend.put('messages', r);
  return backend;
}

/* ---------- getChatDates ---------- */

test('getChatDates 只含真实有记录的日期，升序，不补空日期', async () => {
  const backend = await seed([
    M({ id: 'a', timestamp: localTs(2026, 10, 20, 10, 0) }),
    M({ id: 'b', timestamp: localTs(2026, 10, 18, 10, 0) }),
    M({ id: 'c', timestamp: localTs(2026, 10, 20, 22, 0) }),
    M({ id: 'd', timestamp: localTs(2026, 10, 25, 10, 0) }),
    M({ id: 'e', charId: 'char_2', timestamp: localTs(2026, 10, 19, 10, 0) }),
  ]);
  assert.deepEqual(await getChatDates(backend, CHAR), ['2026-11-18', '2026-11-20', '2026-11-25']);
});

test('getChatDates 无记录返回空数组；分批扫 450 条仍全量', async () => {
  const empty = await seed([]);
  assert.deepEqual(await getChatDates(empty, CHAR), []);
  const rows = Array.from({ length: 450 }, (_, i) => M({
    id: `m${i}`,
    timestamp: localTs(2026, 10, 10 + (i % 5), 10, i % 60),
  }));
  const backend = await seed(rows);
  assert.deepEqual(
    await getChatDates(backend, CHAR),
    ['2026-11-10', '2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14'],
  );
});

test('dayBounds 跨时区边界正确：本地 23:59 与次日 00:01 分属两天', async () => {
  const backend = await seed([
    M({ id: 'late', content: '深夜', timestamp: localTs(2026, 10, 20, 23, 59) }),
    M({ id: 'early', content: '凌晨', timestamp: localTs(2026, 10, 21, 0, 1) }),
  ]);
  assert.deepEqual(await getChatDates(backend, CHAR), ['2026-11-20', '2026-11-21']);
  const { results: day20 } = await messagesForDay(backend, CHAR, '2026-11-20');
  const { results: day21 } = await messagesForDay(backend, CHAR, '2026-11-21');
  assert.deepEqual(day20.map((r) => r.id), ['late']);
  assert.deepEqual(day21.map((r) => r.id), ['early']);
});

/* ---------- dayBounds ---------- */

test('dayBounds：当天 00:00:00.000 到 23:59:59.999（本地时区）', () => {
  const { start, end } = dayBounds('2026-11-20');
  const s = new Date(start);
  assert.deepEqual([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours(), s.getMinutes(), s.getSeconds(), s.getMilliseconds()],
    [2026, 10, 20, 0, 0, 0, 0]);
  const e = new Date(end);
  assert.deepEqual([e.getFullYear(), e.getMonth(), e.getDate(), e.getHours(), e.getMinutes(), e.getSeconds(), e.getMilliseconds()],
    [2026, 10, 20, 23, 59, 59, 999]);
  assert.equal(end - start, 24 * 60 * 60 * 1000 - 1);
  // 跨月边界：次日 00:00 减 1ms 即当月最后一天的 23:59:59.999
  const jan31 = dayBounds('2026-01-31');
  assert.equal(new Date(jan31.end).getDate(), 31);
  assert.equal(new Date(jan31.end + 1).getDate(), 1);
  assert.throws(() => dayBounds('2026-02-30'), /不存在的日期/);
  assert.throws(() => dayBounds('2026/11/20'), /YYYY-MM-DD/);
  assert.throws(() => dayBounds(''), /YYYY-MM-DD/);
});

/* ---------- messagesForDay ---------- */

test('messagesForDay：时间正序，只含当天，含端点', async () => {
  const backend = await seed([
    M({ id: 'd1', content: '早上', timestamp: localTs(2026, 10, 20, 8, 0) }),
    M({ id: 'd2', content: '中午', timestamp: localTs(2026, 10, 20, 12, 0) }),
    M({ id: 'd3', content: '晚上', timestamp: localTs(2026, 10, 20, 23, 59) }),
    M({ id: 'other', content: '隔天', timestamp: localTs(2026, 10, 21, 0, 0) }),
    M({ id: 'prev', content: '前一天', timestamp: localTs(2026, 10, 19, 23, 59) }),
  ]);
  const { results, nextCursor } = await messagesForDay(backend, CHAR, '2026-11-20');
  assert.deepEqual(results.map((r) => r.id), ['d1', 'd2', 'd3']);
  assert.equal(results[0].snippet, '早上');
  assert.equal(results[0].sender, 'ai');
  assert.equal(results[0].kind, 'text');
  assert.equal(nextCursor, null);
});

test('messagesForDay 空日期返回空数组；分页不重不漏', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => M({
    id: `d${String(i).padStart(3, '0')}`,
    content: `当天第${i}条`,
    timestamp: localTs(2026, 10, 20, 0, 0) + i * 60 * 1000,
  }));
  rows.push(M({ id: 'next-day', content: '隔天', timestamp: localTs(2026, 10, 21, 9, 0) }));
  const backend = await seed(rows);
  const empty = await messagesForDay(backend, CHAR, '2026-11-22');
  assert.deepEqual(empty.results, []);
  assert.equal(empty.nextCursor, null);

  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await messagesForDay(backend, CHAR, '2026-11-20', { limit: 50, cursor });
    // 每页内时间正序
    const ts = page.results.map((r) => r.timestamp);
    assert.deepEqual(ts, [...ts].sort((a, b) => a - b));
    seen.push(...page.results.map((r) => r.id));
    pages++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.equal(pages, 3);
  // 第一页是当天最新的 50 条（正序排列）
  const first = await messagesForDay(backend, CHAR, '2026-11-20', { limit: 50 });
  assert.equal(first.results[0].id, 'd070');
  assert.equal(first.results[49].id, 'd119');
});
