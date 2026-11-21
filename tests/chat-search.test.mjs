// chat-search.test.mjs — 聊天记录中心数据层（A 组）：搜索 / 收藏。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  searchChatMessages, getMessageText, listFavoriteMessages,
  messageMatchesFilters, findKeywordRanges, normalizeKind, normalizeSender,
} from '../js/chatSearch.js';
import { MemoryBackend } from '../js/storage.js';

const CHAR = 'char_1';
const OTHER = 'char_2';

/** 建一条消息：默认 text part 与 content 一致，便于按 app.js 的记录形态测。 */
function M(over = {}) {
  const content = over.content ?? '你好';
  return {
    id: over.id ?? `m_${Math.random().toString(36).slice(2, 9)}`,
    charId: over.charId ?? CHAR,
    role: over.role ?? 'assistant',
    content,
    parts: over.parts !== undefined ? over.parts : [{ type: 'text', text: content }],
    timestamp: over.timestamp ?? 1000,
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

async function collectAll(backend, opts) {
  const ids = [];
  let cursor = null;
  let scannedTotal = 0;
  for (;;) {
    const page = await searchChatMessages(backend, CHAR, { ...opts, cursor });
    ids.push(...page.results.map((r) => r.id));
    scannedTotal += page.scanned;
    if (!page.nextCursor) return { ids, scannedTotal };
    cursor = page.nextCursor;
  }
}

/* ---------- 关键词命中 ---------- */

test('中文关键词命中：子串匹配，snippet 含关键词且 matchRanges 指向它', async () => {
  const backend = await seed([
    M({ id: 'a', content: '我们下周去海边看日落吧', timestamp: 1000 }),
    M({ id: 'b', content: '今天吃什么拉面好呢', timestamp: 2000 }),
  ]);
  const { results, nextCursor } = await searchChatMessages(backend, CHAR, { keyword: '海边' });
  assert.equal(results.length, 1);
  assert.equal(results[0].id, 'a');
  assert.ok(results[0].snippet.includes('海边'));
  assert.ok(results[0].matchRanges.length >= 1);
  for (const [s, e] of results[0].matchRanges) {
    assert.equal(results[0].snippet.slice(s, e), '海边');
  }
  assert.equal(nextCursor, null); // 扫完了
});

test('单字中文关键词也能命中：不靠 tokenize（单字已排除），靠子串', async () => {
  const backend = await seed([
    M({ id: 'a', content: '猫在睡觉', timestamp: 1000 }),
    M({ id: 'b', content: '狗在跑步', timestamp: 2000 }),
  ]);
  const { results } = await searchChatMessages(backend, CHAR, { keyword: '猫' });
  assert.deepEqual(results.map((r) => r.id), ['a']);
});

test('英文关键词大小写不敏感', async () => {
  const backend = await seed([
    M({ id: 'a', content: 'Hello World, nice day', timestamp: 1000 }),
    M({ id: 'b', content: 'nothing here', timestamp: 2000 }),
  ]);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: 'HELLO' })).results.map((r) => r.id), ['a']);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: 'hello world' })).results.map((r) => r.id), ['a']);
});

test('多词关键词：全部最大词都出现才命中（AND），只含其一不命中', async () => {
  const backend = await seed([
    M({ id: 'both', content: '去海边看日落', timestamp: 1000 }),
    M({ id: 'one', content: '去海边散步', timestamp: 2000 }),
  ]);
  const { results } = await searchChatMessages(backend, CHAR, { keyword: '海边 日落' });
  assert.deepEqual(results.map((r) => r.id), ['both']);
});

test('snippet 只截命中前后约 40 字：长文命中在中部，snippet 短于全文', async () => {
  const long = '前言'.repeat(60) + '海边' + '后记'.repeat(60);
  const backend = await seed([M({ id: 'a', content: long, timestamp: 1000 })]);
  const { results } = await searchChatMessages(backend, CHAR, { keyword: '海边' });
  assert.equal(results.length, 1);
  assert.ok(results[0].snippet.length < long.length);
  assert.ok(results[0].snippet.includes('海边'));
  assert.ok(results[0].snippet.length <= 40 + 2 + 40 + 1);
});

