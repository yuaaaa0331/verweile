// vectorMemory.test.mjs — 向量记忆（D 索引 / E 检索 / F 管理与可验证性）。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fnv1aHex, chunkMemoryText, spaceKeyFor, cosineSimilarity, rankCandidates,
  dedupeAgainstFavorited, applyTokenBudget, buildRetrievalQueryText,
  buildChunkRecords, journalRetrievable, indexJournals, deleteJournalIndex,
  getIndexStatus, getChunksForSpace, retrieveFromIndex, DEFAULT_VECTOR_SETTINGS,
  indexDocuments, buildExperienceChunkRecords, buildDocumentChunkRecords,
  documentRetrievable, rrfFuse, RRF_K, fusedRetrieve,
  retrieveVectorCandidates, syncDocumentIndexes, deleteDocumentIndexes,
  groupMessagesIntoRounds, getNeighborContext, collectNeighborsForResults,
} from '../js/vectorMemory.js';
import { buildKeywordIndex, searchKeyword } from '../js/keywordSearch.js';
import { createExperienceRecord, markExperienceInvalid, planOutcomeLabel } from '../js/experiences.js';
import { MemoryBackend, DB_VERSION, ensureVectorStores } from '../js/storage.js';
import { buildSystemPrompt } from '../js/promptBuilder.js';
import { parseReplyText } from '../js/replyParser.js';
import { exportAll } from '../js/importExport.js';
import { fixtureCharacter, globalSettings, countOccurrences } from './helpers.mjs';

/**
 * 桩向量（仅测试用，不是真实模型）：单字哈希到 128 维并归一化。
 * 余弦反映字面重叠程度；真实 embedding 的相似度分布与它不同，
 * 所以阈值默认值 0.40 只对桩数据实测有效，换模型后必须用「测试召回」校准。
 */
