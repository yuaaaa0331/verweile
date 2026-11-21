// chat-center-ui.test.mjs — B 组：聊天记录中心的 UI 与接线。
// app.js 本身是浏览器入口不进 Node 测试（与 chat-ui-integration.test.mjs
// 同一约定）：纯逻辑测 js/chatCenter.js（MemoryBackend + 假 DOM 元素），
// app.js / index.html / styles.css / 构建脚本走源码静态断言。
// 数据查询直接用真实 A 组模块（js/chatSearch.js / js/chatDates.js），
// 按 A 组锁定的契约验证 B 组接线：matchRanges 相对 snippet、sender 'all'、
// 搜索与收藏时间倒序、messagesForDay 第一页取当天最新。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryBackend } from '../js/storage.js';
import { searchChatMessages, listFavoriteMessages, getMessageText } from '../js/chatSearch.js';
import { messagesForDay } from '../js/chatDates.js';
import {
  SEARCH_PAGE_SIZE, FAVORITES_PAGE_SIZE, CHAT_CENTER_TYPES,
  buildSearchFilters, debounce, highlightSnippet, formatChatCenterDate,
  localDateStr, senderLabel, searchResultItemHTML, favoriteItemHTML,
  buildCalendarMonth, shiftMonth, calendarMonthHTML,
  unfavoriteMessage, saveMessageAsMemory, findFirstMessageOfDay, runJumpToMessage,
} from '../js/chatCenter.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(resolve(root, 'js/app.js'), 'utf8');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const css = readFileSync(resolve(root, 'styles.css'), 'utf8');
const buildPreview = readFileSync(resolve(root, 'scripts/build-preview.mjs'), 'utf8');

const CHAR_ID = 'char_1';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function seedMessages(backend, n, { favorites = 0 } = {}) {
  const base = new Date('2026-11-20T10:00:00').getTime();
  for (let i = 0; i < n; i++) {
    await backend.put('messages', {
      id: `m${i}`, charId: CHAR_ID, role: i % 2 ? 'assistant' : 'user',
      timestamp: base + i * 60_000,
      content: `消息${i} 你好`,
      parts: [{ type: 'text', text: `消息${i} 你好` }],
      isFavorite: i < favorites,
    });
  }
  return base;
}

/* ---- 1. 入口：顶栏 ··· 菜单三项 + 三个二级页 ---- */

test('菜单三项存在：openChatMenu 里有搜索聊天 / 收藏消息 / 按日期查看，点开对应二级页', () => {
  for (const [id, label, page] of [
    ['cm-chat-search', '搜索聊天', 'openChatSearch'],
    ['cm-chat-favorites', '收藏消息', 'openChatFavorites'],
    ['cm-chat-dates', '按日期查看', 'openChatDates'],
  ]) {
    assert.ok(appJs.includes(`id="${id}"`), `菜单应有 ${id}`);
    assert.ok(appJs.includes(`>${label}<`), `菜单应显示「${label}」`);
    assert.ok(appJs.includes(`${page}(`), `菜单项应调用 ${page}`);
  }
  for (const sub of ['sub-chat-search', 'sub-chat-favorites', 'sub-chat-dates']) {
    assert.ok(html.includes(`id="${sub}"`), `index.html 应有二级页 ${sub}`);
  }
  assert.ok(html.includes('<h2>搜索聊天</h2>'), '搜索页标题');
  assert.ok(html.includes('<h2>消息收藏</h2>'), '收藏页标题用“消息收藏”，不与记忆收藏混用');
  assert.ok(html.includes('<h2>按日期查看</h2>'), '日期页标题');
});

/* ---- 2. 搜索页筛选组合 ---- */

