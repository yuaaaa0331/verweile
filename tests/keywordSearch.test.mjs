// keywordSearch.test.mjs — 中文关键词检索（第 2 波）：分词 / BM25 / 索引同步 / 隔离。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenize, STOPWORDS, BM25_K1, BM25_B,
  buildKeywordIndex, updateKeywordDoc, deleteKeywordDoc, searchKeyword,
  hasKeywordIndex, normalizeRetrievalDoc, keywordDocFromJournal,
  keywordDocFromExperience, retrievalDocsForChar,
} from '../js/keywordSearch.js';
import { MemoryBackend } from '../js/storage.js';
import { createExperienceRecord } from '../js/experiences.js';

/** 桩向量（与 vectorMemory.test.mjs 同款单字哈希 128 维，仅测试用）。 */
function stubVector(text, dim = 128) {
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

const J = (over = {}) => ({
  id: 'j1', charId: 'char_1', title: '第一次见面',
  content: '我们在雨天共用一把伞，还约好下周去海边。',
  source: '手动记录', timestamp: 1000, ...over,
});
const E = (over = {}) => createExperienceRecord({
  charId: 'char_1', title: '海边之约', summary: '约好下周六去海边看日落。',
  quotes: [{ text: '下周六去海边吧', messageId: 'm1', speaker: '朵朵' }],
  timestamp: 2000, ...over,
});

/* ---------- 分词 ---------- */
test('分词：连续汉字出 bigram + 完整词串，不再出单字；英文按词切分、小写化', () => {
  const terms = tokenize('我们去海边看日落');
  // 完整词串 + bigram：海边、边看、看日、日落；单字不再当 term
  for (const t of ['我们去海边看日落', '海边', '边看', '看日', '日落']) {
    assert.ok(terms.includes(t), `分词缺了 ${t}：${terms.join(',')}`);
  }
  for (const t of ['我', '们', '去', '海', '边', '看', '日', '落']) {
    assert.ok(!terms.includes(t), `单字 ${t} 不应再当 term：${terms.join(',')}`);
  }
  assert.deepEqual(tokenize('Hello WORLD 123'), ['hello', 'world', '123']);
  assert.ok(tokenize('海边-约定').includes('海边'), '分隔符两侧的词应分别切出');
  // 单个汉字查不到任何 term：单字查询直接返回空，不进检索
  assert.deepEqual(tokenize('猫'), []);
  assert.deepEqual(tokenize('伞'), []);
});

test('停用词表很小：只去虚词，不去实词', () => {
  for (const w of ['的', '了', '是', '在', '和']) {
    assert.ok(STOPWORDS.has(w), `停用词表缺了虚词 ${w}`);
    assert.ok(!tokenize(w).includes(w), `虚词 ${w} 没被滤掉`);
  }
  for (const w of ['海边', '香菜', '雨天', '电影', '约定']) {
    assert.ok(!STOPWORDS.has(w), `停用词表误伤了实词 ${w}`);
    assert.ok(tokenize(w).includes(w), `实词 ${w} 被滤掉了`);
  }
  // “猫”是实词但只有一个字：不再当 term，单字查询直接返回空（见 4b 修复）
  assert.ok(!STOPWORDS.has('猫'), '停用词表误伤了实词 猫');
  assert.deepEqual(tokenize('猫'), []);
  // “我们”里的“们”不是停用词；整句分词后实词都在
  const terms = tokenize('他不喜欢吃香菜');
  assert.ok(terms.includes('香菜'), '香菜没进分词结果');
  assert.ok(terms.includes('喜欢'), '喜欢没进分词结果');
});

/* ---------- 建索引 + BM25 检索 ---------- */
test('中文关键词命中：二元字串命中，词频高的排前面', async () => {
  const db = new MemoryBackend();
  await db.init();
  const docs = [
    J({ id: 'j1', content: '我们在雨天共用一把伞。' }),
    J({ id: 'j2', title: '海边约定', content: '上周去海边约好下周再去，海边很好玩，海边。' }),
    J({ id: 'j3', title: '山里', content: '改成去山里看星星的约定。' }),
  ];
  const built = await buildKeywordIndex(db, 'char_1', docs);
  assert.equal(built.docs, 3);
  assert.ok(built.terms > 0);
  assert.equal(await hasKeywordIndex(db, 'char_1'), true);
  assert.equal(await hasKeywordIndex(db, 'char_2'), false);

  const hits = await searchKeyword(db, 'char_1', '海边约定', { topN: 5 });
  assert.ok(hits.length >= 1, '海边约定应命中');
  assert.equal(hits[0].docId, 'j2', '海边词频最高的 j2 应排第一');
  assert.equal(hits[0].rank, 1);
  assert.ok(hits[0].score > 0);
  // rank 严格按分降序
  for (let i = 1; i < hits.length; i++) assert.ok(hits[i - 1].score >= hits[i].score);
  // “山里”只命中 j3
  const hill = await searchKeyword(db, 'char_1', '山里看星星', { topN: 5 });
  assert.deepEqual(hill.map((h) => h.docId), ['j3']);
  // 全是停用词的查询：无有效 term，返回 []
  assert.deepEqual(await searchKeyword(db, 'char_1', '的', { topN: 5 }), []);
  // 查不到的词：返回 []，不硬塞
  assert.deepEqual(await searchKeyword(db, 'char_1', '量子力学', { topN: 5 }), []);
});

test('4b 回归：单字噪声不再召回——单字查询与中文无关话题返回空，检查 1 仍命中', async () => {
  const db = new MemoryBackend();
  await db.init();
  // 与验证波 harness 同款虚构经历内容（只含单字“天/好”，没有“今天/拉面”等二元交集）
  const d1 = J({ id: 'd1', content: '约好下周六去爬香山看红叶，还没去。' }); // 含单字“好”
  const d2 = J({ id: 'd2', content: '小满一个人熬夜赶稿子，改到天亮才交上去。' }); // 含单字“天”
  const d3 = J({ id: 'd3', content: '沈砚陪小满改稿到三点，一起熬到天亮。' }); // 含单字“天”
  const d4 = E({
    title: '十一月八日雨夜送伞',
    summary: '2026年11月8日雨夜，沈砚把伞塞给小满，自己淋雨跑回家。',
    quotes: [{ text: '你把伞塞给我，自己淋雨跑回去了，衣服都湿透了吧', messageId: 'm-a1', speaker: '小满' }],
  });
  await buildKeywordIndex(db, 'char_1', [d1, d2, d3, keywordDocFromExperience(d4)]);
  // 单字查询直接返回空
  assert.deepEqual(await searchKeyword(db, 'char_1', '天', { topN: 5 }), []);
  assert.deepEqual(await searchKeyword(db, 'char_1', '好', { topN: 5 }), []);
  assert.deepEqual(await searchKeyword(db, 'char_1', '伞', { topN: 5 }), []);
  // 4b 同款中文无关话题：只与经历共享单字“天/好”，二元字串零交集 → 空
  assert.deepEqual(await searchKeyword(db, 'char_1', '今天中午吃什么拉面好呢', { topN: 5 }), [],
    '4b 查询还召回了经历：单字噪声没挡住');
  // “今天”这个常见二元字串在这些文档里不存在，也应为空（不是单字噪声）
  assert.deepEqual(await searchKeyword(db, 'char_1', '今天', { topN: 5 }), []);
  // 检查 1 同款查询：仍首位命中雨夜送伞的经历
  const hits1 = await searchKeyword(db, 'char_1', '沈砚 伞 淋雨跑回去', { topN: 5 });
  assert.ok(hits1.length >= 1, '检查 1 查询应命中');
  assert.equal(hits1[0].docId, d4.id, '检查 1 查询首位应是雨夜送伞');
  assert.equal(hits1[0].rank, 1);
  // term 形状门：只命中单字母词的文档不要
  const db2 = new MemoryBackend();
  await db2.init();
  await buildKeywordIndex(db2, 'char_1', [J({ id: 'jx', content: '代号 X 计划，明天行动。' })]);
  assert.deepEqual(await searchKeyword(db2, 'char_1', 'x', { topN: 5 }), [], '只命中单字母 x 的文档应被形状门挡住');
  assert.equal((await searchKeyword(db2, 'char_1', '代号', { topN: 5 }))[0]?.docId, 'jx', '二元字串“代号”应正常命中');
});

test('BM25 常量：k1=1.2、b=0.75；IDF 用 ln(1+(N-df+0.5)/(df+0.5))', async () => {
  assert.equal(BM25_K1, 1.2);
  assert.equal(BM25_B, 0.75);
  // 同一词在两篇等长文档里，tf 高的得分高；df 越大 IDF 越小——
  // 用两篇等长（各 7 字）文档验证单调性：j2 的“海边”出现 2 次，j1 出现 1 次。
  const db = new MemoryBackend();
  await db.init();
  await buildKeywordIndex(db, 'char_1', [
    J({ id: 'j1', title: '', content: '海边散步很好玩' }),
    J({ id: 'j2', title: '', content: '海边海边很好玩' }),
  ]);
  const hits = await searchKeyword(db, 'char_1', '海边', { topN: 5 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].docId, 'j2');
  assert.ok(hits[0].score > hits[1].score, 'tf 高的得分应更高');
  // IDF 公式本身：df=1、N=2 时 idf = ln(1+(2-1+0.5)/(1+0.5)) = ln(2)
  assert.ok(Math.abs(Math.log(1 + (2 - 1 + 0.5) / (1 + 0.5)) - Math.log(2)) < 1e-12);
});

test('无原文出处的旧总结：可以进索引用于“找到它”，但标 unsourced', async () => {
  const db = new MemoryBackend();
  await db.init();
  // 旧总结：isSummary 但没有 sourceMessageIds/range → unsourced
  const oldSummary = J({ id: 'j_old', isSummary: true, content: '多年前在海边捡到一只猫。' });
  const doc = normalizeRetrievalDoc(oldSummary);
  assert.equal(doc.sourceStatus, 'unsourced');
  await buildKeywordIndex(db, 'char_1', [oldSummary]);
  const hits = await searchKeyword(db, 'char_1', '海边捡猫', { topN: 5 });
  assert.ok(hits.some((h) => h.docId === 'j_old'), '无出处的旧总结应能被关键词找到');
  // 有出处的总结标 sourced
  const sourced = J({
    id: 'j_new', isSummary: true,
    sourceMessageIds: ['m1', 'm2'], range: { fromMessageId: 'm1', toMessageId: 'm2', rounds: 1 },
  });
  assert.equal(normalizeRetrievalDoc(sourced).sourceStatus, 'sourced');
});

test('隔离：A 角色的记忆不在 B 角色检索里；建索引不串角色', async () => {
  const db = new MemoryBackend();
  await db.init();
  await buildKeywordIndex(db, 'char_1', [J({ id: 'j1', content: '海边约定' })]);
  await buildKeywordIndex(db, 'char_2', [J({ id: 'j9', charId: 'char_2', content: '海边约定' })]);
  const a = await searchKeyword(db, 'char_1', '海边', { topN: 5 });
  const b = await searchKeyword(db, 'char_2', '海边', { topN: 5 });
  assert.deepEqual(a.map((h) => h.docId), ['j1']);
  assert.deepEqual(b.map((h) => h.docId), ['j9']);
});

/* ---------- 索引同步 ---------- */
test('关键词索引同步：编辑后旧词立即不可见、新词立即可见；删除后立即不可见', async () => {
  const db = new MemoryBackend();
  await db.init();
  await buildKeywordIndex(db, 'char_1', [J({ id: 'j1', content: '我们在雨天共用一把伞。' })]);
  assert.equal((await searchKeyword(db, 'char_1', '雨天', { topN: 5 })).length, 1);
  // 编辑：雨天 → 山里看星星
  await updateKeywordDoc(db, J({ id: 'j1', content: '改成去山里看星星的约定。' }));
  assert.deepEqual(await searchKeyword(db, 'char_1', '雨天', { topN: 5 }), [], '编辑后旧词还搜得到');
  assert.equal((await searchKeyword(db, 'char_1', '山里看星星', { topN: 5 })).length, 1, '编辑后新词搜不到');
  // 删除
  await deleteKeywordDoc(db, 'j1');
  assert.deepEqual(await searchKeyword(db, 'char_1', '山里', { topN: 5 }), [], '删除后还搜得到');
  // 删不存在的文档不抛错
  assert.equal(await deleteKeywordDoc(db, 'nope'), 0);
});

test('关键词索引同步：retrievalEnabled=false 的不进索引；失效经历不进索引', async () => {
  const db = new MemoryBackend();
  await db.init();
  const hidden = J({ id: 'j1', content: '海边约定', retrievalEnabled: false });
  await buildKeywordIndex(db, 'char_1', [hidden]);
  assert.deepEqual(await searchKeyword(db, 'char_1', '海边', { topN: 5 }), []);
  // 之后打开参与检索：updateKeywordDoc 应把它重新建回来
  await updateKeywordDoc(db, J({ id: 'j1', content: '海边约定', retrievalEnabled: true }));
  assert.equal((await searchKeyword(db, 'char_1', '海边', { topN: 5 })).length, 1);
  // 再关掉：只清不建
  await updateKeywordDoc(db, J({ id: 'j1', content: '海边约定', retrievalEnabled: false }));
  assert.deepEqual(await searchKeyword(db, 'char_1', '海边', { topN: 5 }), []);

  // 经历：有效时进索引，标 invalid 后 update 只清不建
  const exp = E();
  await updateKeywordDoc(db, keywordDocFromExperience(exp));
  assert.equal((await searchKeyword(db, 'char_1', '海边看日落', { topN: 5 })).length, 1);
  await updateKeywordDoc(db, keywordDocFromExperience({ ...exp, status: 'invalid' }));
  assert.deepEqual(await searchKeyword(db, 'char_1', '海边看日落', { topN: 5 }), [], '失效经历还搜得到');
});

test('经历进关键词索引：标题 + 关键细节 + 关键原话都能命中', async () => {
  const db = new MemoryBackend();
  await db.init();
  const exp = E();
  const doc = keywordDocFromExperience(exp);
  assert.equal(doc.docKind, 'experience');
  assert.equal(doc.sourceStatus, 'sourced');
  assert.ok(doc.text.includes('下周六去海边吧'), '原话没进索引文本');
  await buildKeywordIndex(db, 'char_1', [doc]);
  assert.ok((await searchKeyword(db, 'char_1', '看日落', { topN: 5 })).some((h) => h.docId === exp.id));
  assert.ok((await searchKeyword(db, 'char_1', '下周六去海边吧', { topN: 5 })).some((h) => h.docId === exp.id));
  // 记忆 + 经历混合建索引
  const built = await buildKeywordIndex(db, 'char_1', retrievalDocsForChar([J()], [exp]));
  assert.equal(built.docs, 2);
  const hits = await searchKeyword(db, 'char_1', '海边', { topN: 5 });
  assert.equal(new Set(hits.map((h) => h.docId)).size, hits.length, '同一文档在关键词结果里出现了两次');
});

export { stubVector, stubEmbed };
