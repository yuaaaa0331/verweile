// verify-phase1.test.mjs — 第一阶段真实聊天验证的自动化检查。
// 覆盖用户 2026-11-20 的 7 项要求中能自动验证的部分；
// 需要真实 API Key / 真机 / 真实备份的项不在这里冒充通过，见 MIGRATION.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt, resolvePromptVersion } from '../js/promptBuilder.js';
import { buildRequest } from '../js/historyBuilder.js';
import { parseReplyText, segmentToMessage } from '../js/replyParser.js';
import { sendChat } from '../js/providerAdapter.js';
import { MemoryBackend } from '../js/storage.js';
import { normalizeBackup, importNormalized, exportAll, decodeBackupBytes, gzipBytes } from '../js/importExport.js';
import { fixtureCharacter, fixtureWorldBooks, fixtureStickers, globalSettings, countOccurrences } from './helpers.mjs';

/* ---------- 1. API 设置：默认导出不含密钥 ---------- */
test('1. 默认导出不含 API Key；显式勾选含 Key 的私人备份才含', async () => {
  const db = new MemoryBackend();
  await db.init();
  await db.put('settings', { key: 'api', value: { provider: 'openai', url: 'https://api.example.com', key: 'sk-secret-123', model: 'gpt-x' } });
  await db.put('settings', { key: 'apiPresets', value: [{ name: 'p1', provider: 'openai', url: 'https://api.example.com', key: 'sk-preset-999', model: 'gpt-x' }] });
  await db.put('characters', { id: 'c1', realName: '甲' });
  const def = await exportAll(db, { includeKeys: false });
  const defJson = JSON.stringify(def);
  assert.equal(defJson.includes('sk-secret-123'), false, '默认导出带出了 API Key');
  assert.equal(defJson.includes('sk-preset-999'), false, '默认导出带出了预设里的 Key');
  const priv = await exportAll(db, { includeKeys: true });
  assert.equal(JSON.stringify(priv).includes('sk-secret-123'), true, '含 Key 备份反而丢了 Key');
});

/* ---------- 3. 沿用导入的 cotSettings / 上下文 / 回覆条数 ---------- */
test('3. 导入的 cotSettings 落库并决定版本；双语／回覆条数／maxMemory 沿用导入值', async () => {
  const db = new MemoryBackend();
  await db.init();
  const raw = {
    cotSettings: { promptVersion: 'uwu', enabled: false, prefillEnabled: false },
    characters: [{
      id: 'c1', realName: '阿澈', myName: '朵朵', persona: '人设甲',
      bilingualModeEnabled: true, replyCountMin: 3, replyCountMax: 8,
      replyCountEnabled: false, maxMemory: '80', exclusivePromptVersion: '',
      worldBookIds: [], memoryJournals: [], history: [],
    }],
  };
  const norm = normalizeBackup(raw);
  assert.equal(norm.cotSettings.promptVersion, 'uwu');
  await importNormalized(db, norm, { mode: 'merge', mainCharacterId: 'c1' });
  const saved = await db.get('settings', 'cotSettings');
  assert.equal(saved.value.promptVersion, 'uwu', '导入的 cotSettings 没有保存，界面会继续写死 tt');
  const chars = await db.getAll('characters');
  const ch = chars.find((c) => c.id === 'c1');
  assert.equal(ch.bilingualModeEnabled, true);
  assert.equal(ch.replyCountMin, 3);
  assert.equal(ch.replyCountMax, 8);
  assert.equal(ch.maxMemory, '80');
  // 角色未指定专属版本 → 跟随全局 uwu；角色指定 tt → 角色优先。
  assert.equal(resolvePromptVersion(ch, { cotSettings: saved.value }), 'uwu');
  assert.equal(resolvePromptVersion({ ...ch, exclusivePromptVersion: 'tt' }, { cotSettings: saved.value }), 'tt');
  // 全局缺省仍为 tt。
  assert.equal(resolvePromptVersion(ch, {}), 'tt');
  // CoT / prefill 永不注入：提示词里没有思维链标记与预填标记。
  const sys = buildSystemPrompt(ch, { worldBooks: [], stickers: [], globalSettings: { cotSettings: saved.value } });
  assert.equal(sys.version, 'uwu');
  assert.equal(/<thinking>|\[incipere\]/.test(sys.systemPrompt), false);
});

