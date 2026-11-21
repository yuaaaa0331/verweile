// associative.test.mjs — 联想召回（第 3 波）：线索生成 / 候选检索 /
// 副模型选择 / 超时与预算 / 冷却 6 轮 / 回执结算。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLUE_KIND_LABELS, DEFAULT_ASSOC_BUDGET_LIMIT,
  ASSOC_PICK_TIMEOUT_MS, ASSOC_VERIFY_TIMEOUT_MS,
  isSummaryApiConfigured, validClues, clueTextFor,
  buildClueGenerationRequest, validateClueAgainstExperience,
  parseClueGenerationResponse, generateCluesForExperience,
  monthKey, loadAssocBudget, saveAssocBudget, checkAssocBudget, consumeAssocBudget,
  getCompletedRoundSeq, bumpCompletedRoundSeq, isCooledDown, isExplicitFollowup,
  findAssocCandidates, buildAssocPickRequest, emptyPick, parseAssocPickResponse,
  pickAssocCandidate, emptyAssoc, runAssocForChat,
  dateMarkers, markerMentioned, buildAssocVerifyRequest, parseAssocVerifyResponse,
  getAssocReceipts, latestReceiptForExp, receiptStatusText, settleAssocReceipt,
} from '../js/associative.js';
import { createExperienceRecord, updateExperienceMeta } from '../js/experiences.js';
import { buildKeywordIndex, retrievalDocsForChar } from '../js/keywordSearch.js';
import { MemoryBackend } from '../js/storage.js';

const SUMMARY_API = { provider: 'openai', url: 'https://api.example.com/v1', key: 'sk-test', model: 'gpt-4o-mini' };
const CHAR = 'char_1';

function expFixture(over = {}) {
  return createExperienceRecord({
    charId: CHAR,
    title: '海边之约',
    summary: '约好下周六去海边看日落。',
    quotes: [{ text: '下周六去海边吧', messageId: 'm1', speaker: '朵朵' }],
    speakers: ['朵朵', '阿澈'],
    timestamp: new Date(2026, 10, 14, 15, 0, 0).getTime(),
    sourceMessageIds: ['m1'],
    ...over,
  });
}

function clueFixture(over = {}) {
  return {
    text: '约好下周六去海边',
    kind: 'context',
    excerpt: '约好下周六去海边看日落。',
    sourceMessageIds: ['m1'],
    evidenceVersion: 1,
    ...over,
  };
}

async function backendWithExps(exps) {
  const db = new MemoryBackend();
  await db.init();
  for (const e of exps) await db.put('experiences', e);
  return db;
}

/* ---------- 线索：0–4 条且每条有原文依据 ---------- */
test('线索解析：最多 4 条；excerpt/来源对不上原文、种类不对的丢弃；0 条合法', () => {
  const exp = expFixture();
  const text = JSON.stringify([
    clueFixture({ kind: 'context' }),
    clueFixture({ kind: 'quote', text: '最特别的一句原话', excerpt: '下周六去海边吧' }),
    clueFixture({ kind: 'future', text: '以后会怎么问起海边', excerpt: '约好下周六去海边看日落。' }),
    clueFixture({ kind: 'context', text: '编造的片段', excerpt: '我们去了游乐园' }),
    clueFixture({ kind: 'other', text: '种类不对', excerpt: '约好下周六去海边看日落。' }),
    clueFixture({ kind: 'context', text: '来源不对', excerpt: '约好下周六去海边看日落。', sourceMessageIds: ['m999'] }),
  ]);
  const { clues, dropped } = parseClueGenerationResponse(text, exp);
  assert.equal(clues.length, 3, '只保留有效线索');
  assert.deepEqual(clues.map((c) => c.kind), ['context', 'quote', 'future']);
  assert.ok(clues.every((c) => c.evidenceVersion === 1));
  assert.ok(clues.every((c) => c.sourceMessageIds.includes('m1')));
  assert.equal(dropped.length, 3, '编造片段 / 种类不对 / 来源不对各丢一条');
  // 5 条有效 → 只保留前 4 条
  const five = JSON.stringify([0, 1, 2, 3, 4].map((i) => clueFixture({
    kind: ['context', 'quote', 'future', 'unfinished', 'context'][i],
    text: `第 ${i + 1} 条线索`,
  })));
  assert.equal(parseClueGenerationResponse(five, exp).clues.length, 4);
  assert.deepEqual(parseClueGenerationResponse('[]', exp), { clues: [], dropped: [] });
  assert.deepEqual(parseClueGenerationResponse('```json\n[]\n```', exp), { clues: [], dropped: [] });
});

