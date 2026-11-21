// experiences.test.mjs — 经历记忆（第 1 波）：store 迁移、记录结构、
// plan/outcome 分离、来源标记、提取提示词/解析/写库、quote 来源校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createExperienceRecord, isExperienceValid, markExperienceInvalid,
  updateExperience, deleteExperience, getExperiencesForChar,
  planOutcomeLabel, sourceStatusOfJournal,
  DEFAULT_EXPERIENCE_PROMPT, buildExperienceExtractionRequest,
  buildExperienceTranscript, parseExperienceExtractionResponse,
  extractExperiencesFromRange,
} from '../js/experiences.js';
import { MemoryBackend, DB_VERSION, ensureExperienceStores } from '../js/storage.js';
import { fixtureCharacter } from './helpers.mjs';

const ch = fixtureCharacter();
let seq = 0;
function msg(role, content, extra = {}) {
  return { id: `m${++seq}`, charId: 'char_1', role, content, timestamp: 1000 + seq * 1000, ...extra };
}
function quote(text, messageId, speaker = '') {
  return { text, messageId, speaker };
}

const SUMMARY_API = { provider: 'openai', url: 'https://api.example.com/v1', key: 'sk-test', model: 'gpt-4o-mini' };

/* ---------- 迁移：v2→v3 ---------- */
test('迁移：v2 库升到 v3 只新增 experiences + keywordIndex 表，旧表不动', () => {
  const created = [];
  const createdStores = {};
  const stores = new Set(['characters', 'journals', 'messages', 'settings', 'unknown', 'vectorChunks']);
  const fakeDb = {
    objectStoreNames: { contains: (n) => stores.has(n) },
    createObjectStore: (name, opts) => {
      stores.add(name);
      const idx = [];
      created.push(name);
      const s = { createIndex: (iname, kp) => idx.push([iname, kp]), _idx: idx, _keyPath: opts?.keyPath };
      createdStores[name] = s;
      return s;
    },
  };
  ensureExperienceStores(fakeDb);
  assert.deepEqual(created, ['experiences', 'keywordIndex']);
  assert.equal(createdStores.experiences._keyPath, 'id');
  assert.deepEqual(createdStores.experiences._idx, [['byChar', ['charId', 'timestamp']]]);
  assert.equal(createdStores.keywordIndex._keyPath, 'id');
  assert.deepEqual(createdStores.keywordIndex._idx, [['byChar', ['charId', 'term']]]);
  assert.ok(stores.has('journals'), '旧表被动了');
  assert.ok(stores.has('vectorChunks'), 'v2 的 vectorChunks 表被动了');
  // 再跑一次不重复建
  created.length = 0;
  ensureExperienceStores(fakeDb);
  assert.deepEqual(created, []);
  assert.equal(DB_VERSION, 4); // v3→v4 只新增唤醒三张表（见 b-group.test.mjs），v2→v3 的建表行为本身不变
});

test('MemoryBackend 有 experiences / keywordIndex 表，可读写；老数据不受影响', async () => {
  const db = new MemoryBackend();
  await db.init();
  await db.put('journals', { id: 'j_old', charId: 'char_1', title: '旧记忆', content: '雨天共用一把伞。' });
  await db.put('messages', { id: 'm_old', charId: 'char_1', role: 'user', content: '旧消息', timestamp: 100 });
  const rec = createExperienceRecord({
    charId: 'char_1', title: '海边之约', summary: '约好下周六去海边。',
    quotes: [quote('下周六去海边吧', 'm_old', '朵朵')],
  });
  await db.put('experiences', rec);
  await db.put('keywordIndex', { id: 'k1', charId: 'char_1', term: '海边', experienceIds: [rec.id] });
  assert.equal((await db.get('journals', 'j_old')).title, '旧记忆');
  assert.equal((await db.get('messages', 'm_old')).content, '旧消息');
  assert.equal((await db.getAll('experiences')).length, 1);
  assert.equal((await db.getAll('keywordIndex')).length, 1);
  assert.equal((await db.get('keywordIndex', 'k1')).term, '海边');
});