test('空关键词不过滤文本：返回全部（再叠加其它过滤器仍生效）', async () => {
  const backend = await seed([
    M({ id: 'a', role: 'user', content: '甲', timestamp: 1000 }),
    M({ id: 'b', role: 'assistant', content: '乙', timestamp: 2000 }),
  ]);
  assert.equal((await searchChatMessages(backend, CHAR, { keyword: '' })).results.length, 2);
  assert.equal((await searchChatMessages(backend, CHAR, {})).results.length, 2);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '', sender: 'me' })).results.map((r) => r.id), ['a']);
});

/* ---------- 过滤器 ---------- */

test('发送者筛选：me 只含 user，ai 只含 assistant，all 不筛选', async () => {
  const backend = await seed([
    M({ id: 'u1', role: 'user', content: '我说的话', timestamp: 1000 }),
    M({ id: 'a1', role: 'assistant', content: '他说的话', timestamp: 2000 }),
    M({ id: 'u2', role: 'user', content: '我又说', timestamp: 3000 }),
  ]);
  assert.deepEqual(
    (await searchChatMessages(backend, CHAR, { sender: 'me' })).results.map((r) => r.id).sort(),
    ['u1', 'u2'],
  );
  assert.deepEqual(
    (await searchChatMessages(backend, CHAR, { sender: 'ai' })).results.map((r) => r.id),
    ['a1'],
  );
  assert.equal((await searchChatMessages(backend, CHAR, { sender: 'all' })).results.length, 3);
});

test('日期范围筛选：含端点，范围外排除', async () => {
  const backend = await seed([
    M({ id: 'before', content: '早', timestamp: 999 }),
    M({ id: 'start', content: '起点', timestamp: 1000 }),
    M({ id: 'mid', content: '中间', timestamp: 1500 }),
    M({ id: 'end', content: '终点', timestamp: 2000 }),
    M({ id: 'after', content: '晚', timestamp: 2001 }),
  ]);
  const { results } = await searchChatMessages(backend, CHAR, { dateFrom: 1000, dateTo: 2000 });
  assert.deepEqual(results.map((r) => r.id).sort(), ['end', 'mid', 'start']);
});

test('类型筛选：sticker / image 各归其类，text 不混入', async () => {
  const backend = await seed([
    M({ id: 'st', content: '[阿澈的表情包：贴贴]', timestamp: 1000 }),
    M({ id: 'im', content: '', parts: [{ type: 'image', attachmentId: 'att1' }], timestamp: 2000 }),
    M({ id: 'tx', content: '普通文字', timestamp: 3000 }),
    M({ id: 'vc', content: '[阿澈的语音：3秒]', timestamp: 4000 }),
  ]);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { types: ['sticker'] })).results.map((r) => r.id), ['st']);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { types: ['image'] })).results.map((r) => r.id), ['im']);
  assert.deepEqual(
    (await searchChatMessages(backend, CHAR, { types: ['sticker', 'voice'] })).results.map((r) => r.id).sort(),
    ['st', 'vc'],
  );
  assert.equal((await searchChatMessages(backend, CHAR, { types: [] })).results.length, 4);
});

test('相同文案多条分条列出且 id 不同：不按文案去重', async () => {
  const backend = await seed([
    M({ id: 'dup1', content: '好的', timestamp: 1000 }),
    M({ id: 'dup2', content: '好的', timestamp: 2000 }),
    M({ id: 'dup3', content: '好的', timestamp: 3000 }),
  ]);
  const { results } = await searchChatMessages(backend, CHAR, { keyword: '好的' });
  assert.deepEqual(results.map((r) => r.id).sort(), ['dup1', 'dup2', 'dup3']);
});

test('跨角色隔离：其它角色的消息不出现', async () => {
  const backend = await seed([
    M({ id: 'mine', content: '海边', timestamp: 1000 }),
    M({ id: 'theirs', charId: OTHER, content: '海边', timestamp: 2000 }),
  ]);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '海边' })).results.map((r) => r.id), ['mine']);
});

/* ---------- getMessageText ---------- */