test('线索解析：不是 JSON 数组时抛错（不写库）', () => {
  const exp = expFixture();
  assert.throws(() => parseClueGenerationResponse('你好', exp), /JSON 数组/);
  assert.throws(() => parseClueGenerationResponse('{"a":1}', exp), /JSON 数组/);
});

test('线索校验：excerpt 必须是原文子串，sourceMessageIds 必须在来源集合里', () => {
  const exp = expFixture();
  assert.equal(validateClueAgainstExperience(clueFixture(), exp), true);
  assert.equal(validateClueAgainstExperience(clueFixture({ excerpt: '下周六去海边吧' }), exp), true);
  assert.equal(validateClueAgainstExperience(clueFixture({ excerpt: '没出现过的话' }), exp), false);
  assert.equal(validateClueAgainstExperience(clueFixture({ sourceMessageIds: ['m1', 'm2'] }), exp), false);
  assert.equal(validateClueAgainstExperience(clueFixture({ kind: 'other' }), exp), false);
  assert.equal(validateClueAgainstExperience(clueFixture({ text: '' }), exp), false);
  assert.equal(validateClueAgainstExperience(clueFixture({ evidenceVersion: 'x' }), exp), false);
});

test('生成线索：副 API 返回的线索写进经历，不 bump version；未配置副 API 时静默跳过', async () => {
  const exp = expFixture();
  const db = await backendWithExps([exp]);
  let calls = 0;
  const fakeChat = async (cfg, messages) => {
    calls++;
    assert.ok(messages.some((m) => m.content.includes('海边之约')), '请求里带经历内容');
    return JSON.stringify([
      clueFixture({ kind: 'context' }),
      clueFixture({ kind: 'quote', text: '原话线索', excerpt: '下周六去海边吧' }),
    ]);
  };
  const res = await generateCluesForExperience(db, exp, { summaryApi: SUMMARY_API, callSummaryChat: fakeChat });
  assert.equal(calls, 1);
  assert.equal(res.clues.length, 2);
  const saved = await db.get('experiences', exp.id);
  assert.equal(saved.version, 1, '线索写入不 bump version，否则 evidenceVersion 刚写就过期');
  assert.equal(saved.clues.length, 2);
  assert.ok(saved.clues.every((c) => c.evidenceVersion === 1));

  // 未配置副 API：不调用，静默返回
  const res2 = await generateCluesForExperience(db, exp, { summaryApi: {}, callSummaryChat: fakeChat });
  assert.equal(calls, 1, '未配置副 API 时不调接口');
  assert.deepEqual(res2, { clues: [], dropped: [], skipped: 'no-api' });
  assert.equal(isSummaryApiConfigured({}), false);
  assert.equal(isSummaryApiConfigured(SUMMARY_API), true);
});

test('生成线索：副 API 返回非法 JSON 时抛错，不写库', async () => {
  const exp = expFixture();
  const db = await backendWithExps([exp]);
  await assert.rejects(
    () => generateCluesForExperience(db, exp, {
      summaryApi: SUMMARY_API, callSummaryChat: async () => '不是 JSON',
    }),
    /JSON 数组/,
  );
  assert.deepEqual((await db.get('experiences', exp.id)).clues, []);
});