/* ---------- 记录结构 ---------- */
test('经历记录结构：默认值完整，quotes 没有来源消息 ID 的被丢弃', () => {
  const rec = createExperienceRecord({
    charId: 'char_1', title: '第一次见面', summary: '雨天共用一把伞。',
    quotes: [
      quote('这把伞给你', 'm1', '阿澈'),
      { text: '没有来源的消息', messageId: '' }, // 无来源：丢弃
      { text: '', messageId: 'm2' }, // 空原话：丢弃
    ],
    speakers: ['朵朵', '阿澈', '阿澈'],
    timestamp: 1700000000000, plan_state: 'completed',
  });
  assert.match(rec.id, /^exp_/);
  assert.equal(rec.version, 1);
  assert.equal(rec.status, 'active');
  assert.equal(rec.plan_state, 'completed');
  assert.equal(rec.outcome_state, null);
  assert.equal(rec.source, '经历提取');
  assert.equal(rec.retrievalEnabled, true);
  assert.deepEqual(rec.quotes, [{ text: '这把伞给你', messageId: 'm1', speaker: '阿澈', timestamp: null }]);
  assert.deepEqual(rec.speakers, ['朵朵', '阿澈']);
  assert.deepEqual(rec.sourceMessageIds, ['m1']);
  assert.equal(rec.timestamp, 1700000000000);
  assert.throws(() => createExperienceRecord({ title: '没有 charId' }), /charId/);
});

test('plan/outcome 分离：两个字段独立存在；outcome 没有后续原文佐证不成立', () => {
  const rec = createExperienceRecord({
    charId: 'char_1', title: '约看电影', summary: '约好下周六看电影。',
    quotes: [quote('下周六去看电影', 'm1')],
    plan_state: 'planned',
    outcome_state: { state: 'completed', evidenceMessageIds: ['m9', 'm10'], at: 1700000001000 },
  });
  assert.equal(rec.plan_state, 'planned');
  assert.deepEqual(rec.outcome_state, { state: 'completed', evidenceMessageIds: ['m9', 'm10'], at: 1700000001000 });

  // outcome 没有 evidenceMessageIds：不成立，归 null；plan_state 不受影响
  const noEvidence = createExperienceRecord({
    charId: 'char_1', title: '约看电影', summary: '约好下周六看电影。',
    quotes: [quote('下周六去看电影', 'm1')],
    plan_state: 'planned',
    outcome_state: { state: 'completed', evidenceMessageIds: [] },
  });
  assert.equal(noEvidence.outcome_state, null);
  assert.equal(noEvidence.plan_state, 'planned');

  // 非法 plan_state 归 'none'
  const bad = createExperienceRecord({
    charId: 'char_1', title: 'x', summary: 'y', quotes: [quote('z', 'm1')], plan_state: 'maybe',
  });
  assert.equal(bad.plan_state, 'none');
});

test('planOutcomeLabel：有 outcome 时优先显示结果，否则显示计划状态', () => {
  const base = { plan_state: 'planned', outcome_state: null };
  assert.equal(planOutcomeLabel(base), '计划');
  assert.equal(planOutcomeLabel({ plan_state: 'hypothetical', outcome_state: null }), '假设剧情');
  assert.equal(planOutcomeLabel({ plan_state: 'setting', outcome_state: null }), '角色设定');
  assert.equal(planOutcomeLabel({ plan_state: 'paraphrase', outcome_state: null }), '转述');
  assert.equal(planOutcomeLabel({ plan_state: 'completed', outcome_state: null }), '已完成');
  assert.equal(planOutcomeLabel({ plan_state: 'cancelled', outcome_state: null }), '已取消');
  assert.equal(planOutcomeLabel({ plan_state: 'none', outcome_state: null }), '');
  // outcome 优先于 plan_state，并标出佐证条数
  assert.equal(
    planOutcomeLabel({ plan_state: 'planned', outcome_state: { state: 'completed', evidenceMessageIds: ['m9', 'm10'] } }),
    '已完成（2 条后续原文佐证）',
  );
  assert.equal(
    planOutcomeLabel({ plan_state: 'planned', outcome_state: { state: 'rescheduled', evidenceMessageIds: ['m9'] } }),
    '已改期（1 条后续原文佐证）',
  );
  assert.equal(
    planOutcomeLabel({ plan_state: 'planned', outcome_state: { state: 'cancelled', evidenceMessageIds: [] } }),
    '已取消',
  );
});