test('3. TT 生效时：双语开启、CoT 与预填关闭；请求里不出现预填内容', () => {
  const ch = fixtureCharacter();
  const sys = buildSystemPrompt(ch, { worldBooks: fixtureWorldBooks(), stickers: fixtureStickers(), globalSettings });
  assert.equal(sys.version, 'tt');
  assert.equal(/<thinking>|\[incipere\]/.test(sys.systemPrompt), false);
  const hist = [{ id: 'u1', role: 'user', content: '[朵朵的消息：你好]', timestamp: 1000 }];
  const req = buildRequest(ch, hist, sys, { provider: 'openai' });
  const dump = JSON.stringify(req.body.messages);
  assert.equal(/\[incipere\]|<thinking>/.test(dump), false);
  // 请求里没有任何 assistant 预填消息（只有 system + user）。
  assert.deepEqual(req.body.messages.map((m) => m.role), ['system', 'user']);
});

/* ---------- 4. 只注入绑定的世界书／收藏记忆／定长近期聊天 ---------- */
test('4. 只注入绑定世界书与收藏记忆；历史按 maxMemory 截断，不发整个库', () => {
  const ch = fixtureCharacter({ maxMemory: '80' });
  const wbs = fixtureWorldBooks();
  const sys = buildSystemPrompt(ch, { worldBooks: wbs, stickers: fixtureStickers(), globalSettings });
  assert.ok(sys.systemPrompt.includes('住在同一条街'), '绑定的世界书没进提示词');
  assert.ok(!sys.systemPrompt.includes('未绑定的世界书'), '未绑定的世界书被发出去了');
  assert.ok(sys.systemPrompt.includes('我们在雨天共用一把伞'), '收藏记忆没进提示词');
  assert.ok(!sys.systemPrompt.includes('这条不该进上下文'), '未收藏记忆被发出去了');
  const hist = [];
  for (let i = 0; i < 100; i++) {
    hist.push({ id: `m${i}`, role: i % 2 ? 'user' : 'assistant', content: `[消息${i}：内容${i}]`, timestamp: 1000 + i });
  }
  const req = buildRequest(ch, hist, sys, { provider: 'openai' });
  assert.equal(req.stats.historyMessages, 80, '超过 maxMemory 的历史被发出去了');
  assert.equal(req.stats.sliced, 80);
  const dump = JSON.stringify(req.body.messages);
  assert.equal(dump.includes('内容0'), false, '第 0 条（库外旧消息）被发出去了');
  assert.equal(dump.includes('内容99'), true);
});

/* ---------- 5. 多条连发只产生一次请求；content 与 parts 不重复 ---------- */
test('5. 连续 3 条用户消息只进一次请求；content 与 parts 相同文字只发一次', () => {
  const ch = fixtureCharacter();
  const sys = buildSystemPrompt(ch, { worldBooks: [], stickers: [], globalSettings });
  const hist = [
    { id: 'm0', role: 'assistant', content: '[阿澈的消息：早]', timestamp: 500 },
    { id: 'a', role: 'user', content: '[朵朵的消息：你好]', timestamp: 1000 },
    { id: 'b', role: 'user', content: '[朵朵的消息：你在吗]', timestamp: 2000 },
    { id: 'c', role: 'user', content: '[朵朵的消息：回我]', timestamp: 3000 },
  ];
  const req = buildRequest(ch, hist, sys, { provider: 'openai' });
  const dump = JSON.stringify(req.body.messages);
  assert.equal(countOccurrences(dump, '<user_input>'), 1);
  assert.equal(countOccurrences(dump, '<chat_history>'), 1);
  // 每条原文只出现一次（合并后用换行连起来，不是重复拼接）。
  // 注意用完整协议串计数：裸词会撞上系统提示词模板里的示例（「你好呀」）。
  for (const t of ['[阿澈的消息：早]', '[朵朵的消息：你好]', '[朵朵的消息：你在吗]', '[朵朵的消息：回我]']) {
    assert.equal(countOccurrences(dump, t), 1, `${t} 出现了多次`);
  }
  // 只有最新一轮、没有更早历史时：user_input 仍为 1 次，chat_history 占位被去掉，
  // 而不是发一个空的 <chat_history></chat_history>。
  const onlyLatest = hist.slice(1);
  const req0 = buildRequest(ch, onlyLatest, sys, { provider: 'openai' });
  const dump0 = JSON.stringify(req0.body.messages);
  assert.equal(countOccurrences(dump0, '<user_input>'), 1);
  assert.equal(countOccurrences(dump0, '<chat_history>'), 0);
  // content 与 parts.text 相同：只发一次。
  const dup = [{
    id: 'd', role: 'user',
    content: '[朵朵的消息：重复文字]',
    parts: [{ type: 'text', text: '[朵朵的消息：重复文字]' }],
    timestamp: 4000,
  }];
  const req2 = buildRequest(ch, dup, sys, { provider: 'openai' });
  assert.equal(countOccurrences(JSON.stringify(req2.body.messages), '[朵朵的消息：重复文字]'), 1);
});