/* ---------- 证据版本过期失效 ---------- */
test('证据版本过期：经历被编辑（version+1）后旧线索失效；新线索以新 version 为准', async () => {
  const exp = expFixture({ clues: [clueFixture({ evidenceVersion: 1 })] });
  const db = await backendWithExps([exp]);
  assert.equal(validClues(exp).length, 1);
  // 模拟内容编辑：version 1 → 2（走 updateExperienceMeta 不 bump 的是线索写路径；
  // 这里直接改 version 模拟一次内容编辑）
  await db.put('experiences', { ...exp, version: 2 });
  const edited = await db.get('experiences', exp.id);
  assert.equal(validClues(edited).length, 0, 'evidenceVersion=1 的线索在 version=2 时失效');
  assert.equal(clueTextFor(edited), '海边之约', '失效线索不进检索文本，只剩标题');
  // 重新生成：evidenceVersion 取当前 version
  const res = parseClueGenerationResponse(
    JSON.stringify([clueFixture({ kind: 'future', text: '还会再去海边吗', excerpt: '约好下周六去海边看日落。' })]),
    edited,
  );
  assert.equal(res.clues[0].evidenceVersion, 2);
  await updateExperienceMeta(db, exp.id, { clues: res.clues });
  const again = await db.get('experiences', exp.id);
  assert.equal(again.version, 2, '线索重写不 bump version');
  assert.equal(validClues(again).length, 1);
});

/* ---------- 副模型选择：选空合法 ---------- */
test('联想选空合法：mode none / pick null / pick 不在候选里 / 解析失败都按选空', () => {
  const ids = ['exp_a', 'exp_b'];
  assert.deepEqual(parseAssocPickResponse('{"mode":"none","pick":null,"use":"understand","reason":"没联想"}', ids), {
    mode: 'none', pick: null, use: 'understand', reason: '没联想', status: 'none',
  });
  assert.equal(parseAssocPickResponse('{"mode":"pick","pick":null,"use":"mention","reason":"x"}', ids).mode, 'none');
  assert.equal(parseAssocPickResponse('{"mode":"pick","pick":"exp_nope","use":"mention","reason":"x"}', ids).mode, 'none');
  assert.equal(parseAssocPickResponse('这不是 JSON', ids).mode, 'none');
  assert.equal(parseAssocPickResponse('{"mode":"pick"}', ids).mode, 'none');
  assert.equal(parseAssocPickResponse('```json\n{"mode":"pick","pick":"exp_a","use":"mention","reason":"在聊海边"}\n```', ids).pick, 'exp_a');
  const picked = parseAssocPickResponse('{"mode":"pick","pick":"exp_b","use":"weird","reason":"r"}', ids);
  assert.equal(picked.mode, 'pick');
  assert.equal(picked.use, 'understand', 'use 非法时回落到 understand');
  assert.equal(picked.status, 'picked');
  // 给副模型看的候选卡片不含向量分数
  const req = buildAssocPickRequest({
    candidates: [{ docId: 'exp_a', title: '海边之约', date: '2026-11-14', clues: [clueFixture()], quotes: [{ text: '下周六去海边吧', speaker: '朵朵' }], score: 0.99 }],
    queryText: '海边',
  });
  assert.ok(!JSON.stringify(req).includes('0.99'), '候选卡片不含向量分数');
  assert.ok(JSON.stringify(req).includes('海边之约'));
});

test('联想选择超时按选空：永不返回的副 API 在 timeoutMs 内返回 none，不抛错', async () => {
  const never = () => new Promise(() => {});
  const start = Date.now();
  const res = await pickAssocCandidate({
    summaryApi: SUMMARY_API, callSummaryChat: never,
    candidates: [{ docId: 'exp_a', title: '海边之约', clues: [], quotes: [] }],
    queryText: '海边', timeoutMs: 30,
  });
  const elapsed = Date.now() - start;
  assert.equal(res.mode, 'none');
  assert.equal(res.pick, null);
  assert.equal(res.status, 'timeout');
  assert.ok(elapsed < 2000, `超时应在 30ms 左右返回，实际 ${elapsed}ms`);
  assert.ok(elapsed >= 25, '不应在超时前就返回');
});