/* ---------- 有效性 / 编辑 / 删除 / 取列表 ---------- */
test('isExperienceValid 与 markExperienceInvalid：失效的不进检索', async () => {
  const db = new MemoryBackend();
  const rec = createExperienceRecord({
    charId: 'char_1', title: '海边', summary: '去过海边。', quotes: [quote('去海边', 'm1')],
  });
  await db.put('experiences', rec);
  assert.equal(isExperienceValid(rec), true);
  assert.equal(isExperienceValid(null), false);
  const marked = await markExperienceInvalid(db, rec.id);
  assert.equal(marked.status, 'invalid');
  assert.equal(isExperienceValid(marked), false);
  assert.equal(isExperienceValid(await db.get('experiences', rec.id)), false);
  // 再标一次还是 invalid，不报错
  assert.equal((await markExperienceInvalid(db, rec.id)).status, 'invalid');
  assert.equal(await markExperienceInvalid(db, '不存在的id'), null);
});

test('updateExperience：编辑后 version+1，来源集合随 quotes 走；全删原话抛错', async () => {
  const db = new MemoryBackend();
  const rec = createExperienceRecord({
    charId: 'char_1', title: '旧标题', summary: '旧细节',
    quotes: [quote('第一句', 'm1', '朵朵'), quote('第二句', 'm2', '阿澈')],
  });
  await db.put('experiences', rec);
  const next = await updateExperience(db, rec.id, {
    title: '新标题', summary: '新细节', plan_state: 'hypothetical',
    quotes: [quote('第一句', 'm1', '朵朵')],
  });
  assert.equal(next.version, 2);
  assert.equal(next.title, '新标题');
  assert.equal(next.plan_state, 'hypothetical');
  assert.equal(next.quotes.length, 1);
  assert.deepEqual(next.sourceMessageIds, ['m1']);
  assert.equal((await db.get('experiences', rec.id)).version, 2);
  await assert.rejects(
    updateExperience(db, rec.id, { quotes: [] }),
    /至少需要一句带来源的原话/,
  );
  assert.equal(await updateExperience(db, '不存在的id', { title: 'x' }), null);
});

test('deleteExperience 物理删除；getExperiencesForChar 按角色过滤、时间倒序', async () => {
  const db = new MemoryBackend();
  const a = createExperienceRecord({ charId: 'char_1', title: '早', summary: 's', quotes: [quote('q', 'm1')], timestamp: 1000 });
  const b = createExperienceRecord({ charId: 'char_1', title: '晚', summary: 's', quotes: [quote('q', 'm2')], timestamp: 3000 });
  const c = createExperienceRecord({ charId: 'char_2', title: '别人', summary: 's', quotes: [quote('q', 'm3')], timestamp: 2000 });
  for (const r of [a, b, c]) await db.put('experiences', r);
  let list = await getExperiencesForChar(db, 'char_1');
  assert.deepEqual(list.map((e) => e.title), ['晚', '早']);
  await deleteExperience(db, b.id);
  list = await getExperiencesForChar(db, 'char_1');
  assert.deepEqual(list.map((e) => e.title), ['早']);
  assert.equal((await getExperiencesForChar(db, 'char_2')).length, 1);
});

/* ---------- 来源标记 ---------- */
test('sourceStatusOfJournal：只有 isSummary + sourceMessageIds 非空 + range 才算有出处', () => {
  const sourced = {
    id: 'j1', isSummary: true, sourceMessageIds: ['m1', 'm2'],
    range: { fromMessageId: 'm1', toMessageId: 'm2', rounds: 2 },
  };
  assert.equal(sourceStatusOfJournal(sourced), 'sourced');
  // 导入的 UWU 旧记忆：没有 sourceMessageIds / range / isSummary
  assert.equal(sourceStatusOfJournal({ id: 'j2', title: '旧记忆', content: 'xxx', source: '导入' }), 'unsourced');
  // 有 sourceMessageIds 但没有 range：无出处
  assert.equal(sourceStatusOfJournal({ id: 'j3', isSummary: true, sourceMessageIds: ['m1'] }), 'unsourced');
  // sourceMessageIds 为空：无出处（source 自由文本不能当出处）
  assert.equal(sourceStatusOfJournal({
    id: 'j4', isSummary: true, sourceMessageIds: [], source: '手动总结 · 最近 10 轮',
    range: { fromMessageId: 'm1', toMessageId: 'm2', rounds: 1 },
  }), 'unsourced');
  // 非总结的手动记忆：无出处
  assert.equal(sourceStatusOfJournal({ id: 'j5', isSummary: false, sourceMessageIds: ['m1'], range: {} }), 'unsourced');
  assert.equal(sourceStatusOfJournal(null), 'unsourced');
});