export function stubVector(text, dim = 128) {
  const v = new Array(dim).fill(0);
  for (const ch of String(text || '').replace(/\s+/g, '')) {
    let h = 5381;
    for (const c of ch) h = ((h << 5) + h + c.codePointAt(0)) >>> 0;
    v[h % dim] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}
const stubEmbed = async (texts) => ({ vectors: texts.map((t) => stubVector(t)), dimensions: 128 });

const SPACE = spaceKeyFor({ baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small', dimensions: 128 });

/* ---------- 分段 + 哈希 ---------- */
test('分段：≤600 字一段、重叠约 80 字、每段附标题+日期', () => {
  const content = '海'.repeat(1300);
  const chunks = chunkMemoryText({ title: '海边', content, timestamp: Date.parse('2026-11-01T10:00:00') });
  assert.equal(chunks.length, 3);
  for (const c of chunks) assert.ok(c.body.length <= 600, `段长 ${c.body.length} 超过 600`);
  assert.equal(chunks[1].body.slice(0, 80), chunks[0].body.slice(-80), '相邻段没有 80 字重叠');
  assert.match(chunks[0].text, /标题：海边/);
  assert.match(chunks[0].text, /日期：2026-11-01/);
  assert.equal(chunkMemoryText({ title: '短', content: '一句话' }).length, 1);
  assert.deepEqual(chunkMemoryText({ title: '空', content: '   ' }), []);
});

test('哈希：同内容同哈希、改一字哈希变', () => {
  assert.equal(fnv1aHex('我们在雨天共用一把伞'), fnv1aHex('我们在雨天共用一把伞'));
  assert.notEqual(fnv1aHex('我们在雨天共用一把伞'), fnv1aHex('我们在雨天共用两把伞'));
  const a = chunkMemoryText({ title: 't', content: 'abc' })[0].hash;
  const b = chunkMemoryText({ title: 't', content: 'abd' })[0].hash;
  assert.notEqual(a, b);
});

/* ---------- 余弦相似度 ---------- */
test('余弦：相同向量 1、相反 -1、正交 0、零向量 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0);
  assert.ok(Math.abs(cosineSimilarity([1, 2, 3], [1, 2, 3]) - 1) < 1e-12);
});

/* ---------- 索引空间键 ---------- */
test('空间键：换模型 / 换维度 / 换 baseUrl 都换空间；同配置同键', () => {
  const base = { baseUrl: 'https://api.example.com/v1', model: 'text-embedding-3-small', dimensions: 1536 };
  assert.equal(spaceKeyFor(base), spaceKeyFor({ ...base, baseUrl: 'https://api.example.com/v1/' }));
  assert.equal(spaceKeyFor(base), spaceKeyFor({ ...base, baseUrl: 'https://api.example.com' }));
  assert.notEqual(spaceKeyFor(base), spaceKeyFor({ ...base, model: 'text-embedding-ada-002' }));
  assert.notEqual(spaceKeyFor(base), spaceKeyFor({ ...base, dimensions: 512 }));
  assert.notEqual(spaceKeyFor(base), spaceKeyFor({ ...base, baseUrl: 'https://other.example.com/v1' }));
  // 维度相同但模型不同也绝不能混用
  assert.notEqual(
    spaceKeyFor({ baseUrl: 'https://a.example.com', model: 'model-a', dimensions: 128 }),
    spaceKeyFor({ baseUrl: 'https://a.example.com', model: 'model-b', dimensions: 128 }),
  );
});

/* ---------- 阈值实测（桩数据） ---------- */
test('阈值实测：桩向量下 0.40 能分开相关 / 不相关（相关 ≥0.546，不相关 ≤0.355）', () => {
  const related = [
    ['我们上周去海边约好下周再去', '上周在海边约好了下周再见面'],
    ['第一次见面是在雨天共用一把伞', '雨天第一次见面时我们共用一把伞'],
    ['他不喜欢吃香菜', '他讨厌香菜，从来不吃'],
    ['养了一只叫咪咪的猫', '家里的猫叫咪咪'],
    ['我们约好下周六一起去看电影', '下周六一起去看电影的约定还记得吗'],
    ['她最喜欢喝奶茶', '她最爱喝的饮料是奶茶'],
  ];
  const unrelated = [
    ['我们上周去海边约好下周再去', '今天的数学作业很难'],
    ['第一次见面是在雨天共用一把伞', '公司下周要开会讨论预算'],
    ['他不喜欢吃香菜', '明天天气预报有雨'],
    ['养了一只叫咪咪的猫', '手机没电了需要充电'],
    ['我们约好下周六一起去看电影', '请把会议纪要发给我'],
    ['她最喜欢喝奶茶', '服务器今天早上宕机了'],
  ];
  const relScores = related.map(([a, b]) => cosineSimilarity(stubVector(a), stubVector(b)));
  const unrelScores = unrelated.map(([a, b]) => cosineSimilarity(stubVector(a), stubVector(b)));
  const relMin = Math.min(...relScores);
  const unrelMax = Math.max(...unrelScores);
  // 分界点：相关组最低 0.546，不相关组最高 0.355，默认值 0.40 落在两者之间。
  assert.ok(relMin > 0.40, `相关组最低 ${relMin.toFixed(3)}，应高于阈值 0.40`);
  assert.ok(unrelMax < 0.40, `不相关组最高 ${unrelMax.toFixed(3)}，应低于阈值 0.40`);
  assert.ok(relMin > unrelMax, '相关与不相关两组在桩数据下没有重叠');
  assert.equal(DEFAULT_VECTOR_SETTINGS.threshold, 0.40, '默认值必须与实测分界一致');
  assert.equal(DEFAULT_VECTOR_SETTINGS.topK, 5);
});

/* ---------- 阈值实测（真实查询组装） ---------- */
// 无碰撞的字面余弦（按字计数，不哈希）：只用来复核不相关组——桩向量是单字哈希
// 128 维，长查询下不同字撞进同一维会把不相关句虚顶到 0.485，与真实相似无关。
function literalCosine(a, b) {
  const counts = (t) => {
    const m = new Map();
    for (const ch of String(t || '').replace(/\s+/g, '')) m.set(ch, (m.get(ch) || 0) + 1);
    return m;
  };
  const va = counts(a), vb = counts(b);
  let dot = 0;
  for (const [k, v] of va) if (vb.has(k)) dot += v * vb.get(k);
  return dot / (Math.hypot(...va.values()) * Math.hypot(...vb.values()) || 1);
}

test('阈值实测（真实查询组装）：加权后近乎原文的查询在 0.40 召回；只降阈值不够', () => {
  // 查询侧用真实组装（最新发言 + 最近 2 轮对话，见 retrieveForChat）；
  // 索引侧用真实分段文本（标题 + 日期头 + 正文，buildChunkRecords 产出）。
  // 最近 2 轮取与记忆/查询都无关的日常寒暄，隔离出「拼长稀释」本身的影响。
  const NEUTRAL_RECENT = ['在干嘛呢', '刚吃完饭', '今天有点累', '早点休息吧'];
  const chunkText = (title, body) => buildChunkRecords(
    { id: 'jx', title, content: body, timestamp: Date.parse('2026-11-01T10:00:00') },
    'char_1', SPACE,
  )[0].text;
  // 相关组：记忆句改成问句，近乎原文（种子句即第一组）。
  const related = [
    ['海边约定', '上周去海边约好下周再去。', '我们上周去海边约好下周再去吗？'],
    ['第一次见面', '第一次见面是在雨天共用一把伞。', '我们第一次见面是在雨天共用一把伞吗？'],
    ['香菜', '他不喜欢吃香菜。', '他不喜欢吃香菜吗？'],
    ['猫咪咪', '养了一只叫咪咪的猫。', '养了一只叫咪咪的猫吗？'],
    ['电影约定', '我们约好下周六一起去看电影。', '我们约好下周六一起去看电影吗？'],
    ['奶茶', '她最喜欢喝奶茶。', '她最喜欢喝奶茶吗？'],
  ];
  const unrelated = [
    ['海边约定', '上周去海边约好下周再去。', '今天的数学作业很难'],
    ['第一次见面', '第一次见面是在雨天共用一把伞。', '公司下周要开会讨论预算'],
    ['香菜', '他不喜欢吃香菜。', '明天天气预报有雨'],
    ['猫咪咪', '养了一只叫咪咪的猫。', '手机没电了需要充电'],
    ['电影约定', '我们约好下周六一起去看电影。', '请把会议纪要发给我'],
    ['奶茶', '她最喜欢喝奶茶。', '服务器今天早上宕机了'],
  ];
  const score = (title, body, query) => cosineSimilarity(stubVector(query), stubVector(chunkText(title, body)));
  // 不加权（旧组装：最新发言只出现一次）：相关组 0.342–0.596，最低 0.342，
  // 单把阈值降到 0.40 也召回不了最短的那几条——所以只降阈值不够。
  const unweighted = related.map(([t, b, q]) =>
    score(t, b, `最近对话：${NEUTRAL_RECENT.join(' / ')}\n最新发言：${q}`));
  assert.ok(Math.min(...unweighted) < 0.40, `不加权相关组最低 ${Math.min(...unweighted).toFixed(3)}，应低于 0.40（否则加权是多余的）`);
  // 加权（新组装：最新发言重复一次）：相关组 0.436–0.664，全部高于 0.40。
  const relScores = related.map(([t, b, q]) => score(t, b, buildRetrievalQueryText(q, NEUTRAL_RECENT)));
  const relMin = Math.min(...relScores);
  assert.ok(relMin > 0.40, `加权后相关组最低 ${relMin.toFixed(3)}，应高于阈值 0.40`);
  assert.ok(Math.max(...relScores) > relMin, '相关组应有分数分布');
  // 种子句专项：验证报告里的原句，加权后 0.561，稳定高于阈值。
  const seed = score('海边约定', '上周去海边约好下周再去。',
    buildRetrievalQueryText('我们上周去海边约好下周再去吗？', NEUTRAL_RECENT));
  assert.ok(seed > 0.45, `种子句加权后 ${seed.toFixed(3)}，应稳定高于 0.45`);
  // 不相关组：桩向量下个别虚高到 0.485（单字哈希碰撞），不作为分界依据；
  // 用无碰撞的字面余弦复核：不相关组最高 0.127，相关组最低 0.373，两组分开。
  const queries = related.map(([, , q]) => buildRetrievalQueryText(q, NEUTRAL_RECENT));
  const litRelMin = Math.min(...related.map(([t, b], i) => literalCosine(queries[i], chunkText(t, b))));
  const litUnrelMax = Math.max(...unrelated.map(([t, b, q]) =>
    literalCosine(buildRetrievalQueryText(q, NEUTRAL_RECENT), chunkText(t, b))));
  assert.ok(litRelMin > 0.30, `字面余弦相关组最低 ${litRelMin.toFixed(3)}，应高于 0.30`);
  assert.ok(litUnrelMax < 0.20, `字面余弦不相关组最高 ${litUnrelMax.toFixed(3)}，应低于 0.20`);
  assert.ok(litRelMin > litUnrelMax, '字面余弦下相关与不相关两组没有重叠');
  assert.equal(DEFAULT_VECTOR_SETTINGS.threshold, 0.40, '默认值必须与实测分界一致');
});

/* ---------- 检索排序去重 ---------- */
test('检索排序去重：按分数降序、同一记忆只留最高一段、低于阈值不要', () => {
  const q = stubVector('海边约会');
  const entries = [
    { journalId: 'j1', vector: stubVector('海边约会') },
    { journalId: 'j1', vector: stubVector('海边散步') },
    { journalId: 'j2', vector: stubVector('完全无关的服务器故障') },
    { journalId: 'j3', vector: stubVector('海边看日落') },
  ];
  const out = rankCandidates(q, entries, { topK: 5, threshold: 0.45 });
  assert.ok(out.length >= 1);
  assert.equal(new Set(out.map((o) => o.journalId)).size, out.length, '同一记忆出现了两次');
  assert.equal(out[0].journalId, 'j1');
  for (let i = 1; i < out.length; i++) assert.ok(out[i - 1].score >= out[i].score, '不是按分数降序');
  assert.ok(out.every((o) => o.score >= 0.45));
});

test('去重：固定注入与召回同一记忆 ID 只出现一次（promptBuilder 层）', () => {
  const ch = fixtureCharacter();
  const sys = buildSystemPrompt(ch, {
    worldBooks: [], stickers: [], globalSettings,
    relatedMemories: [
      { journalId: 'j1', title: '第一次见面', content: '我们在雨天共用一把伞。', source: '手动记录', date: '2026-11-01', sourceStatus: 'sourced' },
      { journalId: 'j3', title: '海边约定', content: '下周去海边', source: '手动记录', date: '2026-11-02', sourceStatus: 'sourced' },
    ],
  });
  // j1 已是收藏记忆（固定注入），召回里重复的同一条不应再出现第二次。
  assert.equal(countOccurrences(sys.systemPrompt, '我们在雨天共用一把伞'), 1);
  assert.ok(sys.systemPrompt.includes('下周去海边'), '召回的非收藏记忆应进入相关记忆区');
  assert.ok(sys.systemPrompt.includes('日期：2026-11-02'), '召回记忆应保留日期');
  assert.ok(sys.systemPrompt.includes('仅供参考'), '召回记忆应注明仅作历史参考');
  const deduped = dedupeAgainstFavorited(
    [{ journalId: 'j1' }, { journalId: 'j3' }], ['j1'],
  );
  assert.deepEqual(deduped.map((d) => d.journalId), ['j3']);
});

test('Token 预算：超出时按排名取，至少保留第一条（截断）', () => {
  const items = [
    { journalId: 'a', content: '甲'.repeat(100) },
    { journalId: 'b', content: '乙'.repeat(100) },
    { journalId: 'c', content: '丙'.repeat(100) },
  ];
  const out = applyTokenBudget(items, 150);
  assert.ok(out.length >= 1 && out.length < 3);
  assert.equal(out[0].journalId, 'a');
  const tiny = applyTokenBudget(items, 10);
  assert.equal(tiny.length, 1);
  assert.equal(tiny[0].truncated, true);
});

/* ---------- 迁移：v1→v2 ---------- */
test('迁移：v1 库（只有旧表）升到 v2 只新增 vectorChunks 表，旧表不动', () => {
  const created = [];
  const stores = new Set(['characters', 'journals', 'messages', 'settings', 'unknown']);
  const fakeDb = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (name, opts) => {
      stores.add(name);
      const idx = [];
      created.push(name);
      return { createIndex: (iname) => idx.push(iname), _idx: idx };
    },
  };
  ensureVectorStores(fakeDb);
  assert.deepEqual(created, ['vectorChunks']);
  assert.ok(stores.has('journals'), '旧表被动了');
  assert.ok(stores.has('characters'));
  // 再跑一次不重复建
  created.length = 0;
  ensureVectorStores(fakeDb);
  assert.deepEqual(created, []);
  assert.equal(DB_VERSION, 4, '当前库版本已升到 v4（v3→v4 只新增 wakeScenes / wakeAlarms / wakeReceipts 表，见 b-group.test.mjs）');
});

test('MemoryBackend 有 vectorChunks 表，可读写', async () => {
  const db = new MemoryBackend();
  await db.init();
  await db.put('vectorChunks', { id: 'j1:c0', journalId: 'j1', charId: 'c1', spaceKey: SPACE, vector: [1, 0] });
  assert.equal((await db.getVectorChunks('c1', SPACE)).length, 1);
  assert.equal((await db.getVectorChunks('c1', 'other|m|1')).length, 0);
});

/* ---------- 索引编排 ---------- */
function journalsFixture() {
  return [
    { id: 'j1', charId: 'char_1', title: '第一次见面', content: '我们在雨天共用一把伞。', source: '手动记录', timestamp: 1000, isFavorited: true },
    { id: 'j2', charId: 'char_1', title: '海边约定', content: '上周去海边约好下周再去。', source: '手动记录', timestamp: 2000 },
    { id: 'j3', charId: 'char_1', title: '长记忆', content: '猫'.repeat(1300), source: '手动记录', timestamp: 3000 },
  ];
}

test('建索引：分段入库、内容未变复用向量、编辑更新、删除清理、空间隔离', async () => {
  const db = new MemoryBackend();
  await db.init();
  const journals = journalsFixture();
  let calls = 0;
  const countingEmbed = async (texts) => { calls += texts.length; return stubEmbed(texts); };
  const run = (list) => indexJournals({
    backend: db, charId: 'char_1', journals: list, spaceKey: SPACE, embedTexts: countingEmbed,
  });
  const r1 = await run(journals);
  assert.equal(r1.total, 1 + 1 + 3, 'j3 长记忆应切成 3 段');
  assert.equal(r1.embedded, 5);
  assert.equal(calls, 5);
  // 第二次跑：哈希相同，全部复用，不再调接口
  const r2 = await run(journals);
  assert.equal(r2.embedded, 0);
  assert.equal(calls, 5);
  // 编辑 j2：只重建 j2 的段
  const edited = journals.map((j) => (j.id === 'j2' ? { ...j, content: '改成去山里看星星的约定。' } : j));
  const r3 = await run(edited);
  assert.equal(r3.embedded, 1);
  assert.equal(calls, 6);
  const chunks = await getChunksForSpace(db, 'char_1', SPACE);
  assert.equal(chunks.filter((c) => c.journalId === 'j2').length, 1);
  assert.ok(chunks.find((c) => c.journalId === 'j2').body.includes('山里看星星'));
  // 换空间查不到
  assert.equal((await getChunksForSpace(db, 'char_1', spaceKeyFor({ baseUrl: 'https://api.example.com/v1', model: 'other-model', dimensions: 128 }))).length, 0);
  // 删除记忆清理对应索引
  await deleteJournalIndex(db, 'j1');
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).filter((c) => c.journalId === 'j1').length, 0);
  assert.ok((await getChunksForSpace(db, 'char_1', SPACE)).length > 0, '删除一条不应清掉其他记忆的索引');
});