test('联想选择：副模型报错也按选空，不抛错', async () => {
  const res = await pickAssocCandidate({
    summaryApi: SUMMARY_API, callSummaryChat: async () => { throw new Error('500 服务商出问题'); },
    candidates: [{ docId: 'exp_a', title: '海边之约', clues: [], quotes: [] }],
    queryText: '海边', timeoutMs: 1000,
  });
  assert.equal(res.mode, 'none');
  assert.equal(res.status, 'error');
  assert.equal((await pickAssocCandidate({ summaryApi: {}, candidates: [{ docId: 'x' }], queryText: 'q' })).status, 'no-api');
  assert.equal((await pickAssocCandidate({ summaryApi: SUMMARY_API, candidates: [], queryText: 'q' })).status, 'no-candidates');
  assert.ok(ASSOC_PICK_TIMEOUT_MS <= 8000);
  assert.ok(ASSOC_VERIFY_TIMEOUT_MS < ASSOC_PICK_TIMEOUT_MS);
});

/* ---------- 预算 ---------- */
test('预算：默认 300 次/月；跨月归零；超限返回 null，消费写库', async () => {
  const db = new MemoryBackend();
  await db.init();
  const cur = monthKey(new Date());
  assert.deepEqual(await loadAssocBudget(db), { month: cur, used: 0, limit: DEFAULT_ASSOC_BUDGET_LIMIT });
  assert.equal(DEFAULT_ASSOC_BUDGET_LIMIT, 300);
  await saveAssocBudget(db, { month: '2000-01', used: 299, limit: 300 });
  assert.deepEqual(await loadAssocBudget(db), { month: cur, used: 0, limit: 300 }, '跨月归零，但 limit 保留');
  await saveAssocBudget(db, { month: cur, used: 299, limit: 300 });
  assert.deepEqual(await checkAssocBudget(db), { allowed: true, used: 299, limit: 300, budgetLeft: 1, month: cur });
  assert.deepEqual(await consumeAssocBudget(db), { used: 300, limit: 300, budgetLeft: 0 });
  assert.equal((await checkAssocBudget(db)).allowed, false);
  assert.equal(await consumeAssocBudget(db), null, '超限不再消费');
  assert.equal((await loadAssocBudget(db)).used, 300);
});

test('预算超限跳过联想：runAssocForChat 返回 budget-exceeded，不调副模型', async () => {
  const exp = expFixture({ id: 'exp_a', clues: [clueFixture()] });
  const db = await backendWithExps([exp]);
  await saveAssocBudget(db, { month: monthKey(new Date()), used: 300, limit: 300 });
  let calls = 0;
  const res = await runAssocForChat({
    backend: db, charId: CHAR, queryText: '海边',
    experiences: [exp], summaryApi: SUMMARY_API,
    callSummaryChat: async () => { calls++; return '{"mode":"pick","pick":"exp_a","use":"mention","reason":"x"}'; },
  });
  assert.equal(res.status, 'budget-exceeded');
  assert.equal(res.pick, null);
  assert.equal(res.budgetLeft, 0);
  assert.equal(calls, 0, '超预算不调副模型');
});

/* ---------- 冷却 6 轮（按 roundId/序号，不按气泡） ---------- */
test('冷却：lastMentionedRoundSeq 在 6 轮内排除，7 轮外恢复；序号与气泡数无关', async () => {
  const cooled = expFixture({ id: 'exp_cooled', clues: [clueFixture()], lastMentionedRoundSeq: 10 });
  const old = expFixture({ id: 'exp_old', title: '旧海边', clues: [clueFixture()], lastMentionedRoundSeq: 3 });
  const fresh = expFixture({ id: 'exp_fresh', title: '新海边', clues: [clueFixture()], lastMentionedRoundSeq: null });
  const db = await backendWithExps([cooled, old, fresh]);
  // currentSeq=16：cooled 差 6 轮（在冷却内），old 差 13 轮（已过冷却）
  const found = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [cooled, old, fresh],
    queryText: '海边', currentSeq: 16,
  });
  const ids = found.map((c) => c.docId);
  assert.ok(!ids.includes('exp_cooled'), '差 6 轮仍在冷却期内');
  assert.ok(ids.includes('exp_old'), '差 13 轮已过冷却');
  assert.ok(ids.includes('exp_fresh'));
  // currentSeq=17：cooled 差 7 轮，恢复
  const found2 = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [cooled, old, fresh],
    queryText: '海边', currentSeq: 17,
  });
  assert.ok(found2.map((c) => c.docId).includes('exp_cooled'), '差 7 轮恢复候选');
  assert.equal(isCooledDown({ lastMentionedRoundSeq: 10 }, 16), true);
  assert.equal(isCooledDown({ lastMentionedRoundSeq: 10 }, 17), false);
  assert.equal(isCooledDown({ lastMentionedRoundSeq: null }, 16), false);
});