/* ---------- 提取提示词与记录文本化 ---------- */
test('提取提示词：只写原文能支撑的、猜测标 hypothetical/paraphrase、不总结代码类内容、只返 JSON 数组', () => {
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /只根据下面提供的聊天记录提取经历/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /不要编造/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /hypothetical/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /paraphrase/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /绝不能记成双方确实经历过的事实/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /HTML\/CSS/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /状态栏模板代码/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /Base64 图片/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /系统提示词/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /只返回一个 JSON 数组/);
  assert.match(DEFAULT_EXPERIENCE_PROMPT, /不要填结果状态/);
  const req = buildExperienceExtractionRequest({ transcript: '[消息ID m1] 朵朵：去海边' });
  assert.equal(req.messages.length, 2);
  assert.equal(req.messages[0].role, 'system');
  assert.match(req.messages[1].content, /\[消息ID m1\] 朵朵：去海边/);
  assert.match(req.messages[1].content, /必须照抄/);
});

test('buildExperienceTranscript：每行带消息 ID，状态/思考/撤回不进提取', () => {
  seq = 0;
  const history = [
    msg('user', '我们上周去海边约好下周再去'),
    msg('assistant', '[阿澈的消息：好啊，下周六见]', { roundId: 'r1' }),
    msg('assistant', '[阿澈更新状态为：开心]', { isStatusUpdate: true }),
    msg('assistant', '<thinking>他在想什么</thinking>'),
    msg('assistant', '[阿澈的消息：记得带伞]', { roundId: 'r1' }),
    msg('user', '撤回的那句', { isWithdrawn: true, originalContent: '撤回的那句' }),
  ];
  const t = buildExperienceTranscript(history, ch);
  assert.match(t, /\[消息ID m1\]/);
  assert.match(t, /\[消息ID m2\]/);
  assert.match(t, /\[消息ID m5\]/);
  assert.equal(t.includes('更新状态为'), false);
  assert.equal(t.includes('他在想什么'), false);
  assert.equal(t.includes('撤回的那句'), false);
  assert.equal(t.includes('m3'), false);
  assert.equal(t.includes('m6'), false);
});

/* ---------- 提取响应解析 ---------- */
test('parseExperienceExtractionResponse：正常 JSON、围栏、非法 JSON、缺字段', () => {
  const good = JSON.stringify([{
    title: '海边之约', summary: '约好下周六去海边。',
    quotes: [{ text: '下周六去海边吧', messageId: 'm1', speaker: '朵朵' }],
    speakers: ['朵朵', '阿澈'], timestamp: 1700000000000, plan_state: 'planned',
  }]);
  const { items, dropped } = parseExperienceExtractionResponse(`\`\`\`json\n${good}\n\`\`\``);
  assert.equal(items.length, 1);
  assert.equal(dropped.length, 0);
  assert.equal(items[0].title, '海边之约');
  assert.equal(items[0].plan_state, 'planned');

  assert.throws(() => parseExperienceExtractionResponse('这不是 JSON'), /不是有效的 JSON 数组/);
  assert.throws(() => parseExperienceExtractionResponse('{"title":"不是数组"}'), /不是有效的 JSON 数组/);
  assert.throws(() => parseExperienceExtractionResponse(''), /不是有效的 JSON 数组/);

  // 单件缺字段：丢弃该件、记原因，不影响其他件；非法 plan_state 归 'none'
  const mixed = JSON.stringify([
    { title: '有效', summary: '有原话。', quotes: [{ text: '原话', messageId: 'm1' }], plan_state: 'whatever' },
    { title: '', summary: '没标题' },
    { title: '没原话', summary: '没有 quotes。', quotes: [] },
  ]);
  const r2 = parseExperienceExtractionResponse(mixed);
  assert.equal(r2.items.length, 1);
  assert.equal(r2.items[0].plan_state, 'none');
  assert.equal(r2.dropped.length, 2);
});

/* ---------- 单次范围提取 ---------- */
function fakeExtractionReply(items) {
  return async (cfg, messages) => {
    assert.equal(cfg.model, 'gpt-4o-mini');
    assert.match(messages[1].content, /消息ID/);
    return JSON.stringify(items);
  };
}