test('搜索筛选组合：发送者/日期范围/类型拼成 A 组 filters；全部与空项不传', () => {
  // 日期输入是 'YYYY-MM-DD' 字符串，输出必须是本机时区当天起止时间戳
  // （A 组契约）；直接透传字符串会在时间戳比较里变 NaN、滤掉全部消息。
  assert.deepEqual(
    buildSearchFilters({ keyword: ' 你好 ', sender: 'me', dateFrom: '2026-11-01', dateTo: '2026-11-20', types: ['text', 'image'] }),
    { keyword: '你好', sender: 'me', dateFrom: new Date(2026, 10, 1, 0, 0, 0, 0).getTime(), dateTo: new Date(2026, 10, 20, 23, 59, 59, 999).getTime(), types: ['text', 'image'] },
  );
  assert.deepEqual(
    buildSearchFilters({ keyword: '', sender: 'all', dateFrom: '', dateTo: '', types: [] }),
    { keyword: '' },
  );
  assert.deepEqual(
    buildSearchFilters({ keyword: 'x', sender: 'ai', types: ['voice', 'voice', 'bogus'] }),
    { keyword: 'x', sender: 'ai', types: ['voice'] },
  );
  // 非法日期不抛错、不传这一项
  assert.deepEqual(
    buildSearchFilters({ keyword: 'x', dateFrom: '2026-02-30', dateTo: 'not-a-date' }),
    { keyword: 'x' },
  );
  // 只给开始日期：下界为当天 00:00；只给结束日期：上界为当天 23:59:59.999
  assert.deepEqual(
    buildSearchFilters({ keyword: '', dateFrom: '2026-11-18' }),
    { keyword: '', dateFrom: new Date(2026, 10, 18, 0, 0, 0, 0).getTime() },
  );
  assert.deepEqual(
    buildSearchFilters({ keyword: '', dateTo: '2026-11-18' }),
    { keyword: '', dateTo: new Date(2026, 10, 18, 23, 59, 59, 999).getTime() },
  );
  assert.equal(CHAT_CENTER_TYPES.length, 8, '类型多选应有文本/表情包/图片/语音/转账/礼物/引用/状态 8 项');
});

test('搜索筛选组合经真实 A 模块生效：关键词 + 发送者 + 分页 cursor，时间倒序', async () => {
  const backend = new MemoryBackend();
  await seedMessages(backend, 10);
  const first = await searchChatMessages(backend, CHAR_ID, { ...buildSearchFilters({ keyword: '你好', sender: 'me', types: [] }), limit: 3, cursor: null });
  assert.equal(first.results.length, 3);
  assert.ok(first.results.every((r) => r.sender === 'me'), '只返回我发的');
  assert.ok(first.nextCursor, '应有下一页 cursor');
  assert.deepEqual(first.results.map((r) => r.id), ['m8', 'm6', 'm4'], '时间倒序，最新在前');
  const second = await searchChatMessages(backend, CHAR_ID, { ...buildSearchFilters({ keyword: '你好', sender: 'me', types: [] }), limit: 3, cursor: first.nextCursor });
  assert.deepEqual(second.results.map((r) => r.id), ['m2', 'm0'], '我发的共 5 条，第二页剩 2 条');
});

test('搜索框防抖 300ms：连续输入只执行最后一次', async () => {
  let calls = 0;
  let lastArg = null;
  const run = debounce((v) => { calls++; lastArg = v; }, 300);
  run('你');
  run('你好');
  await sleep(120);
  run('你好吗');
  await sleep(120);
  assert.equal(calls, 0, '300ms 内不应执行');
  await sleep(220);
  assert.equal(calls, 1, '只执行最后一次');
  assert.equal(lastArg, '你好吗');
});

/* ---- 3. 搜索结果渲染：高亮与分条 ---- */

test('关键词高亮：<mark> 包住命中区间，片段先转义，重叠区间合并', () => {
  assert.equal(highlightSnippet('你好世界', [[0, 2]]), '<mark>你好</mark>世界');
  assert.equal(highlightSnippet('你好你好', [[0, 2], [1, 3]]), '<mark>你好你</mark>好', '重叠区间合并成一个 mark');
  assert.equal(highlightSnippet('a<b>&c', [{ start: 1, end: 2 }]), 'a<mark>&lt;</mark>b&gt;&amp;c', '先转义再包 mark');
  assert.equal(highlightSnippet('你好', [[0, 99]]), '<mark>你好</mark>', '超长区间夹到片段内');
  assert.equal(highlightSnippet('你好', []), '你好', '无命中不加 mark');
  assert.equal(highlightSnippet('你好', null), '你好');
});