test('明确追问绕过冷却：关键词路命中前 3 时绕过；在 fusedRetrieve results 里的直接去重（已准确召回，无需联想）', async () => {
  const cooled = expFixture({ id: 'exp_cooled', clues: [clueFixture()], lastMentionedRoundSeq: 15 });
  const db = await backendWithExps([cooled]);
  const withoutFollowup = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [cooled],
    queryText: '海边', currentSeq: 16, fusedResults: [],
  });
  assert.equal(withoutFollowup.length, 0, '冷却期内、无追问：排除');
  // 关键词路前 3（索引里跑一次当轮查询）：绕过冷却，进入联想候选
  await buildKeywordIndex(db, CHAR, retrievalDocsForChar([], [cooled]));
  const withKeywordTop3 = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [cooled],
    queryText: '海边', currentSeq: 16, fusedResults: [],
  });
  assert.equal(withKeywordTop3.length, 1, '关键词路命中前 3：绕过冷却');
  // 已在 fusedRetrieve results 里的：联想候选里按 docId 去重（已准确召回）
  const alreadyRetrieved = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [cooled],
    queryText: '海边', currentSeq: 16,
    fusedResults: [{ docId: 'exp_cooled', keywordRank: 5 }],
  });
  assert.equal(alreadyRetrieved.length, 0, '已在准确检索结果里：联想候选去重，不重复选');
  assert.equal(isExplicitFollowup(cooled, [{ docId: 'exp_cooled' }]), true);
  assert.equal(isExplicitFollowup(cooled, [], ['exp_cooled']), true, '关键词路前 3 也绕过');
  assert.equal(isExplicitFollowup(cooled, [{ docId: 'other' }]), false);
});

test('已完成 AI 回合序号：每角色独立，+1 递增', async () => {
  const db = new MemoryBackend();
  await db.init();
  assert.equal(await getCompletedRoundSeq(db, 'char_1'), 0);
  assert.equal(await bumpCompletedRoundSeq(db, 'char_1'), 1);
  assert.equal(await bumpCompletedRoundSeq(db, 'char_1'), 2);
  assert.equal(await getCompletedRoundSeq(db, 'char_2'), 0, '角色之间隔离');
  assert.equal(await bumpCompletedRoundSeq(db, 'char_2'), 1);
  assert.equal(await getCompletedRoundSeq(db, 'char_1'), 2);
});

/* ---------- 候选检索：去重与排除规则 ---------- */
test('候选检索：与 fusedRetrieve 结果按 docId 去重；失效/不参与检索/无出处/无线索不得入选', async () => {
  const good = expFixture({ id: 'exp_good', clues: [clueFixture()] });
  const dup = expFixture({ id: 'exp_dup', title: '海边重复', clues: [clueFixture()] });
  const invalid = expFixture({ id: 'exp_invalid', title: '海边失效', status: 'invalid', clues: [clueFixture()] });
  const optedOut = expFixture({ id: 'exp_out', title: '海边不参与', retrievalEnabled: false, clues: [clueFixture()] });
  const noClue = expFixture({ id: 'exp_noclue', title: '海边无线索' });
  const staleClue = expFixture({ id: 'exp_stale', title: '海边过期线索', clues: [clueFixture({ evidenceVersion: 99 })] });
  const unsourced = expFixture({ id: 'exp_nosrc', title: '海边无出处', quotes: [], sourceMessageIds: [], clues: [] });
  const db = await backendWithExps([good, dup, invalid, optedOut, noClue, staleClue, unsourced]);
  const found = await findAssocCandidates({
    backend: db, charId: CHAR,
    experiences: [good, dup, invalid, optedOut, noClue, staleClue, unsourced],
    queryText: '海边', currentSeq: 0,
    fusedResults: [{ docId: 'exp_dup' }],
  });
  assert.deepEqual(found.map((c) => c.docId), ['exp_good']);
  assert.equal(found[0].docKind, 'experience');
  assert.equal(found[0].clues.length, 1);
  assert.equal(found[0].quotes[0].text, '下周六去海边吧');
  assert.equal((await findAssocCandidates({ backend: db, charId: CHAR, experiences: [good], queryText: '  ', currentSeq: 0 })).length, 0, '空查询无候选');
});