test('extractExperiencesFromRange：有效原话写库，无效来源的 quote 丢弃，整件无有效原话跳过', async () => {
  seq = 0;
  const db = new MemoryBackend();
  const history = [
    msg('user', '我们上周去海边约好下周再去'),
    msg('assistant', '[阿澈的消息：好啊，下周六见]', { roundId: 'r1' }),
    msg('user', '那就这么定了'),
    msg('assistant', '[阿澈的消息：嗯，下周六见]', { roundId: 'r2' }),
  ];
  const callChat = fakeExtractionReply([
    {
      title: '海边之约', summary: '约好下周六去海边。',
      quotes: [
        { text: '我们上周去海边约好下周再去', messageId: 'm1', speaker: '朵朵' },
        { text: '范围外的原话', messageId: 'm999', speaker: '阿澈' }, // 不在选定范围：丢弃
      ],
      speakers: ['朵朵', '阿澈'], timestamp: 1700000000000, plan_state: 'planned',
    },
    {
      title: '全是野原话', summary: '引用的消息都不在范围内。',
      quotes: [{ text: '野原话', messageId: 'm888', speaker: '阿澈' }],
      speakers: [], timestamp: null, plan_state: 'none',
    },
  ]);
  const progress = [];
  const res = await extractExperiencesFromRange(db, ch, history, {
    summaryApi: SUMMARY_API, callSummaryChat: callChat,
    onProgress: (p) => progress.push(p.phase),
  });
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].title, '海边之约');
  assert.equal(res.created[0].quotes.length, 1, '范围外的 quote 被丢弃，只留有效的一句');
  assert.equal(res.created[0].quotes[0].messageId, 'm1');
  assert.deepEqual(res.created[0].sourceMessageIds, ['m1']);
  assert.equal(res.created[0].range.rounds, 2);
  assert.equal(res.created[0].range.fromMessageId, 'm1');
  assert.equal(res.created[0].range.toMessageId, 'm4');
  assert.equal((await db.getAll('experiences')).length, 1);
  assert.ok(res.skipped.some((s) => s.reason.includes('全是野原话')), '无有效原话的整件应记跳过原因');
  assert.ok(res.skipped.some((s) => s.reason.includes('1 句原话的来源不在选定范围内')), '被丢弃的 quote 应记一条原因');
  assert.ok(progress.includes('calling') && progress.includes('saving'));
});

test('extractExperiencesFromRange：引用撤回/已排除消息的原话被丢弃；说话人缺失时按消息角色补', async () => {
  seq = 0;
  const db = new MemoryBackend();
  const history = [
    msg('user', '秘密不要外传'),
    msg('assistant', '[阿澈的消息：好啊，下周六见]', { roundId: 'r1' }),
  ];
  history[0].isWithdrawn = true;
  history[0].originalContent = '秘密不要外传';
  const callChat = fakeExtractionReply([
    {
      title: '混了撤回原话', summary: '一半引用已撤回的消息。',
      quotes: [
        { text: '秘密不要外传', messageId: 'm1' }, // 已撤回：不在有效集合里
        { text: '好啊，下周六见', messageId: 'm2' }, // 说话人缺失：按角色补阿澈
      ],
      speakers: [], timestamp: null, plan_state: 'none',
    },
  ]);
  const res = await extractExperiencesFromRange(db, ch, history, {
    summaryApi: SUMMARY_API, callSummaryChat: callChat,
  });
  assert.equal(res.created.length, 1);
  assert.equal(res.created[0].quotes.length, 1);
  assert.equal(res.created[0].quotes[0].messageId, 'm2');
  assert.equal(res.created[0].quotes[0].speaker, '阿澈');
  assert.equal(res.created[0].quotes[0].text.includes('秘密'), false);
});

test('extractExperiencesFromRange：副模型返回非 JSON 时报错、不写库；未配置副 API 时报错', async () => {
  seq = 0;
  const db = new MemoryBackend();
  const history = [
    msg('user', '你好'),
    msg('assistant', '[阿澈的消息：嗨]', { roundId: 'r1' }),
  ];
  await assert.rejects(
    extractExperiencesFromRange(db, ch, history, {
      summaryApi: SUMMARY_API, callSummaryChat: async () => '今天天气不错',
    }),
    /不是有效的 JSON 数组/,
  );
  assert.equal((await db.getAll('experiences')).length, 0);
  await assert.rejects(
    extractExperiencesFromRange(db, ch, history, {
      summaryApi: { url: '', key: '', model: '' }, callSummaryChat: async () => '[]',
    }),
    /未配置记忆总结副 API/,
  );
});