test('getMessageText：剥协议壳、去 thinking 与 inner_voice 标签、排除状态模板与 base64', () => {
  assert.equal(getMessageText(M({ content: '[阿澈的消息：今晚去海边]' })), '今晚去海边');
  assert.equal(getMessageText(M({ content: '[阿澈引用“早安”并回复：早安呀]' })), '早安呀');
  assert.equal(getMessageText(M({ content: '<thinking>让我想想</thinking>今晚去海边' })), '今晚去海边');
  assert.equal(getMessageText(M({ content: '[inner_voice]好想他[/inner_voice]今晚去海边' })), '好想他今晚去海边');
  assert.equal(getMessageText(M({ content: '[阿澈的表情包：贴贴]' })), '');
  assert.equal(getMessageText(M({ content: '[阿澈发来的照片/视频：IMG_1]' })), '');
  assert.equal(getMessageText(M({ content: '[阿澈更新状态为：开心]' })), '');
  assert.equal(getMessageText(M({ content: '状态', isStatusUpdate: true, statusText: '开心' })), '');
  assert.equal(getMessageText(M({ content: '<div style="color:red">状态栏</div>' })), '');
  assert.equal(getMessageText(M({
    content: '',
    parts: [{ type: 'text', text: '文字' }, { type: 'image', data: 'data:image/png;base64,AAAA' }],
  })), '文字');
  assert.equal(getMessageText(M({ content: '', parts: [{ type: 'image', data: 'data:image/png;base64,AAAA' }] })), '');
  assert.equal(getMessageText(M({ content: '', parts: [] })), '');
});

test('被撤回 / 无文本消息不靠关键词命中：只按占位文本算', async () => {
  const backend = await seed([
    M({ id: 'wd', content: '[我 撤回了一条消息：海边秘密]', isWithdrawn: true, originalContent: '海边秘密', timestamp: 1000 }),
    M({ id: 'img', content: '', parts: [{ type: 'image', attachmentId: 'att1' }], timestamp: 2000 }),
  ]);
  assert.equal(getMessageText((await backend.get('messages', 'wd'))), '你撤回了一则讯息');
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '海边秘密' })).results, []);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '撤回' })).results.map((r) => r.id), ['wd']);
  // 无文本图片消息：关键词查不到，但类型筛选能命中
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '图片' })).results, []);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { types: ['image'] })).results.map((r) => r.id), ['img']);
});

test('messageMatchesFilters 纯函数：与搜索同一判定', () => {
  const msg = M({ id: 'x', role: 'user', content: '去海边', timestamp: 1500 });
  assert.equal(messageMatchesFilters(msg, { keyword: '海边', sender: 'me', dateFrom: 1000, dateTo: 2000, types: ['text'] }), true);
  assert.equal(messageMatchesFilters(msg, { keyword: '海边', sender: 'ai' }), false);
  assert.equal(messageMatchesFilters(msg, { keyword: '日落' }), false);
  assert.equal(messageMatchesFilters(msg, { dateFrom: 2000 }), false);
  assert.equal(messageMatchesFilters(msg, { types: ['sticker'] }), false);
  assert.equal(messageMatchesFilters(msg, {}), true);
  assert.equal(normalizeSender({ role: 'user' }), 'me');
  assert.equal(normalizeSender({ role: 'assistant' }), 'ai');
  assert.equal(normalizeKind({ content: '[阿澈的语音：3秒]' }), 'voice');
  assert.equal(normalizeKind({ kind: 'photo' }), 'image');
  assert.deepEqual(findKeywordRanges('去海边看日落', '海边'), [[1, 3]]);
});

/* ---------- 编辑 / 删除的新鲜度 ---------- */

test('编辑后新文案命中、旧文案不命中，且不出现重复结果', async () => {
  const backend = await seed([M({ id: 'e', content: '去海边', timestamp: 1000 })]);
  assert.equal((await searchChatMessages(backend, CHAR, { keyword: '海边' })).results.length, 1);
  const edited = M({ id: 'e', content: '去爬山', timestamp: 1000 });
  await backend.put('messages', edited);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '爬山' })).results.map((r) => r.id), ['e']);
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '海边' })).results, []);
  assert.equal((await searchChatMessages(backend, CHAR, {})).results.length, 1);
});

test('删除后查不到', async () => {
  const backend = await seed([
    M({ id: 'gone', content: '海边', timestamp: 1000 }),
    M({ id: 'stay', content: '海边', timestamp: 2000 }),
  ]);
  await backend.delete('messages', 'gone');
  assert.deepEqual((await searchChatMessages(backend, CHAR, { keyword: '海边' })).results.map((r) => r.id), ['stay']);
});