test('候选检索：向量路——线索向量与查询向量相似的入选，不相似的不入选', async () => {
  const sea = expFixture({ id: 'exp_sea', title: '海边之约', clues: [clueFixture({ text: '海边', excerpt: '约好下周六去海边看日落。' })] });
  const cat = expFixture({ id: 'exp_cat', title: '猫咪', summary: '养了一只猫咪。', quotes: [{ text: '猫咪很可爱', messageId: 'm2', speaker: '朵朵' }], sourceMessageIds: ['m2'], clues: [clueFixture({ text: '猫咪', excerpt: '猫咪很可爱', sourceMessageIds: ['m2'] })] });
  const db = await backendWithExps([sea, cat]);
  const embedTexts = async (texts) => ({
    vectors: texts.map((t) => (t.includes('海边') ? [1, 0] : [0, 1])),
    dimensions: 2,
  });
  const found = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [sea, cat],
    queryText: 'zzzqqq', queryEmbedding: [1, 0], spaceKey: 'test-space',
    embedTexts, currentSeq: 0,
  });
  assert.deepEqual(found.map((c) => c.docId), ['exp_sea'], '查询词与线索无共有词时只靠向量路');
  assert.equal(found[0].vectorRank, 1);
  assert.equal(found[0].keywordRank, null);
  // 向量接口失败时只走关键词路，不抛错（用二元字串“猫咪”：单字“猫”自 4b
  // 修复起不再当 term，单字查询进不了关键词路）
  const fallback = await findAssocCandidates({
    backend: db, charId: CHAR, experiences: [sea, cat],
    queryText: '猫咪', queryEmbedding: [1, 0], spaceKey: 'test-space',
    embedTexts: async () => { throw new Error('向量接口挂了'); },
    currentSeq: 0,
  });
  assert.deepEqual(fallback.map((c) => c.docId), ['exp_cat']);
});

/* ---------- runAssocForChat 总入口 ---------- */
test('runAssocForChat：选中时返回完整 assoc 结构并消费一次预算；开关关/无副 API 时不调接口', async () => {
  const exp = expFixture({ id: 'exp_a', clues: [clueFixture()] });
  const db = await backendWithExps([exp]);
  let calls = 0;
  const fakePick = async () => {
    calls++;
    return '{"mode":"pick","pick":"exp_a","use":"mention","reason":"正在聊海边"}';
  };
  const res = await runAssocForChat({
    backend: db, charId: CHAR, queryText: '海边',
    experiences: [exp], summaryApi: SUMMARY_API, callSummaryChat: fakePick,
  });
  assert.equal(res.status, 'ok');
  assert.equal(res.pick, 'exp_a');
  assert.equal(res.mode, 'pick');
  assert.equal(res.use, 'mention');
  assert.equal(res.reason, '正在聊海边');
  assert.deepEqual(res.candidates, [{ docId: 'exp_a', docKind: 'experience', title: '海边之约' }]);
  assert.equal(res.budgetLeft, 299);
  assert.ok(Number.isFinite(res.injectedAt));
  assert.equal(calls, 1);
  assert.equal((await loadAssocBudget(db)).used, 1, '选中消费一次预算');

  const off = await runAssocForChat({
    backend: db, charId: CHAR, queryText: '海边',
    experiences: [exp], summaryApi: SUMMARY_API, callSummaryChat: fakePick, assocEnabled: false,
  });
  assert.equal(off.status, 'disabled');
  assert.equal(off.pick, null);
  const noApi = await runAssocForChat({
    backend: db, charId: CHAR, queryText: '海边',
    experiences: [exp], summaryApi: {}, callSummaryChat: fakePick,
  });
  assert.equal(noApi.status, 'no-api');
  assert.equal(calls, 1, '开关关 / 无副 API 时不调接口');
  assert.deepEqual(emptyAssoc('none'), {
    pick: null, mode: 'none', use: 'understand', reason: '',
    candidates: [], budgetLeft: null, injectedAt: null, status: 'none',
  });
});