test('extractExperiencesFromRange：选定范围没有有效消息时返回 skipped、不调 API', async () => {
  seq = 0;
  const db = new MemoryBackend();
  let called = false;
  const history = [
    msg('assistant', '[阿澈更新状态为：开心]', { isStatusUpdate: true }),
    msg('assistant', '<thinking>想</thinking>'),
  ];
  const res = await extractExperiencesFromRange(db, ch, history, {
    summaryApi: SUMMARY_API,
    callSummaryChat: async () => { called = true; return '[]'; },
  });
  assert.deepEqual(res.created, []);
  assert.equal(res.skipped.length, 1);
  assert.match(res.skipped[0].reason, /没有可提取的有效消息/);
  assert.equal(called, false);
  assert.equal((await db.getAll('experiences')).length, 0);
});

/* ---------- 联想线索字段（第 3 波） ---------- */
test('经历记录默认带 clues=[] 与 lastMentionedRoundSeq=null；非法线索形状被丢弃', async () => {
  const { normalizeClue, normalizeClues } = await import('../js/experiences.js');
  const rec = createExperienceRecord({
    charId: 'char_1', title: '海边之约', summary: '约好下周六去海边。',
    quotes: [quote('下周六去海边吧', 'm1')],
    clues: [
      { text: '约好去海边', kind: 'context', excerpt: '约好下周六去海边。', sourceMessageIds: ['m1'], evidenceVersion: 1 },
      { text: '种类不对', kind: 'other', excerpt: '约好下周六去海边。', sourceMessageIds: ['m1'], evidenceVersion: 1 },
      { text: '没有来源', kind: 'quote', excerpt: '下周六去海边吧', sourceMessageIds: [], evidenceVersion: 1 },
    ],
    lastMentionedRoundSeq: 7,
  });
  assert.equal(rec.clues.length, 1, '只有形状合法的线索留下');
  assert.equal(rec.clues[0].kind, 'context');
  assert.equal(rec.lastMentionedRoundSeq, 7);
  assert.deepEqual(createExperienceRecord({
    charId: 'char_1', title: '无线索', summary: 'x',
    quotes: [quote('下周六去海边吧', 'm1')],
  }).clues, []);
  assert.equal(createExperienceRecord({
    charId: 'char_1', title: '无序号', summary: 'x',
    quotes: [quote('下周六去海边吧', 'm1')],
  }).lastMentionedRoundSeq, null);
  assert.equal(normalizeClue(null), null);
  assert.equal(normalizeClue({ text: 'x', kind: 'context', excerpt: 'y', sourceMessageIds: ['m1'] }), null, '缺 evidenceVersion 不合法');
  assert.equal(normalizeClues(new Array(6).fill({
    text: 'x', kind: 'context', excerpt: 'y', sourceMessageIds: ['m1'], evidenceVersion: 1,
  })).length, 4, '线索最多 4 条');
});

test('updateExperience 白名单含 clues / lastMentionedRoundSeq（version+1）；updateExperienceMeta 只写元数据不 bump version', async () => {
  const { updateExperienceMeta } = await import('../js/experiences.js');
  const db = new MemoryBackend();
  await db.init();
  const rec = createExperienceRecord({
    charId: 'char_1', title: '海边之约', summary: '约好下周六去海边。',
    quotes: [quote('下周六去海边吧', 'm1')],
  });
  await db.put('experiences', rec);
  const edited = await updateExperience(db, rec.id, {
    clues: [{ text: '约好去海边', kind: 'context', excerpt: '约好下周六去海边。', sourceMessageIds: ['m1'], evidenceVersion: 2 }],
    lastMentionedRoundSeq: 5,
  });
  assert.equal(edited.version, 2, '内容编辑 version+1');
  assert.equal(edited.clues.length, 1);
  assert.equal(edited.lastMentionedRoundSeq, 5);
  // 元数据写路径：不 bump version（线索 evidenceVersion 才不会刚写就过期，
  // 回执更新序号也不会让线索失效）
  const meta = await updateExperienceMeta(db, rec.id, {
    clues: [{ text: '新线索', kind: 'future', excerpt: '约好下周六去海边。', sourceMessageIds: ['m1'], evidenceVersion: 2 }],
    lastMentionedRoundSeq: 9,
    title: '不该被改掉的标题',
  });
  assert.equal(meta.version, 2, 'updateExperienceMeta 不 bump version');
  assert.equal(meta.clues[0].text, '新线索');
  assert.equal(meta.lastMentionedRoundSeq, 9);
  assert.equal(meta.title, '海边之约', '白名单外的字段被忽略');
  assert.equal(await updateExperienceMeta(db, 'nope', { clues: [] }), null);
});