test('相同文案分条列出：两条同文案消息各渲染一行，按真实 id 区分', () => {
  const a = searchResultItemHTML({ id: 'm1', timestamp: 1000, sender: 'me', kind: 'text', snippet: '你好', matchRanges: [[0, 2]] }, '我', '阿澈');
  const b = searchResultItemHTML({ id: 'm2', timestamp: 2000, sender: 'ai', kind: 'text', snippet: '你好', matchRanges: [[0, 2]] }, '我', '阿澈');
  assert.ok(a.includes('data-id="m1"') && b.includes('data-id="m2"'), '每条带自己的消息 id');
  assert.ok(a.includes('<mark>你好</mark>'), '命中片段高亮');
  assert.ok(a.includes('我') && b.includes('阿澈'), '发送者按我/对方显示');
});

test('日期与发送者显示：结果行有本机日期时间', () => {
  const ts = new Date('2026-11-20T10:05:00').getTime();
  assert.equal(formatChatCenterDate(ts), '2026-11-20 10:05');
  assert.equal(localDateStr(ts), '2026-11-20');
  assert.equal(senderLabel('me', '朵朵', '阿澈'), '朵朵');
  assert.equal(senderLabel('ai', '朵朵', '阿澈'), '阿澈');
});

/* ---- 4. 收藏夹：取消即时更新、保存为记忆 ---- */

test('收藏取消即时更新：unfavorite 后重查列表即去掉该条，不用刷新页面', async () => {
  const backend = new MemoryBackend();
  await seedMessages(backend, 5, { favorites: 3 });
  const before = await listFavoriteMessages(backend, CHAR_ID, { limit: FAVORITES_PAGE_SIZE });
  assert.deepEqual(before.results.map((r) => r.id), ['m2', 'm1', 'm0'], '时间倒序');
  const changed = await unfavoriteMessage(backend, 'm1');
  assert.equal(changed.isFavorite, false);
  assert.equal((await backend.get('messages', 'm1')).isFavorite, false, '落盘');
  const after = await listFavoriteMessages(backend, CHAR_ID, { limit: FAVORITES_PAGE_SIZE });
  assert.deepEqual(after.results.map((r) => r.id), ['m2', 'm0'], '重查即更新');
});

test('保存为记忆：手动调用才建，content 为消息文本，带 sourceMessageId，不碰记忆收藏', async () => {
  const backend = new MemoryBackend();
  await seedMessages(backend, 2, { favorites: 1 });
  assert.deepEqual(await backend.getAll('journals'), [], '调用前没有任何记忆被自动建');
  const msg = await backend.get('messages', 'm0');
  const journal = await saveMessageAsMemory(backend, CHAR_ID, msg, getMessageText);
  assert.equal(journal.content, '消息0 你好');
  assert.equal(journal.sourceMessageId, 'm0');
  assert.equal(journal.charId, CHAR_ID);
  assert.equal(journal.isFavorited, false, '消息收藏不等于记忆收藏的固定注入');
  assert.equal(journal.source, '聊天记录');
  const saved = await backend.getAll('journals');
  assert.equal(saved.length, 1, '只建一条');
  assert.equal(saved[0].id, journal.id);
});

test('收藏夹行有三个操作：查看上下文 / 取消收藏 / 保存为记忆', () => {
  const item = favoriteItemHTML({ id: 'm9', timestamp: 1000, sender: 'ai', kind: 'text', snippet: '你好' }, '我', '阿澈');
  assert.ok(item.includes('data-cc-act="view"') && item.includes('查看上下文'));
  assert.ok(item.includes('data-cc-act="unfav"') && item.includes('取消收藏'));
  assert.ok(item.includes('data-cc-act="save-memory"') && item.includes('保存为记忆'));
});