/* ---------- 回执结算 ---------- */
test('回执标记匹配：关键原话/日期出现即算提及，否则不算', () => {
  const exp = expFixture();
  assert.equal(markerMentioned('好啊，下周六去海边吧！', exp).mentioned, true, '关键原话原样出现');
  assert.equal(markerMentioned('好啊，那就这么定了。', exp).mentioned, false);
  assert.equal(markerMentioned('记得 2026-11-14 那天吗？', exp).mentioned, true, '日期 YYYY-MM-DD 出现');
  assert.equal(markerMentioned('11月14日那天', exp).mentioned, true, '日期 M月D日 出现');
  assert.equal(markerMentioned('小池也来了', exp).mentioned, false, '与经历无关的名字不算');
  const withName = markerMentioned('阿澈也记得这件事', expFixture({ speakers: ['朵朵', '小池'] }), { excludeNames: ['阿澈', '朵朵'] });
  assert.equal(withName.mentioned, false, '角色本人的名字被排除后不算；小池不在回复里');
  assert.equal(markerMentioned('小池也记得', expFixture({ speakers: ['朵朵', '小池'] }), { excludeNames: ['阿澈', '朵朵'] }).mentioned, true, '参与人名字出现算提及');
  assert.deepEqual(dateMarkers(new Date(2026, 0, 5).getTime()), ['2026-01-05', '2026年1月5日', '1月5日']);
});

test('回执结算：标记命中 → mentioned=true/marker，不调副模型；回执写库并更新 lastMentionedRoundSeq', async () => {
  const exp = expFixture({ id: 'exp_a', clues: [clueFixture()] });
  const db = await backendWithExps([exp]);
  await bumpCompletedRoundSeq(db, CHAR);
  await bumpCompletedRoundSeq(db, CHAR);
  let calls = 0;
  const receipt = await settleAssocReceipt({
    backend: db, charId: CHAR, roundId: 'round_1', replyText: '好啊，下周六去海边吧！',
    assoc: { pick: 'exp_a', injectedAt: 111 },
    summaryApi: SUMMARY_API,
    callSummaryChat: async () => { calls++; return '{"mentioned":false,"reason":"x"}'; },
  });
  assert.equal(calls, 0, '标记命中不调副模型核验');
  assert.deepEqual(receipt, {
    experienceId: 'exp_a', roundId: 'round_1', injectedAt: 111,
    mentioned: true, checkedAt: receipt.checkedAt, method: 'marker',
  });
  assert.equal((await getAssocReceipts(db)).length, 1);
  assert.equal(latestReceiptForExp(await getAssocReceipts(db), 'exp_a').mentioned, true);
  assert.equal((await db.get('experiences', 'exp_a')).lastMentionedRoundSeq, 2, '提及后序号记为当前已完成回合数');
  assert.equal(receiptStatusText(receipt), '最近回执：已提及（原文标记）');
  assert.equal(receiptStatusText(null), '未注入过');
});