test('删除普通记忆：journals 与 vectorChunks 里对应记录都消失，其他记忆不受影响', async () => {
  const db = new MemoryBackend();
  await db.init();
  const journals = journalsFixture(); // j2 是普通（非总结、未收藏）记忆
  for (const j of journals) await db.put('journals', j);
  await indexJournals({ backend: db, charId: 'char_1', journals, spaceKey: SPACE, embedTexts: stubEmbed });
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).filter((c) => c.journalId === 'j2').length, 1);
  // 模拟记忆页删除普通记忆的流程：删 journals 记录 → 清理对应向量段。
  await db.delete('journals', 'j2');
  await deleteJournalIndex(db, 'j2');
  assert.equal((await db.getAll('journals')).find((j) => j.id === 'j2'), undefined, 'journals 里还留着已删的普通记忆');
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).filter((c) => c.journalId === 'j2').length, 0, 'vectorChunks 里还留着已删记忆的段');
  assert.ok((await db.getAll('journals')).some((j) => j.id === 'j1'), '删除一条不应删掉其他记忆');
  assert.ok((await getChunksForSpace(db, 'char_1', SPACE)).some((c) => c.journalId === 'j1'), '删除一条不应清掉其他记忆的索引');
  assert.ok((await getChunksForSpace(db, 'char_1', SPACE)).some((c) => c.journalId === 'j3'), '长记忆的段应保留');
});