/* ---------- 收藏 ---------- */

test('收藏列表倒序且只含 isFavorite：journals 的 isFavorited 绝不混入', async () => {
  const backend = await seed([
    M({ id: 'f1', content: '第一条收藏', isFavorite: true, timestamp: 1000 }),
    M({ id: 'n1', content: '没收藏', timestamp: 2000 }),
    M({ id: 'f2', content: '第二条收藏', isFavorite: true, timestamp: 3000 }),
    M({ id: 'j1', content: '记忆收藏的冒充者', isFavorited: true, timestamp: 4000 }),
    M({ id: 'f3', content: '第三条收藏', isFavorite: true, timestamp: 2500 }),
  ]);
  const { results, nextCursor } = await listFavoriteMessages(backend, CHAR, {});
  assert.deepEqual(results.map((r) => r.id), ['f2', 'f3', 'f1']);
  assert.equal(results[0].snippet, '第二条收藏');
  assert.deepEqual(results[0].matchRanges, []);
  assert.equal(nextCursor, null);
});

test('收藏分页：limit 翻页不重不漏', async () => {
  const rows = Array.from({ length: 5 }, (_, i) => M({
    id: `fav${i}`, content: `收藏${i}`, isFavorite: true, timestamp: (i + 1) * 1000,
  }));
  const backend = await seed(rows);
  const seen = [];
  let cursor = null;
  let pages = 0;
  for (;;) {
    const page = await listFavoriteMessages(backend, CHAR, { limit: 2, cursor });
    seen.push(...page.results.map((r) => r.id));
    pages++;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.deepEqual(seen, ['fav4', 'fav3', 'fav2', 'fav1', 'fav0']);
  assert.equal(pages, 3);
});

/* ---------- 分页游标 ---------- */

test('分页 cursor 能接着往下翻且不重不漏：250 条含关键词，limit 30', async () => {
  const rows = Array.from({ length: 250 }, (_, i) => M({
    id: `m${i}`, content: i % 2 ? `第${i}条去海边` : `第${i}条无关`, timestamp: (i + 1) * 1000,
  }));
  const backend = await seed(rows);
  const { ids, scannedTotal } = await collectAll(backend, { keyword: '海边', limit: 30 });
  assert.equal(ids.length, 125);
  assert.equal(new Set(ids).size, 125);
  assert.equal(scannedTotal, 250); // 每条都被扫过一次，不多不少
  // 倒序：最新在前
  const ts = ids.map((id) => Number(id.slice(1)));
  assert.deepEqual(ts, [...ts].sort((a, b) => b - a));
});

test('同一毫秒多条消息分页不重不漏', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => M({
    id: `s${String(i).padStart(3, '0')}`, content: `同毫秒${i} 海边`, timestamp: 5000,
  }));
  const backend = await seed(rows);
  const { ids, scannedTotal } = await collectAll(backend, { keyword: '海边', limit: 30 });
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
  assert.equal(scannedTotal, 120);
});

test('编辑过的消息分页不重不漏（MemoryBackend 同 id 多次 put 留重复行）', async () => {
  const rows = Array.from({ length: 120 }, (_, i) => M({
    id: `e${String(i).padStart(3, '0')}`, content: `第${i}条 海边`, timestamp: (i + 1) * 1000,
  }));
  const backend = await seed(rows);
  for (let i = 0; i < 120; i += 10) {
    await backend.put('messages', M({ id: `e${String(i).padStart(3, '0')}`, content: `第${i}条改后 海边`, timestamp: (i + 1) * 1000 }));
  }
  const { ids, scannedTotal } = await collectAll(backend, { keyword: '海边', limit: 25 });
  assert.equal(ids.length, 120);
  assert.equal(new Set(ids).size, 120);
  assert.equal(scannedTotal, 120);
});

test('无结果时 nextCursor 为 null；无效游标抛错', async () => {
  const backend = await seed([M({ id: 'a', content: '你好', timestamp: 1000 })]);
  const empty = await searchChatMessages(backend, CHAR, { keyword: '不存在的词' });
  assert.deepEqual(empty.results, []);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.scanned, 1);
  await assert.rejects(searchChatMessages(backend, CHAR, { cursor: 'not-json' }), /无效的聊天搜索游标/);
  await assert.rejects(searchChatMessages(backend, '', {}), /charId/);
});