test('回执结算：标记未命中时用副模型改述核验；副模型不可用时只用标记匹配的结果', async () => {
  const exp = expFixture({ id: 'exp_a', clues: [clueFixture()] });
  const db = await backendWithExps([exp]);
  await bumpCompletedRoundSeq(db, CHAR);
  // 副模型说提到了（改述）：mentioned=true，method='model'
  let calls = 0;
  const r1 = await settleAssocReceipt({
    backend: db, charId: CHAR, roundId: 'round_1', replyText: '那次约好的海边日落还记得吗？',
    assoc: { pick: 'exp_a', injectedAt: 111 },
    summaryApi: SUMMARY_API,
    callSummaryChat: async () => { calls++; return '{"mentioned":true,"reason":"改述提及海边之约"}'; },
  });
  assert.equal(calls, 1);
  assert.equal(r1.mentioned, true);
  assert.equal(r1.method, 'model');
  assert.equal(receiptStatusText(r1), '最近回执：已提及（副模型核验）');
  assert.equal((await loadAssocBudget(db)).used, 1, '改述核验计一次预算');

  // 副模型不可用：只用标记匹配的结果（未命中 → mentioned=false，method='marker'）
  const r2 = await settleAssocReceipt({
    backend: db, charId: CHAR, roundId: 'round_2', replyText: '今天天气真好。',
    assoc: { pick: 'exp_a', injectedAt: 222 },
    summaryApi: SUMMARY_API,
    callSummaryChat: async () => { throw new Error('副 API 挂了'); },
  });
  assert.equal(r2.mentioned, false);
  assert.equal(r2.method, 'marker');
  assert.equal(receiptStatusText(r2), '最近回执：已注入，未提及');
  assert.equal((await db.get('experiences', 'exp_a')).lastMentionedRoundSeq, 1, '未提及不更新序号');
  assert.equal((await getAssocReceipts(db)).length, 2);
  assert.equal(latestReceiptForExp(await getAssocReceipts(db), 'exp_a').roundId, 'round_2', '最近一条在前');

  // 没有 pick：返回 null，不写回执
  const r3 = await settleAssocReceipt({
    backend: db, charId: CHAR, roundId: 'round_3', replyText: 'xxx',
    assoc: { pick: null }, summaryApi: SUMMARY_API,
    callSummaryChat: async () => '{"mentioned":true,"reason":"x"}',
  });
  assert.equal(r3, null);
  assert.equal((await getAssocReceipts(db)).length, 2);
});

test('回执结算：改述核验解析失败按未提及处理；回执只保留最近 100 条', async () => {
  const exp = expFixture({ id: 'exp_a', clues: [clueFixture()] });
  const db = await backendWithExps([exp]);
  const seed = Array.from({ length: 100 }, (_, i) => ({
    experienceId: 'exp_old', roundId: `r${i}`, injectedAt: i, mentioned: false, checkedAt: i, method: 'marker',
  }));
  await db.put('settings', { key: 'assocReceipts', value: seed });
  const r = await settleAssocReceipt({
    backend: db, charId: CHAR, roundId: 'round_new', replyText: '今天天气真好。',
    assoc: { pick: 'exp_a', injectedAt: 1 },
    summaryApi: SUMMARY_API,
    callSummaryChat: async () => '不是 JSON',
    verifyTimeoutMs: 1000,
  });
  assert.equal(r.mentioned, false, '解析失败按未提及处理');
  assert.equal(parseAssocVerifyResponse('不是 JSON'), null);
  assert.equal(parseAssocVerifyResponse('{"mentioned":true,"reason":"x"}'), true);
  assert.equal(parseAssocVerifyResponse('{"mentioned":"yes"}'), null);
  const receipts = await getAssocReceipts(db);
  assert.equal(receipts.length, 100, '只保留最近 100 条');
  assert.equal(receipts[0].roundId, 'round_new');
  // 改述核验请求里带经历与回复
  const req = buildAssocVerifyRequest({ exp, replyText: '今天天气真好。' });
  assert.ok(JSON.stringify(req).includes('海边之约'));
  assert.ok(JSON.stringify(req).includes('今天天气真好。'));
});

test('线索生成请求：系统提示词要求 0–4 条、四种固定、excerpt 照抄原文', () => {
  const exp = expFixture();
  const req = buildClueGenerationRequest(exp);
  assert.equal(req.messages.length, 2);
  assert.ok(req.messages[0].content.includes('context'));
  assert.ok(req.messages[0].content.includes('0 条也合法'));
  assert.ok(req.messages[1].content.includes('[消息ID m1]'));
  assert.ok(req.messages[1].content.includes('下周六去海边吧'));
  assert.deepEqual(Object.keys(CLUE_KIND_LABELS).sort(), ['context', 'future', 'quote', 'unfinished']);
});