test('索引状态：恢复备份后（只有记忆、没有索引段）显示真实缺失，不造假', async () => {
  const db = new MemoryBackend();
  await db.init();
  const journals = journalsFixture();
  const st0 = await getIndexStatus(db, 'char_1', journals, SPACE);
  assert.equal(st0.indexedChunks, 0);
  assert.equal(st0.missing, 5);
  assert.equal(st0.totalChunks, 5);
  await indexJournals({ backend: db, charId: 'char_1', journals, spaceKey: SPACE, embedTexts: stubEmbed });
  const st1 = await getIndexStatus(db, 'char_1', journals, SPACE);
  assert.equal(st1.missing, 0);
  assert.equal(st1.indexedChunks, 5);
  assert.deepEqual(st1.spaces, [{ spaceKey: SPACE, count: 5 }]);
});

test('取消与进度：取消后按已保存进度继续（已建的段不丢失）', async () => {
  const db = new MemoryBackend();
  await db.init();
  const journals = journalsFixture();
  const saved = [];
  const signal = { cancelled: false };
  // 批大小 2：第一批后取消，第二批不跑
  const r = await indexJournals({
    backend: db, charId: 'char_1', journals, spaceKey: SPACE, embedTexts: stubEmbed,
    batchSize: 2, saveProgress: async (p) => saved.push({ ...p }),
    signal,
    onProgress: (p) => { if (p.done >= 2) signal.cancelled = true; },
  });
  assert.equal(r.cancelled, true);
  assert.ok((await getChunksForSpace(db, 'char_1', SPACE)).length >= 2, '取消前建好的段应保留');
  assert.ok(saved.length > 0 && saved.at(-1).status === 'paused');
  // 继续跑：补齐剩余
  const r2 = await indexJournals({
    backend: db, charId: 'char_1', journals, spaceKey: SPACE, embedTexts: stubEmbed,
    batchSize: 2, signal: { cancelled: false },
  });
  assert.equal(r2.cancelled, false);
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).length, 5);
});

/* ---------- 聊天召回 ---------- */
test('聊天召回：只召回当前角色、当前空间、参与检索的记忆；不参与检索的排除', async () => {
  const db = new MemoryBackend();
  await db.init();
  const journals = [
    { id: 'j1', charId: 'char_1', title: '雨天见面', content: '我们在雨天共用一把伞。', source: '手动记录', timestamp: 1000 },
    { id: 'j2', charId: 'char_1', title: '海边约定', content: '上周去海边约好下周再去。', source: '手动记录', timestamp: 2000 },
    { id: 'j3', charId: 'char_1', title: '不参与', content: '海边看日落很美。', source: '手动记录', timestamp: 3000, retrievalEnabled: false },
    { id: 'j9', charId: 'char_2', title: '别人的', content: '海边约好下周再去。', source: '手动记录', timestamp: 4000 },
  ];
  await indexJournals({ backend: db, charId: 'char_1', journals, spaceKey: SPACE, embedTexts: stubEmbed });
  // 另一个角色的记忆即使内容相同也不应进当前角色的索引
  await indexJournals({ backend: db, charId: 'char_2', journals: [journals[3]], spaceKey: SPACE, embedTexts: stubEmbed });
  const byId = new Map(journals.map((j) => [j.id, j]));
  const out = await retrieveFromIndex({
    backend: db, charId: 'char_1', spaceKey: SPACE,
    queryVector: stubVector('上周去海边约了什么'),
    journalsById: byId, topK: 5, threshold: 0.45, tokenBudget: 1500, favoritedIds: [],
  });
  assert.ok(out.length >= 1);
  assert.equal(out[0].journalId, 'j2', '最相关的应是海边约定');
  assert.ok(!out.some((o) => o.journalId === 'j3'), '不参与检索的记忆被召回了');
  assert.ok(!out.some((o) => o.journalId === 'j9'), '其他角色的记忆被召回了');
  assert.ok(out.every((o) => o.score >= 0.45));
});

test('检索查询文本：最新发言 + 最近对话拼在一起，最新发言重复一次加权', () => {
  const q = buildRetrievalQueryText('那次约了什么', ['上周去海边', '约好下周再去']);
  assert.match(q, /那次约了什么/);
  assert.match(q, /上周去海边/);
  // 加权：有最近对话时最新发言出现两次；没有时只出现一次，不重复。
  assert.equal(q.split('那次约了什么').length - 1, 2, '最新发言应在查询里出现两次');
  assert.equal(buildRetrievalQueryText('只问一句', []), '只问一句');
  assert.equal(journalRetrievable({}), true, '老记忆缺字段时默认参与检索');
  assert.equal(journalRetrievable({ retrievalEnabled: false }), false);
  assert.equal(buildChunkRecords({ id: 'j1', title: 't', content: 'x' }, 'c1', SPACE)[0].spaceKey, SPACE);
});

/* ---------- 导出 ---------- */
test('导出：记忆文字可导出恢复；默认导出不含 embeddingApi / summaryApi 的 Key', async () => {
  const db = new MemoryBackend();
  await db.init();
  await db.put('characters', { id: 'c1', realName: '甲' });
  await db.put('journals', { id: 'j1', charId: 'c1', title: '雨天', content: '共用一把伞', isFavorited: true, retrievalEnabled: true, timestamp: 100 });
  await db.put('settings', { key: 'embeddingApi', value: { provider: 'openai', url: 'https://api.example.com', key: 'sk-emb-123', model: 'text-embedding-3-small' } });
  await db.put('settings', { key: 'summaryApi', value: { provider: 'openai', url: 'https://api.example.com', key: 'sk-sum-456', model: 'gpt-x' } });
  const out = await exportAll(db, { includeKeys: false });
  const dump = JSON.stringify(out);
  assert.equal(dump.includes('sk-emb-123'), false, '默认导出带出了向量 API 的 Key');
  assert.equal(dump.includes('sk-sum-456'), false, '默认导出带出了总结副 API 的 Key');
  assert.ok(dump.includes('共用一把伞'), '记忆文字没有随备份导出');
  assert.ok(dump.includes('雨天'));
  const priv = await exportAll(db, { includeKeys: true });
  assert.equal(JSON.stringify(priv).includes('sk-emb-123'), true, '含 Key 备份反而丢了向量 Key');
});

/* ---------- 附带小修：语音 / 照片协议认 myName ---------- */
test('replyParser：语音与照片描述协议认 myName（面板发出）与 realName', () => {
  const ch = fixtureCharacter(); // realName 阿澈，myName 朵朵
  const voiceMine = parseReplyText('[朵朵的语音：晚安啦]', ch);
  assert.equal(voiceMine[0]?.kind, 'voice');
  assert.equal(voiceMine[0]?.body, '晚安啦');
  const photoMine = parseReplyText('[朵朵发来的照片/视频：海边的日落]', ch);
  assert.equal(photoMine[0]?.kind, 'photo');
  assert.equal(photoMine[0]?.body, '海边的日落');
  const voiceHis = parseReplyText('[阿澈的语音：晚安啦]', ch);
  assert.equal(voiceHis[0]?.kind, 'voice');
  const photoHis = parseReplyText('[阿澈发来的照片/视频：窗外的晚霞]', ch);
  assert.equal(photoHis[0]?.kind, 'photo');
});