/* ---------- 6. 流式：拆分中文／拆分 JSON／[DONE]；停止；多气泡同 roundId ---------- */
function sseStream(chunks, signal) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

// 停止测试专用：pull 带一点延迟才给数据，模拟网络延时——
// 这样 abort 发生后，下一次 read 一定撞上已 aborted 的 signal 而拒绝；
// 同步 pull 会把下一块提前推进队列，abort 就永远观测不到（真实 fetch 是前者）。
function slowAbortableStream(chunks, signal) {
  let i = 0;
  return new ReadableStream({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 5));
      if (signal?.aborted) {
        controller.error(new DOMException('The operation was aborted', 'AbortError'));
        return;
      }
      if (i < chunks.length) controller.enqueue(chunks[i++]);
      else controller.close();
    },
  });
}

test('6. 流式回复：中文按字节拆分、JSON 行拆分、[DONE] 都能正确拼回', async () => {
  const full = 'data: {"choices":[{"delta":{"content":"你好"}}]}\n\ndata: {"choices":[{"delta":{"content":"，在呢"}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(full);
  // 在「你」的 UTF-8 字节中间切一刀（37 字节前缀后是 E4 BD A0），再在 JSON 中间切一刀。
  const cut1 = 38, cut2 = 50;
  const chunks = [bytes.slice(0, cut1), bytes.slice(cut1, cut2), bytes.slice(cut2)];
  const fakeFetch = async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: sseStream(chunks),
  });
  const deltas = [];
  const r = await sendChat(
    { provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x', streamEnabled: true },
    { messages: [{ role: 'user', content: 'hi' }] },
    { fetchImpl: fakeFetch, onDelta: (d) => deltas.push(d) },
  );
  assert.equal(r.text, '你好，在呢');
  assert.equal(deltas.join(''), '你好，在呢');
  assert.equal(r.streamed, true);
});

test('6. 停止生成：abort 后 sendChat 以 AbortError 拒绝，不再继续读流', async () => {
  const controller = new AbortController();
  // 三个事件：第一个触发 abort；第二个可能已进队列读出；第三个必须读不到，
  // 下一次 pull 看到 aborted 就以 AbortError 拒绝（真实 fetch 也是在下一次读时拒绝）。
  const full = 'data: {"choices":[{"delta":{"content":"第一段"}}]}\n\ndata: {"choices":[{"delta":{"content":"第二段"}}]}\n\ndata: {"choices":[{"delta":{"content":"第三段"}}]}\n\ndata: [DONE]\n\n';
  const bytes = new TextEncoder().encode(full);
  const ev1End = full.indexOf('\n\n') + 2;
  const ev2End = full.indexOf('\n\n', ev1End) + 2;
  const fakeFetch = async (_url, opts) => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: slowAbortableStream([bytes.slice(0, ev1End), bytes.slice(ev1End, ev2End), bytes.slice(ev2End)], opts.signal),
  });
  await assert.rejects(
    sendChat(
      { provider: 'openai', url: 'https://api.example.com', key: 'k', model: 'gpt-x', streamEnabled: true },
      { messages: [{ role: 'user', content: 'hi' }] },
      { fetchImpl: fakeFetch, signal: controller.signal, onDelta: () => controller.abort() },
    ),
    (e) => e.name === 'AbortError',
  );
});

test('6. 多气泡回复共享同一 roundId；引用段保留被引原文', () => {
  const ch = fixtureCharacter();
  const raw = '[阿澈的消息：先回一句][阿澈引用“你在吗”并回复：我在][阿澈的消息：再补一句]';
  const segs = parseReplyText(raw, ch, { allowedStickers: [] });
  assert.equal(segs.length, 3);
  const roundId = 'round_test';
  const msgs = segs.map((s) => segmentToMessage(s, ch, roundId));
  assert.ok(msgs.every((m) => m.roundId === roundId), '同一轮的气泡 roundId 不一致');
  assert.equal(msgs[1].quote.content, '你在吗');
});