test('收藏页文案与记忆收藏区分：不写“固定注入”', () => {
  const openFav = appJs.slice(appJs.indexOf('function openChatFavorites'), appJs.indexOf('function buildChatFavoritesPage'));
  assert.ok(openFav.length > 0);
  const buildFav = appJs.slice(appJs.indexOf('function buildChatFavoritesPage'), appJs.indexOf('async function runChatFavorites'));
  assert.ok(buildFav.includes('与记忆收藏分开管理'), '收藏页说明与记忆收藏分开');
  assert.ok(!buildFav.includes('固定注入'), '收藏页不出现记忆收藏的“固定注入”说法');
});

/* ---- 5. 按日期查看：只有真实日期可点 ---- */

test('日期页只有真实日期可点：日历只启用有记录的日期，其余置灰不可点', () => {
  const dates = new Set(['2026-11-03', '2026-11-20', '2026-11-21']);
  const cal = buildCalendarMonth(2026, 10, dates); // 2026-11
  const flat = cal.weeks.flat().filter(Boolean);
  assert.equal(flat.length, 30, '11 月 30 天');
  assert.equal(flat.filter((c) => c.hasRecords).length, 3);
  assert.deepEqual(flat.filter((c) => c.hasRecords).map((c) => c.dateStr), ['2026-11-03', '2026-11-20', '2026-11-21']);
  assert.equal(cal.weeks.length, 6, '按周分行（11 月 1 日是周日，6 格前导 + 30 天 = 6 行）');
  assert.ok(cal.weeks.every((w) => w.length === 7), '每行 7 列');
  const htmlCal = calendarMonthHTML(cal);
  assert.ok(htmlCal.includes('data-date="2026-11-03"'), '有记录的日期是可点按钮');
  assert.ok(htmlCal.includes('data-date="2026-11-20"'));
  assert.ok(!htmlCal.includes('data-date="2026-11-04"'), '无记录的日期没有 data-date，不可点');
  assert.ok(htmlCal.includes('aria-disabled="true"'), '无记录的日期置灰标记');
});

test('月份翻页：shiftMonth 跨年正确', () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth(2026, 10, 1), { year: 2026, month: 11 });
});

/* ---- 6. jumpToMessage 定位与返回入口 ---- */

function fakeJumpEnv(backend) {
  const loaded = new Set();
  const els = new Map();
  let oldest = null;
  const findTarget = (id) => (loaded.has(id) ? els.get(id) : null);
  const loadPage = async (before) => {
    const { messages, hasMore, oldestTimestamp } = await backend.getMessagesPage(CHAR_ID, { before, limit: 50 });
    for (const m of messages) {
      loaded.add(m.id);
      if (!els.has(m.id)) {
        els.set(m.id, { id: m.id, scrolled: false, highlighted: false, scrollIntoView() { this.scrolled = true; } });
      }
    }
    oldest = oldestTimestamp;
    return { hasMore, oldest: oldestTimestamp };
  };
  return {
    loaded, els,
    findTarget,
    renderLatest: () => loadPage(Infinity),
    renderOlder: () => loadPage(oldest),
    scrollTo: (el) => el.scrollIntoView(),
    highlight: (el) => { el.highlighted = true; },
  };
}

test('jumpToMessage 定位：目标在旧页时按分页往前翻，滚动并高亮', async () => {
  const backend = new MemoryBackend();
  await seedMessages(backend, 120);
  const env = fakeJumpEnv(backend);
  let missing = 0;
  const res = await runJumpToMessage({
    backend, charId: CHAR_ID, messageId: 'm4',
    ...env, onMissing: () => { missing++; },
  });
  assert.equal(res.ok, true);
  assert.equal(res.pagesLoaded, 2, '最新 50 条 + 再翻两页才含 m4');
  assert.equal(env.els.get('m4').scrolled, true, '滚动到目标');
  assert.equal(env.els.get('m4').highlighted, true, '短暂高亮');
  assert.equal(missing, 0);
});

test('jumpToMessage 定位：目标在最新一页时不翻页；不存在的消息报 missing', async () => {
  const backend = new MemoryBackend();
  await seedMessages(backend, 120);
  const env = fakeJumpEnv(backend);
  const fresh = await runJumpToMessage({ backend, charId: CHAR_ID, messageId: 'm119', ...env, onMissing: () => {} });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.pagesLoaded, 0, '最新一页就有，不翻页');
  let missing = 0;
  const gone = await runJumpToMessage({ backend, charId: CHAR_ID, messageId: 'nope', ...env, onMissing: () => { missing++; } });
  assert.equal(gone.ok, false);
  assert.equal(gone.reason, 'missing');
  assert.equal(missing, 1);
});