/* ================= 第 2 波：经历进向量索引 / RRF 融合 / 邻居补全 / 索引同步 ================= */

const CHAR = { id: 'char_1', realName: '阿澈', myName: '朵朵' };
function expFixture(over = {}) {
  return createExperienceRecord({
    charId: 'char_1', title: '海边之约', summary: '约好下周六去海边看日落。',
    quotes: [{ text: '下周六去海边吧', messageId: 'm2', speaker: '朵朵' }],
    timestamp: 2000, ...over,
  });
}
async function setupFusedDb({ withKeyword = true } = {}) {
  const db = new MemoryBackend();
  await db.init();
  const journals = [
    { id: 'j1', charId: 'char_1', title: '雨天见面', content: '我们在雨天共用一把伞。', source: '手动记录', timestamp: 1000 },
    { id: 'j2', charId: 'char_1', title: '海边约定', content: '上周去海边约好下周再去。', source: '手动记录', timestamp: 2000 },
  ];
  const experiences = [expFixture()];
  for (const j of journals) await db.put('journals', j);
  for (const e of experiences) await db.put('experiences', e);
  if (withKeyword) await buildKeywordIndex(db, 'char_1', [...journals, ...experiences]);
  await indexDocuments({
    backend: db, charId: 'char_1',
    documents: [...journals, ...experiences], spaceKey: SPACE, embedTexts: stubEmbed,
  });
  return { db, journals, experiences };
}

test('RRF 融合：只按排名，score = Σ 1/(60+rank)，k=60 可验证；不混原始分数', () => {
  assert.equal(RRF_K, 60);
  const fused = rrfFuse(
    [{ docId: 'a', rank: 1, score: 99 }, { docId: 'b', rank: 2, score: 0.1 }],
    [{ docId: 'a', rank: 2, score: 0.5 }, { docId: 'c', rank: 1, score: 0.9 }],
  );
  // 两路原始分数量纲不同（99 / 0.5 / 0.9）：融合分只看排名，与原始分数无关。
  const a = fused.get('a');
  assert.equal(a.keywordRank, 1);
  assert.equal(a.vectorRank, 2);
  assert.ok(Math.abs(a.score - (1 / 61 + 1 / 62)) < 1e-12, `a 的融合分应为 1/61+1/62，实际 ${a.score}`);
  const b = fused.get('b');
  assert.equal(b.keywordRank, 2);
  assert.equal(b.vectorRank, null, 'b 只在关键词路命中，向量 rank 应为 null');
  assert.ok(Math.abs(b.score - 1 / 62) < 1e-12);
  const c = fused.get('c');
  assert.equal(c.keywordRank, null);
  assert.equal(c.vectorRank, 1);
  assert.ok(Math.abs(c.score - 1 / 61) < 1e-12);
  // rank 缺省时按列表顺序补 1、2、3……
  const d = rrfFuse([{ docId: 'x' }, { docId: 'y' }], []);
  assert.ok(Math.abs(d.get('x').score - 1 / 61) < 1e-12);
  assert.ok(Math.abs(d.get('y').score - 1 / 62) < 1e-12);
});

test('经历进向量索引：chunk 复用 journalId 存经历 id、kind=experience、id 格式不变；编辑重算、删除清理', async () => {
  const db = new MemoryBackend();
  await db.init();
  const exp = expFixture();
  const recs = buildExperienceChunkRecords(exp, 'char_1', SPACE);
  assert.equal(recs.length, 1);
  assert.equal(recs[0].id, `${exp.id}:c0`, '经历 chunk id 格式必须与记忆一致');
  assert.equal(recs[0].journalId, exp.id);
  assert.equal(recs[0].kind, 'experience');
  assert.ok(recs[0].body.includes('下周六去海边吧'), '经历 chunk 正文应含关键原话');
  // 老 chunk 缺 kind 字段时视为 journal（buildDocumentChunkRecords 缺省）
  assert.equal(buildDocumentChunkRecords({ id: 'j1', title: 't', content: 'x' }, 'char_1', SPACE)[0].kind, 'journal');

  const journals = [{ id: 'j1', charId: 'char_1', title: '雨天', content: '雨天共用一把伞。', timestamp: 1000 }];
  let calls = 0;
  const counting = async (texts) => { calls += texts.length; return stubEmbed(texts); };
  const r1 = await indexDocuments({
    backend: db, charId: 'char_1', documents: [...journals, exp], spaceKey: SPACE, embedTexts: counting,
  });
  assert.equal(r1.total, 2);
  assert.equal(r1.embedded, 2);
  // 第二次跑：哈希相同，全部复用
  const r2 = await indexDocuments({
    backend: db, charId: 'char_1', documents: [...journals, exp], spaceKey: SPACE, embedTexts: counting,
  });
  assert.equal(r2.embedded, 0);
  assert.equal(calls, 2);
  // 编辑经历：只重建经历的段，记忆的段复用
  const edited = { ...exp, summary: '改成去山里看星星。', quotes: [{ text: '去山里看星星吧', messageId: 'm2', speaker: '朵朵' }] };
  const r3 = await indexDocuments({
    backend: db, charId: 'char_1', documents: [...journals, edited], spaceKey: SPACE, embedTexts: counting,
  });
  assert.equal(r3.embedded, 1);
  assert.equal(calls, 3);
  const chunks = await getChunksForSpace(db, 'char_1', SPACE);
  assert.ok(chunks.find((c) => c.journalId === exp.id).body.includes('山里看星星'));
  // 失效经历不进索引
  const invalid = { ...exp, status: 'invalid' };
  assert.equal(documentRetrievable(invalid), false);
  const r4 = await indexDocuments({
    backend: db, charId: 'char_1', documents: [...journals, invalid], spaceKey: SPACE, embedTexts: counting,
  });
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).filter((c) => c.journalId === exp.id).length, 0, '失效经历的旧段应被清掉');
  assert.ok(r4.total >= 1, '记忆的索引不受影响');
  // deleteDocumentIndexes：向量 + 关键词一起清
  await buildKeywordIndex(db, 'char_1', [journals[0], exp]);
  assert.equal((await searchKeyword(db, 'char_1', '海边', { topN: 5 })).length, 1);
  const cleared = await deleteDocumentIndexes(db, exp.id);
  assert.equal(cleared.vectorChunks, 0, '失效后经历已无向量段');
  assert.ok(cleared.keywordPostings > 0, '关键词 postings 应被清掉');
  assert.deepEqual(await searchKeyword(db, 'char_1', '海边', { topN: 5 }), []);
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).filter((c) => c.journalId === 'j1').length, 1, '清一条不应清掉其他文档');
});