/* ---------- 7. 导出 → 独立测试库重新导入，比对 ---------- */
test('7. 导出后在独立测试库重新导入：数量／ID／顺序／人设／世界书／记忆一致，不含 Key', async () => {
  const A = new MemoryBackend();
  await A.init();
  const char1 = fixtureCharacter({ id: 'char_1', persona: '人设甲', worldBookIds: ['wb1'], memoryJournals: undefined });
  const char2 = { id: 'char_2', realName: '小雨', myName: '朵朵', persona: '人设乙', bilingualModeEnabled: false, replyCountMin: 1, replyCountMax: 4, maxMemory: '40', exclusivePromptVersion: '', worldBookIds: [], memoryJournals: undefined };
  await A.put('characters', char1);
  await A.put('characters', char2);
  await A.put('worldBooks', { id: 'wb1', title: '街', content: '住在同一条街。', position: 'before', depth: 1 });
  await A.put('worldBooks', { id: 'wb2', title: '猫', content: '养了一只猫。', position: 'after', depth: 2 });
  await A.put('journals', { id: 'j1', charId: 'char_1', title: '第一次见面', content: '雨天共用一把伞。', isFavorited: true, timestamp: 100 });
  await A.put('journals', { id: 'j2', charId: 'char_1', title: '没收藏的', content: '不该进上下文。', isFavorited: false, timestamp: 200 });
  const msgs1 = [
    { id: 'm1', charId: 'char_1', role: 'user', content: '[朵朵的消息：你好]', parts: [{ type: 'text', text: '[朵朵的消息：你好]' }], timestamp: 1000 },
    { id: 'm2', charId: 'char_1', role: 'assistant', content: '[阿澈的消息：嗨]', parts: [{ type: 'text', text: '[阿澈的消息：嗨]' }], timestamp: 2000 },
    { id: 'm3', charId: 'char_1', role: 'user', content: '[朵朵的消息：撤回测试]', parts: [{ type: 'text', text: '[朵朵的消息：撤回测试]' }], timestamp: 3000, isWithdrawn: true, originalContent: '撤回测试' },
    { id: 'm4', charId: 'char_1', role: 'user', content: '[朵朵的消息：不进上下文]', parts: [{ type: 'text', text: '[朵朵的消息：不进上下文]' }], timestamp: 4000, isContextDisabled: true },
    { id: 'm5', charId: 'char_1', role: 'assistant', content: '[阿澈的消息：引用]', parts: [{ type: 'text', text: '[阿澈的消息：引用]' }], timestamp: 5000, quote: { messageId: 'm1', senderId: 'user_me', content: '你好' } },
  ];
  for (const m of msgs1) await A.put('messages', m);
  await A.put('messages', { id: 'n1', charId: 'char_2', role: 'user', content: '[朵朵的消息：嗨小雨]', parts: [{ type: 'text', text: '[朵朵的消息：嗨小雨]' }], timestamp: 1500 });
  await A.put('stickers', { id: 's1', name: '贴贴', group: '日常' });
  await A.put('settings', { key: 'api', value: { provider: 'openai', url: 'https://api.example.com', key: 'sk-roundtrip-key', model: 'gpt-x' } });

  // 导出（默认不含 Key）→ 压成 .ee → 解码 → 在全新的独立库 B 里导入。
  const exported = await exportAll(A, { includeKeys: false });
  assert.equal(JSON.stringify(exported).includes('sk-roundtrip-key'), false, '导出里带出了 Key');
  const ee = await gzipBytes(JSON.stringify(exported));
  const decoded = await decodeBackupBytes(ee);
  assert.equal(decoded.format, 'gzip');
  const norm = normalizeBackup(JSON.parse(decoded.text));
  const B = new MemoryBackend();
  await B.init();
  const report = await importNormalized(B, norm, { mode: 'merge', mainCharacterId: 'char_1' });
  assert.equal(report.added.messages, 6, `消息数不对：${JSON.stringify(report.added)}`);

  const bChars = await B.getAll('characters');
  assert.equal(bChars.length, 2);
  const b1 = bChars.find((c) => c.id === 'char_1');
  assert.equal(b1.persona, '人设甲');
  assert.equal(b1.bilingualModeEnabled, true);
  assert.equal(b1.replyCountMin, 3);
  assert.equal(b1.maxMemory, '80');
  const bMsgs1 = await B.getAllMessages('char_1');
  assert.deepEqual(bMsgs1.map((m) => m.id), ['m1', 'm2', 'm3', 'm4', 'm5'], '消息 ID 或顺序变了');
  assert.equal(bMsgs1[2].isWithdrawn, true);
  assert.equal(bMsgs1[3].isContextDisabled, true);
  assert.equal(bMsgs1[4].quote.content, '你好');
  assert.equal((await B.getAllMessages('char_2')).length, 1);
  const bWbs = await B.getAll('worldBooks');
  assert.deepEqual(bWbs.map((w) => w.id).sort(), ['wb1', 'wb2']);
  assert.equal(bWbs.find((w) => w.id === 'wb1').content, '住在同一条街。');
  const bJournals = (await B.getAll('journals')).filter((j) => j.charId === 'char_1');
  assert.equal(bJournals.length, 2);
  assert.equal(bJournals.find((j) => j.id === 'j1').isFavorited, true);
  assert.equal(bJournals.find((j) => j.id === 'j2').isFavorited, false);
  // 独立库 B 里没有凭据落库。
  assert.equal(await B.get('settings', 'api'), null);
});