test('jumpToMessage 在 app.js 内：返回入口三档齐全，定位逻辑全应用唯一', () => {
  assert.ok(appJs.includes('async function jumpToMessage(messageId, { returnTo }'), 'app.js 内新建 jumpToMessage');
  for (const label of ['← 返回搜索结果', '← 返回收藏夹', '← 返回日期查看']) {
    assert.ok(appJs.includes(label), `返回入口应有「${label}」`);
  }
  assert.ok(appJs.includes("showJumpReturnBar(returnTo)"), '定位后显示返回条');
  assert.ok(appJs.includes('openChatSearch({ restore: true })'), '返回搜索结果恢复原页');
  assert.ok(appJs.includes('openChatFavorites({ restore: true })'), '返回收藏夹恢复原页');
  assert.ok(appJs.includes('openChatDates({ restore: true })'), '返回日期查看恢复原页');
  // 全应用只有一处 scrollIntoView 定位（在 jumpToMessage 里）；横幅跳转复用它。
  const scrolls = appJs.match(/scrollIntoView\(\{ block: 'center' \}\)/g) || [];
  assert.equal(scrolls.length, 1, `应只有一处 scrollIntoView 定位，实际 ${scrolls.length} 处`);
  assert.ok(appJs.includes('await jumpToMessage(messageId)') && appJs.includes('async function openChatForBanner'),
    'openChatForBanner（原 4130 处横幅定位）改为调用 jumpToMessage，不留两套定位');
});

test('返回搜索结果恢复滚动：打开时记 scrollTop，返回时恢复、不重新搜索', () => {
  const open = appJs.slice(appJs.indexOf('function openChatSearch'), appJs.indexOf('function buildChatSearchPage'));
  assert.ok(open.includes('body.scrollTop = chatCenterState.search.scrollTop'), '返回时恢复滚动位置');
  assert.ok(open.includes('if (restore)') && open.includes('return;'), 'restore 路径直接返回，不重新搜索');
  assert.ok(open.includes('chatCenterState.search.results = []'), '非 restore 打开清空跨打开的结果缓存');
  assert.ok(open.includes('runChatSearch(true)'), '每次打开重新查');
  assert.ok(appJs.includes('st.scrollTop = body.scrollTop'), '点结果前记下滚动位置');
});

/* ---- 7. 接线与样式 ---- */

test('构建接线：chatSearch / chatDates / chatCenter 在 ORDER 里，storage 之后、app 之前', () => {
  const orderBlock = buildPreview.slice(buildPreview.indexOf('const ORDER = ['), buildPreview.indexOf('];', buildPreview.indexOf('const ORDER = [')));
  const idx = (p) => orderBlock.indexOf(`'${p}'`);
  for (const p of ['js/storage.js', 'js/chatCenter.js', 'js/chatSearch.js', 'js/chatDates.js', 'js/app.js']) {
    assert.ok(idx(p) >= 0, `ORDER 应含 ${p}`);
  }
  assert.ok(idx('js/storage.js') < idx('js/chatCenter.js'), 'chatCenter 在 storage 之后');
  assert.ok(idx('js/chatCenter.js') < idx('js/chatSearch.js'), 'chatSearch 在 chatCenter 之后');
  assert.ok(idx('js/chatDates.js') < idx('js/app.js'), 'chatDates 在 app 之前');
  assert.ok(idx('js/chatSearch.js') < idx('js/app.js'), 'chatSearch 在 app 之前');
});