test('索引状态：记忆 + 经历混合统计，失效经历不计入', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const st = await getIndexStatus(db, 'char_1', [...journals, ...experiences], SPACE);
  assert.equal(st.totalChunks, 3);
  assert.equal(st.missing, 0);
  assert.equal(st.perJournal.find((p) => p.journalId === experiences[0].id)?.docKind, 'experience');
  const st2 = await getIndexStatus(db, 'char_1', [...journals, { ...experiences[0], status: 'invalid' }], SPACE);
  assert.equal(st2.totalChunks, 2, '失效经历不应计入待索引总数');
});

test('fusedRetrieve：两路融合、按事件去重、融合分可由两路 rank 反推、阈值只作用于向量路', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const out = await fusedRetrieve(db, CHAR, '上周去海边约好下周再去', stubVector('上周去海边约好下周再去'), {
    spaceKey: SPACE, journals, experiences, topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.equal(out.error, null);
  assert.equal(out.keywordOnly, false);
  assert.equal(out.vectorOnly, false);
  assert.ok(out.results.length >= 1);
  // 同一文档只留一件
  assert.equal(new Set(out.results.map((r) => r.docId)).size, out.results.length, '同一事件出现了两次');
  // 融合分 = Σ 1/(60+rank)：用返回的 rank 反推，精确可验证
  for (const r of out.results) {
    const expected = (r.keywordRank ? 1 / (60 + r.keywordRank) : 0)
      + (r.vectorRank ? 1 / (60 + r.vectorRank) : 0);
    assert.ok(Math.abs(r.score - expected) < 1e-12, `${r.docId} 融合分 ${r.score} 与 rank 反推 ${expected} 不符`);
    assert.ok(r.sourceStatus === 'sourced' || r.sourceStatus === 'unsourced');
  }
  // 经历应能被召回（向量路或关键词路至少一路命中）
  assert.ok(out.results.some((r) => r.docKind === 'experience'), '经历没有被召回');
  // 融合后不再二次阈值过滤：关键词独占命中（向量分低于阈值）也能进结果——
  // 用一个向量完全不相关、关键词命中的查询验证
  const kwOnly = await fusedRetrieve(db, CHAR, '雨天共用一把伞', stubVector('服务器今天早上宕机了'), {
    spaceKey: SPACE, journals, experiences, topN: 5, threshold: 0.99, tokenBudget: 1500,
  });
  assert.ok(kwOnly.results.some((r) => r.docId === 'j1'), '阈值 0.99 下向量路无命中，关键词命中的 j1 应仍在结果里');
  assert.ok(kwOnly.results.every((r) => r.vectorRank === null), '阈值 0.99 下不应有向量命中');
});

test('fusedRetrieve 单路：向量未配置只走关键词（keywordOnly）；关键词未建只走向量（vectorOnly）', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const kw = await fusedRetrieve(db, CHAR, '海边', null, {
    spaceKey: SPACE, journals, experiences, topN: 5, tokenBudget: 1500,
  });
  assert.equal(kw.keywordOnly, true);
  assert.equal(kw.vectorOnly, false);
  assert.ok(kw.results.length >= 1, '无向量时关键词路应照常出结果');
  assert.ok(kw.results.every((r) => r.vectorRank === null));

  const { db: db2, journals: j2, experiences: e2 } = await setupFusedDb({ withKeyword: false });
  const vec = await fusedRetrieve(db2, CHAR, '上周去海边约好下周再去', stubVector('上周去海边约好下周再去'), {
    spaceKey: SPACE, journals: j2, experiences: e2, topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.equal(vec.vectorOnly, true);
  assert.equal(vec.keywordOnly, false);
  assert.ok(vec.results.length >= 1, '关键词索引未建时向量路应照常出结果');
  assert.ok(vec.results.every((r) => r.keywordRank === null));
});

test('fusedRetrieve 单路失败另一路照常：关键词库读失败时向量结果仍返回、error 不为空', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  class FailingKeywordBackend extends MemoryBackend {
    async getAll(table) {
      if (table === 'keywordIndex') throw new Error('关键词库暂时不可用');
      return super.getAll(table);
    }
  }
  const bad = new FailingKeywordBackend();
  await bad.init();
  for (const t of ['journals', 'experiences', 'vectorChunks']) {
    for (const row of await db.getAll(t)) await bad.put(t, row);
  }
  const out = await fusedRetrieve(bad, CHAR, '上周去海边约好下周再去', stubVector('上周去海边约好下周再去'), {
    spaceKey: SPACE, journals, experiences, topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.ok(out.results.length >= 1, '关键词路失败后向量路应照常出结果');
  assert.ok(out.error, '关键词路失败时 error 字段应非空');
  assert.equal(out.vectorOnly, true);
});

test('失效经历不可召回：markExperienceInvalid 后两路都搜不到它', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const exp = experiences[0];
  const before = await fusedRetrieve(db, CHAR, '下周六去海边吧', stubVector('下周六去海边吧'), {
    spaceKey: SPACE, journals, experiences, topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.ok(before.results.some((r) => r.docId === exp.id), '失效前应能召回该经历');
  // 来源消息被删/撤回 → 标失效 + 清索引（app.js 的 handler 就是这个流程）
  await db.put('experiences', await markExperienceInvalid(db, exp.id));
  await deleteDocumentIndexes(db, exp.id);
  const invalid = (await db.getAll('experiences')).find((e) => e.id === exp.id);
  const after = await fusedRetrieve(db, CHAR, '下周六去海边吧', stubVector('下周六去海边吧'), {
    spaceKey: SPACE, journals, experiences: [invalid], topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.ok(!after.results.some((r) => r.docId === exp.id), '失效后经历还被召回了');
  assert.ok(after.results.every((r) => r.docId !== exp.id));
});

test('索引同步 syncDocumentIndexes：编辑更新两路索引，关检索/删除两路都清', async () => {
  const db = new MemoryBackend();
  await db.init();
  const j = { id: 'j1', charId: 'char_1', title: '雨天', content: '雨天共用一把伞。', timestamp: 1000 };
  await syncDocumentIndexes({
    backend: db, charId: 'char_1', doc: j, spaceKey: SPACE, embedTexts: stubEmbed,
  });
  assert.equal((await searchKeyword(db, 'char_1', '雨天', { topN: 5 })).length, 1);
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).length, 1);
  // 编辑（标题与内容都改掉旧词，验证旧词立即不可见）
  await syncDocumentIndexes({
    backend: db, charId: 'char_1',
    doc: { ...j, title: '山里', content: '改成去山里看星星。' }, spaceKey: SPACE, embedTexts: stubEmbed,
  });
  assert.deepEqual(await searchKeyword(db, 'char_1', '雨天', { topN: 5 }), []);
  assert.equal((await searchKeyword(db, 'char_1', '山里看星星', { topN: 5 })).length, 1);
  assert.ok((await getChunksForSpace(db, 'char_1', SPACE))[0].body.includes('山里看星星'));
  // 关检索：两路都清
  await syncDocumentIndexes({
    backend: db, charId: 'char_1',
    doc: { ...j, content: '改成去山里看星星。', retrievalEnabled: false },
    spaceKey: SPACE, embedTexts: stubEmbed,
  });
  assert.deepEqual(await searchKeyword(db, 'char_1', '山里', { topN: 5 }), []);
  assert.equal((await getChunksForSpace(db, 'char_1', SPACE)).length, 0);
});

/* ---------- 4b 回归 + 测试召回（fusedRetrieve 即聊天同一条路） ---------- */
// 与验证波 harness-a.html 同款虚构经历（沈砚 / 小满，与真实数据无关）。
function harnessExps() {
  const T = (s) => Date.parse(s);
  const mk = (o) => createExperienceRecord(o);
  return [
    mk({ id: 'expA1', charId: 'char_1', title: '十一月八日雨夜送伞', summary: '2026年11月8日雨夜，沈砚把伞塞给小满，自己淋雨跑回家。', quotes: [{ text: '你把伞塞给我，自己淋雨跑回去了，衣服都湿透了吧', messageId: 'm-a1', speaker: '小满' }], speakers: ['小满', '沈砚'], timestamp: T('2026-11-08T21:05:00'), sourceMessageIds: ['m-a1', 'm-a2'] }),
    mk({ id: 'expA2', charId: 'char_1', title: '下周六爬香山', summary: '约好下周六去爬香山看红叶，还没去。', quotes: [{ text: '下周六去爬香山看红叶吧，约好了别反悔', messageId: 'm-a4', speaker: '小满' }], speakers: ['小满', '沈砚'], timestamp: T('2026-11-10T09:00:00'), sourceMessageIds: ['m-a4', 'm-a5'], plan_state: 'planned' }),
    mk({ id: 'expA3', charId: 'char_1', title: '深夜陪改稿', summary: '2026年11月12日深夜，沈砚陪小满改稿到三点，一起熬到天亮。', quotes: [{ text: '昨晚改稿改到三点，你居然陪我熬到天亮', messageId: 'm-a6', speaker: '小满' }], speakers: ['小满', '沈砚'], timestamp: T('2026-11-12T23:40:00'), sourceMessageIds: ['m-a6', 'm-a6r'] }),
    mk({ id: 'expA4', charId: 'char_1', title: '独自熬夜赶稿', summary: '2026年11月5日，小满一个人熬夜赶稿子，改到天亮才交上去。', quotes: [{ text: '前天我一个人熬夜赶稿子，改到天亮才交上去', messageId: 'm-a7', speaker: '小满' }], speakers: ['小满', '沈砚'], timestamp: T('2026-11-05T10:00:00'), sourceMessageIds: ['m-a7', 'm-a7r'] }),
  ];
}
async function setupHarnessDb() {
  const db = new MemoryBackend();
  await db.init();
  const experiences = harnessExps();
  for (const e of experiences) await db.put('experiences', e);
  await buildKeywordIndex(db, 'char_1', experiences);
  await indexDocuments({ backend: db, charId: 'char_1', documents: experiences, spaceKey: SPACE, embedTexts: stubEmbed });
  return { db, experiences };
}

test('4b 回归：中文无关话题 fusedRetrieve 返回空；检查 1/2 仍命中同一经历', async () => {
  const { db, experiences } = await setupHarnessDb();
  const opts = { spaceKey: SPACE, journals: [], experiences, topN: 5, threshold: 0.40, tokenBudget: 1500 };
  // 4b：只与经历共享单字“天/好”的中文无关话题 → 空（验证波实测曾召回 expA2/expA4/expA3）
  const q4b = '今天中午吃什么拉面好呢';
  const out4b = await fusedRetrieve(db, CHAR, q4b, stubVector(q4b), opts);
  assert.deepEqual(out4b.results, [], `4b 查询还召回了：${JSON.stringify(out4b.results.map((r) => r.docId))}`);
  // 检查 1：原话/人名查询仍首位命中 expA1，关键词第 1
  const q1 = '沈砚 伞 淋雨跑回去';
  const out1 = await fusedRetrieve(db, CHAR, q1, stubVector(q1), opts);
  assert.ok(out1.results.length >= 1, '检查 1 查询应命中');
  assert.equal(out1.results[0].docId, 'expA1');
  assert.equal(out1.results[0].keywordRank, 1);
  // 检查 2：同义问句仍召回同一经历（向量路）
  const q2 = '那天晚上你冒雨把雨伞让给我，自己淋着雨跑回家';
  const out2 = await fusedRetrieve(db, CHAR, q2, stubVector(q2), opts);
  const hit2 = out2.results.find((r) => r.docId === 'expA1');
  assert.ok(hit2, '同义问句应召回 expA1');
  assert.ok(Number.isFinite(hit2.vectorRank), '同义问句应有向量命中');
  // fused 结果带向量相关度（供“测试召回”显示）：向量命中的有数值
  assert.ok(Number.isFinite(hit2.vectorScore), '向量命中的 vectorScore 应为数值');
  // 关键词独占命中的 vectorScore 为 null
  const kwOnly = await fusedRetrieve(db, CHAR, '雨天共用一把伞', stubVector('服务器今天早上宕机了'), { ...opts, threshold: 0.99 });
  const kwHit = kwOnly.results.find((r) => r.docId === 'expA1');
  assert.ok(kwHit, '阈值 0.99 下关键词命中的 expA1 应仍在结果里');
  assert.equal(kwHit.vectorScore, null, '关键词独占命中的 vectorScore 应为 null');
  assert.equal(kwHit.vectorRank, null);
});

test('测试召回（fusedRetrieve）：记忆 + 经历两类都显示，含 docKind / 来源 / 融合分；无关话题为空', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const opts = { spaceKey: SPACE, journals, experiences, topN: 5, threshold: 0.40, tokenBudget: 0 };
  const out = await fusedRetrieve(db, CHAR, '上周去海边约好下周再去', stubVector('上周去海边约好下周再去'), opts);
  const kinds = new Set(out.results.map((r) => r.docKind));
  assert.ok(kinds.has('journal'), '测试召回应显示记忆类结果');
  assert.ok(kinds.has('experience'), '测试召回应显示经历类结果（B5：旧 testRecall 只传 journalsById，经历永远测不到）');
  for (const r of out.results) {
    assert.ok(r.title, '结果应带标题');
    assert.ok(Number.isFinite(r.score), '结果应带融合分');
    assert.ok(r.source, '结果应带来源');
    assert.ok(r.sourceStatus === 'sourced' || r.sourceStatus === 'unsourced', '结果应带 sourceStatus');
    assert.ok(r.docKind === 'journal' || r.docKind === 'experience', '结果应标明 docKind');
  }
  // 只有经历、无固定记忆时也能测到经历（B5 现象）
  const { db: dbExp, experiences: expsOnly } = await setupHarnessDb();
  const outExp = await fusedRetrieve(dbExp, CHAR, '沈砚 伞 淋雨跑回去', stubVector('沈砚 伞 淋雨跑回去'),
    { spaceKey: SPACE, journals: [], experiences: expsOnly, topN: 5, threshold: 0.40, tokenBudget: 0 });
  assert.ok(outExp.results.some((r) => r.docId === 'expA1' && r.docKind === 'experience'), '只有经历时测试召回应显示经历');
  // 无关话题为空（与问题 1 的修复一致）
  const outEmpty = await fusedRetrieve(dbExp, CHAR, '今天中午吃什么拉面好呢', stubVector('今天中午吃什么拉面好呢'),
    { spaceKey: SPACE, journals: [], experiences: expsOnly, topN: 5, threshold: 0.40, tokenBudget: 0 });
  assert.deepEqual(outEmpty.results, []);
});

/* ---------- 邻居补全 ---------- */
function neighborHistory() {
  let seq = 0;
  const m = (role, content, extra = {}) => ({
    id: `n${++seq}`, charId: 'char_1', role, content, timestamp: 1000 + seq * 1000, ...extra,
  });
  return {
    u1: m('user', '[朵朵的消息：第一轮聊天气]'),
    a1: m('assistant', '第一轮回复：今天晴天。', { roundId: 'r1' }),
    u2: m('user', '[朵朵的消息：第二轮约海边]'),
    a2: m('assistant', '第二轮回复：下周六去海边吧。', { roundId: 'r2' }),
    u3: m('user', '[朵朵的消息：第三轮聊晚饭]'),
    a3: m('assistant', '第三轮撤回的回复', { roundId: 'r3', isWithdrawn: true }),
    a3b: m('assistant', '第三轮另一条回复：吃火锅吧。', { roundId: 'r3' }),
    u4: m('user', '[朵朵的消息：第四轮不进上下文]', { isContextDisabled: true }),
    a4: m('assistant', '第四轮回复', { roundId: 'r4' }),
  };
}

test('邻居补全：命中轮次前后各补 1 轮，撤回/不进上下文的跳过，不占 topN', async () => {
  const h = neighborHistory();
  const messages = [h.u1, h.a1, h.u2, h.a2, h.u3, h.a3, h.a3b, h.u4, h.a4];
  // 轮分组：u4 不进上下文 → a4 没有对应的用户发言，但它换了 roundId，
  // 按 countRounds 的规则仍算一轮（assistant-only 的分裂轮）；有效轮次共 4 轮。
  const rounds = groupMessagesIntoRounds(messages, CHAR);
  assert.equal(rounds.length, 4, `有效轮次应为 4 轮，实际 ${rounds.length}`);
  // 命中在第 2 轮（u2 是来源）：前后各补 1 轮
  const ns = getNeighborContext({ messages, character: CHAR, sourceMessageIds: ['n3'] });
  assert.equal(ns.length, 2, '每命中最多补 2 条邻居');
  assert.deepEqual(ns.map((n) => n.roundOffset), [-1, 1]);
  assert.ok(ns[0].content.includes('第一轮聊天气'), '前一轮邻居内容不对');
  assert.ok(ns[1].content.includes('第三轮另一条回复'), '后一轮邻居应含有效的第三轮回复');
  assert.ok(!ns[1].content.includes('第三轮撤回的回复'), '撤回的消息进了邻居');
  assert.ok(!ns.some((n) => n.content.includes('第四轮')), '不进上下文的轮次进了邻居');
  assert.equal(ns[0].speaker, '朵朵');
  assert.ok(ns[0].timestamp);
});

test('邻居补全：来源消息已删（找不到轮次）不补；已被替换的轮次不补', () => {
  const h = neighborHistory();
  const messages = [h.u1, h.a1, h.u2, h.a2, h.u3, h.a3, h.a3b];
  assert.deepEqual(
    getNeighborContext({ messages, character: CHAR, sourceMessageIds: ['deleted-msg'] }), [],
    '来源已删还补了邻居',
  );
  assert.deepEqual(
    getNeighborContext({ messages, character: CHAR, sourceMessageIds: [] }), [],
    '无来源（无出处旧总结）还补了邻居',
  );
  // 第 1 轮已被替换（supersededRounds 快照里）：命中第 2 轮时前一轮不补
  const charSup = { ...CHAR, supersededRounds: [{ roundId: 'r1', messages: [h.u1, h.a1] }] };
  const ns = getNeighborContext({ messages, character: charSup, sourceMessageIds: ['n3'] });
  assert.equal(ns.length, 1, '被替换的前一轮还被补了');
  assert.equal(ns[0].roundOffset, 1);
});

test('邻居补全：fusedRetrieve 经 history 返回独立 neighbors，不占 topN 名额', async () => {
  const { db, journals, experiences } = await setupFusedDb();
  const h = neighborHistory();
  // 经历的来源消息就是第 2 轮的用户消息 n3
  const exp = { ...experiences[0], quotes: [{ text: '下周六去海边吧', messageId: 'n3', speaker: '朵朵' }], sourceMessageIds: ['n3'] };
  const out = await fusedRetrieve(db, CHAR, '下周六去海边吧', stubVector('下周六去海边吧'), {
    spaceKey: SPACE, journals, experiences: [exp],
    history: [h.u1, h.a1, h.u2, h.a2, h.u3, h.a3, h.a3b],
    topN: 5, threshold: 0.40, tokenBudget: 1500,
  });
  assert.ok(out.results.some((r) => r.docId === exp.id), '经历本身应被召回');
  assert.ok(out.neighbors.length >= 1, '应补到邻居');
  assert.ok(out.neighbors.every((n) => n.roundOffset === -1 || n.roundOffset === 1));
  assert.ok(out.neighbors.every((n) => n.docId), '邻居应标明所属命中 docId');
  assert.ok(!out.results.some((r) => r.roundOffset !== undefined), '邻居不应混进 results 占 topN');
  // collectNeighborsForResults：同一轮邻居只出现一次
  const dup = collectNeighborsForResults(
    [{ docId: 'x', sourceMessageIds: ['n3'] }, { docId: 'y', sourceMessageIds: ['n4'] }],
    [h.u1, h.a1, h.u2, h.a2, h.u3, h.a3, h.a3b], CHAR,
  );
  const keys = dup.map((n) => n.messageIds.join('|'));
  assert.equal(new Set(keys).size, keys.length, '同一轮邻居重复出现了');
});

/* ---------- 计划 ≠ 结果 ---------- */
test('计划≠结果：plan_state=planned 且无 outcome 时标签不显示“已完成”', () => {
  const planned = createExperienceRecord({
    charId: 'char_1', title: '约看电影', summary: '约好下周六看电影。',
    quotes: [{ text: '下周六去看电影', messageId: 'm1' }],
    plan_state: 'planned',
  });
  assert.equal(planOutcomeLabel(planned), '计划');
  assert.ok(!planOutcomeLabel(planned).includes('已完成'), '只有计划、没有结果佐证，却显示了“已完成”');
  const done = createExperienceRecord({
    charId: 'char_1', title: '约看电影', summary: '约好下周六看电影。',
    quotes: [{ text: '下周六去看电影', messageId: 'm1' }],
    plan_state: 'planned',
    outcome_state: { state: 'completed', evidenceMessageIds: ['m9'] },
  });
  assert.ok(planOutcomeLabel(done).includes('已完成'), '有后续原文佐证的已完成应显示“已完成”');
});