test('构建接线：app.js 用原名 import A 组模块，不用别名', () => {
  const chatSearchImport = appJs.match(/^import \{[^}]*\} from '\.\/chatSearch\.js';$/m);
  assert.ok(chatSearchImport, 'app.js 应 import chatSearch.js');
  assert.ok(chatSearchImport[0].includes('searchChatMessages'), 'searchChatMessages 原名');
  assert.ok(chatSearchImport[0].includes('listFavoriteMessages'), 'listFavoriteMessages 原名');
  assert.ok(chatSearchImport[0].includes('getMessageText'), 'getMessageText 原名');
  assert.ok(!chatSearchImport[0].includes(' as '), '不得用 import 别名');
  const chatDatesImport = appJs.match(/^import \{[^}]*\} from '\.\/chatDates\.js';$/m);
  assert.ok(chatDatesImport, 'app.js 应 import chatDates.js');
  for (const name of ['getChatDates', 'dayBounds', 'messagesForDay']) {
    assert.ok(chatDatesImport[0].includes(name), `应 import ${name}`);
  }
  assert.ok(!chatDatesImport[0].includes(' as '), '不得用 import 别名');
  assert.ok(appJs.includes("from './chatCenter.js'"), 'app.js 应 import chatCenter.js');
});

test('样式：返回条 / 定位高亮 / 结果 / 日历的黑白灰规则存在', () => {
  for (const sel of ['.jump-return-bar', '.msg-jump-highlight', '.cc-result-snippet mark', '.cc-cal-day', '.cc-actions-row', '.cc-search-input', '.cc-chip', '.cc-filter-row']) {
    assert.ok(css.includes(sel), `styles.css 应有 ${sel}`);
  }
  assert.ok(css.includes('.cc-cal-day.cc-cal-has'), '有记录的日期有启用样式');
});

test('按日期跳首条：messagesForDay 第一页是当天最新，翻到最旧页才取到首条', async () => {
  const backend = new MemoryBackend();
  const base = await seedMessages(backend, 120); // 2026-11-20 10:00–11:59，全在当天
  await backend.put('messages', {
    id: 'next-day', charId: CHAR_ID, role: 'user', timestamp: base + 86_400_000,
    content: '第二天', parts: [{ type: 'text', text: '第二天' }],
  });
  // 直接取第一页会拿到当天最后一条（m119），不是首条——这正是 limit:1 的坑。
  const firstPage = await messagesForDay(backend, CHAR_ID, '2026-11-20', { limit: 1 });
  assert.equal(firstPage.results[0]?.id, 'm119', '第一页 limit:1 取到的是当天最新');
  const first = await findFirstMessageOfDay(messagesForDay, backend, CHAR_ID, '2026-11-20', { pageSize: 50 });
  assert.equal(first?.id, 'm0', '顺 cursor 翻到最旧页，首条是 m0');
  const single = await findFirstMessageOfDay(messagesForDay, backend, CHAR_ID, '2026-11-21', { pageSize: 50 });
  assert.equal(single?.id, 'next-day', '单条的日期首条就是它自己');
  const none = await findFirstMessageOfDay(messagesForDay, backend, CHAR_ID, '2026-11-22', { pageSize: 50 });
  assert.equal(none, null, '无记录的日期返回 null');
});

test('jumpToChatDate 走 findFirstMessageOfDay，不再用 limit:1 取首条', () => {
  const fn = appJs.slice(appJs.indexOf('async function jumpToChatDate'), appJs.indexOf('function startQuote'));
  assert.ok(fn.includes('findFirstMessageOfDay(messagesForDay'), '经 findFirstMessageOfDay 取首条');
  assert.ok(!fn.includes('limit: 1'), '不得再用 limit:1 当首条');
  assert.ok(fn.includes('dayBounds(dateStr)'), '仍用 dayBounds 校验当天范围');
});

test('日期页回到最新：日期页与聊天页都有“回到最新消息”入口', () => {
  assert.ok(appJs.includes('cc-dates-latest'), '日期页有回到最新消息按钮');
  assert.ok(html.includes('id="jump-latest-btn"'), '聊天页返回条里有回到最新消息按钮');
  assert.ok(appJs.includes("messageArea.scrollTop = messageArea.scrollHeight"), '回到最新跳到最后一条');
});

test('每页条数与 A 组契约一致', () => {
  assert.equal(SEARCH_PAGE_SIZE, 30);
  assert.equal(FAVORITES_PAGE_SIZE, 30);
});
