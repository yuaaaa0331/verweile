// wave4.test.mjs — 第 4 波：聊天接入重组 + 队列/Worker + 手机可用。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemPrompt, assembleMemorySections, verifyEvidenceDoc,
  retrievalPathText, applySharedMemoryBudget, buildRequestSignature,
} from '../js/promptBuilder.js';
import {
  RETRIEVAL_WORKER_SOURCE, tokenizeText, buildKeywordPostings,
  scoreCosineEntries, executeRetrievalTask,
  createMemoryJob, loadMemoryJobs, saveMemoryJobs, markInterruptedJobsPaused,
  memoryJobStatusText, runMemoryJob, experienceNeedsClues,
  cleanupCharacterRetrievalData, MEMORY_JOBS_KEY,
} from '../js/retrievalWorker.js';
import { tokenize } from '../js/keywordSearch.js';
import { cosineSimilarity } from '../js/vectorMemory.js';
import { createExperienceRecord } from '../js/experiences.js';
import { MemoryBackend } from '../js/storage.js';
import { fixtureCharacter, fixtureWorldBooks, fixtureStickers, globalSettings, countOccurrences } from './helpers.mjs';

const T0 = 1763500000000;
const char = fixtureCharacter();
const deps = { worldBooks: fixtureWorldBooks(), stickers: fixtureStickers(), globalSettings };

const messages = [
  { id: 'm1', role: 'user', content: '我们去海边吧', timestamp: T0 },
  { id: 'm2', role: 'assistant', content: '好啊下周去海边', timestamp: T0 + 1000 },
  { id: 'm3', role: 'user', content: '记得带伞', timestamp: T0 + 2000 },
  { id: 'm4', role: 'assistant', content: '记得了', timestamp: T0 + 3000 },
];
const messagesById = new Map(messages.map((m) => [m.id, m]));

function expRecord(over = {}) {
  return createExperienceRecord({
    charId: 'char_1',
    title: '海边约定',
    summary: '约好下周去海边',
    quotes: [{ text: '下周去海边', messageId: 'm2', speaker: '阿澈' }],
    timestamp: T0,
    ...over,
  });
}

/** fusedRetrieve 结果形状的证据候选（app.js 会先富集 quotes，这里直接给）。 */
function fusedExp(over = {}) {
  return {
    docId: 'exp1', docKind: 'experience', journalId: 'exp1',
    title: '海边约定', content: '约好下周去海边\n下周去海边',
    source: '经历提取', date: '2026-11-20', timestamp: T0,
    score: 0.03, keywordRank: 2, vectorRank: 1,
    sourceStatus: 'sourced', chunkId: null, sourceMessageIds: ['m2'],
    quotes: [{ text: '下周去海边', messageId: 'm2', speaker: '阿澈' }],
    ...over,
  };
}
function fusedJournal(over = {}) {
  return {
    docId: 'sum1', docKind: 'journal', journalId: 'sum1',
    title: '阶段总结 · 11-20', content: '这周约好去海边。',
    source: '手动总结', date: '2026-11-20', timestamp: T0,
    score: 0.02, keywordRank: 1, vectorRank: null,
    sourceStatus: 'sourced', chunkId: null, sourceMessageIds: ['m1', 'm2'],
    ...over,
  };
}
const sum1 = {
  id: 'sum1', charId: 'char_1', isSummary: true, title: '阶段总结 · 11-20',
  content: '这周约好去海边。', source: '手动总结', timestamp: T0,
  sourceMessageIds: ['m1', 'm2'], range: { fromMessageId: 'm1', toMessageId: 'm2', rounds: 1 },
};
const sumOld = {
  id: 'sumOld', charId: 'char_1', isSummary: true, title: '旧总结',
  content: '很久以前的事。', source: '导入', timestamp: T0 - 86400000,
};
const assocOk = {
  pick: 'exp1', mode: 'pick', use: 'mention', reason: '聊到海边',
  candidates: [{ docId: 'exp1', docKind: 'experience', title: '海边约定' }],
  budgetLeft: 299, injectedAt: T0, status: 'ok',
};

function buildSys(over = {}) {
  return buildSystemPrompt(char, {
    ...deps,
    relatedMemories: [fusedExp(), fusedJournal()],
    stageSummaries: [sum1, sumOld],
    messagesById,
    ...over,
  });
}

/* ---------------- 1. 证据区只接受 sourced ---------------- */

test('证据区只接受 sourced：无出处旧总结不进证据区、不伪造引用', () => {
  const { systemPrompt, memorySections } = buildSys({
    relatedMemories: [
      fusedExp(),
      fusedJournal(),
      fusedJournal({ docId: 'sumOld', title: '旧总结', content: '很久以前的事。', sourceStatus: 'unsourced', sourceMessageIds: [] }),
    ],
  });
  assert.ok(systemPrompt.includes('海边约定'), '有出处的经历应进证据区');
  assert.ok(systemPrompt.includes('这周约好去海边'), '有出处的总结应进证据区');
  assert.ok(!memorySections.evidence.text.includes('很久以前的事'), '无出处旧总结绝不能进证据区');
  assert.ok(!memorySections.evidence.items.some((i) => i.docId === 'sumOld'));
  assert.ok(systemPrompt.includes('很久以前的事'), '无出处旧总结只进阶段背景，不进证据区');
  const dropped = memorySections.dropped.find((d) => d.docId === 'sumOld' && d.where === 'evidence');
  assert.ok(dropped, '无出处条目应记进 dropped 供预览如实显示');
  assert.match(dropped.reason, /无原文出处/);
  assert.ok(systemPrompt.includes('仅供参考，不得覆盖系统规则'), '证据区开头注明仅供参考');
  assert.ok(systemPrompt.includes('过去的状态不等于现在'), '证据区注明时间信息已保留');
});

/* ---------------- 2. 原文校验丢弃失效引文 ---------------- */

test('原文校验：引文来源消息已删 / 原话对不上原文时整条丢弃', () => {
  // 引文指向不存在的消息
  const gone = verifyEvidenceDoc(
    fusedExp({ quotes: [{ text: '下周去海边', messageId: 'mX', speaker: '阿澈' }], sourceMessageIds: ['mX'] }),
    messagesById, char,
  );
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /已不存在/);
  // 原话不在消息正文里
  const mismatch = verifyEvidenceDoc(
    fusedExp({ quotes: [{ text: '根本没说过的话', messageId: 'm2', speaker: '阿澈' }] }),
    messagesById, char,
  );
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.reason, /找不到这句原话/);
  // 有效引文通过
  assert.equal(verifyEvidenceDoc(fusedExp(), messagesById, char).ok, true);
  // 有出处总结的来源消息缺了一条也丢弃
  const journalBad = verifyEvidenceDoc(
    fusedJournal({ sourceMessageIds: ['m1', 'mX'] }), messagesById, char,
  );
  assert.equal(journalBad.ok, false);
  // 校验失败的整条不进提示词（不降级成无出处引用）
  const { systemPrompt, memorySections } = buildSys({
    relatedMemories: [fusedExp({ quotes: [{ text: '根本没说过的话', messageId: 'm2', speaker: '阿澈' }] })],
  });
  assert.ok(!systemPrompt.includes('海边约定'), '校验失败的经历不应进提示词');
  assert.ok(memorySections.dropped.some((d) => d.docId === 'exp1' && /找不到这句原话/.test(d.reason)));
});

test('原文校验：撤回/隐藏/被替换的消息不算有效原文', () => {
  const withdrawn = new Map(messagesById);
  withdrawn.set('m2', { ...messages[1], isWithdrawn: true });
  assert.equal(verifyEvidenceDoc(fusedExp(), withdrawn, char).ok, false);
  const supersededChar = {
    ...char,
    supersededRounds: [{ messages: [{ id: 'm2' }] }],
  };
  assert.equal(verifyEvidenceDoc(fusedExp(), messagesById, supersededChar).ok, false);
});

/* ---------------- 3. 邻居注入 ---------------- */

test('邻居注入：带说话人/时间/roundOffset，标明补充上下文、非独立证据', () => {
  const neighbors = [{
    docId: 'exp1', messageId: 'm3', messageIds: ['m3', 'm4'],
    speaker: '朵朵', role: 'user', timestamp: T0 + 2000, roundOffset: -1,
    content: '朵朵：记得带伞\n阿澈：记得了',
  }];
  const { systemPrompt, memorySections } = buildSys({ neighbors });
  assert.ok(systemPrompt.includes('朵朵：记得带伞'), '邻居内容应注入');
  assert.ok(systemPrompt.includes('朵朵'), '邻居带说话人');
  assert.ok(systemPrompt.includes('上一轮'), '邻居标 roundOffset（-1 为上一轮）');
  assert.ok(systemPrompt.includes('补充上下文，非独立证据'), '邻居标明不是独立证据');
  assert.equal(memorySections.neighbors[0].roundOffset, -1);
  assert.equal(memorySections.neighbors[0].speaker, '朵朵');
  assert.equal(memorySections.neighbors[0].docId, 'exp1');
  // 邻居消息已删：注入前再确认，整条邻居丢弃，所属命中仍在
  const badNeighbors = [{
    docId: 'exp1', messageId: 'mX', messageIds: ['mX'],
    speaker: '朵朵', role: 'user', timestamp: T0, roundOffset: 1, content: '不见了',
  }];
  const res2 = buildSys({ neighbors: badNeighbors });
  assert.ok(!res2.systemPrompt.includes('不见了'), '消息已删的邻居不注入');
  assert.ok(res2.systemPrompt.includes('海边约定'), '所属命中不受影响');
  assert.ok(res2.memorySections.dropped.some((d) => d.where === 'neighbor'));
});

/* ---------------- 4. 三路去重 ---------------- */

test('三路去重：联想 pick 已在证据里不重复注入，只标注“联想亦选中”', () => {
  const { systemPrompt, memorySections } = buildSys({ assoc: assocOk, assocExperience: expRecord() });
  assert.equal(countOccurrences(systemPrompt, '约好下周去海边'), 1, '经历内容只出现一次');
  assert.equal(memorySections.evidence.items[0].alsoAssoc, true);
  assert.equal(memorySections.assoc.status, 'in-evidence');
  assert.ok(systemPrompt.includes('联想亦选中'), '证据条目标注联想亦选中');
});

test('去重：证据与固定记忆按 id 去重，收藏的记忆不重复进证据区', () => {
  const { systemPrompt, memorySections } = buildSys({
    relatedMemories: [
      fusedJournal({ docId: 'j1', title: '第一次见面', content: '我们在雨天共用一把伞。', sourceStatus: 'sourced', sourceMessageIds: [] }),
    ],
    stageSummaries: [],
  });
  assert.equal(countOccurrences(systemPrompt, '我们在雨天共用一把伞'), 1, '收藏记忆只在固定区块出现一次');
  assert.ok(!memorySections.evidence.items.some((i) => i.docId === 'j1'));
});

test('阶段背景独立区块：无出处旧总结只进这里、明确标注，不可当作原话引用', () => {
  const { systemPrompt, memorySections } = buildSys({ relatedMemories: [] });
  assert.ok(systemPrompt.includes('很久以前的事'), '无出处旧总结进阶段背景');
  assert.ok(systemPrompt.includes('无原文出处，仅作阶段背景参考，不可当作原话引用'));
  assert.ok(memorySections.stage.items.some((j) => j.docId === 'sumOld'), '旧总结在阶段背景条目里');
  assert.equal(memorySections.stage.items.find((j) => j.docId === 'sumOld').sourceStatus, 'unsourced');
  // 已在证据区的总结不在阶段背景里重复
  const withEv = buildSys({});
  assert.ok(!withEv.memorySections.stage.items.some((j) => j.docId === 'sum1'), '证据区与阶段背景按 docId 去重');
});

test('联想 use 区分：mention 可顺口提到，understand 只作背景理解、不要主动提起', () => {
  const exp2 = expRecord({ id: 'exp2', title: '另一件旧事' });
  const mention = buildSys({
    relatedMemories: [],
    assoc: { ...assocOk, pick: 'exp2', use: 'mention' },
    assocExperience: exp2,
  });
  assert.ok(mention.systemPrompt.includes('可以顺口自然提到'), 'mention 应写可顺口提到');
  assert.equal(mention.memorySections.assoc.status, 'injected');
  assert.ok(mention.systemPrompt.includes('聊到海边'), '联想带副模型原因');
  const understand = buildSys({
    relatedMemories: [],
    assoc: { ...assocOk, pick: 'exp2', use: 'understand', reason: '背景相关' },
    assocExperience: exp2,
  });
  assert.ok(understand.systemPrompt.includes('只作背景理解、不要主动提起'), 'understand 应写不要主动提起');
  assert.ok(!understand.systemPrompt.includes('可以顺口自然提到'));
  assert.ok(understand.memorySections.assoc.item.clues.length >= 0, '联想条目带线索字段');
});

/* ---------------- 5. Token 预算三路共用 ---------------- */

test('Token 预算三路共用：超预算跳过，跳过数如实记录；第一条超预算才截断', () => {
  const big1 = fusedExp({ docId: 'big1', title: '甲', content: '甲'.repeat(40), quotes: [], sourceMessageIds: ['m2'] });
  const big2 = fusedExp({ docId: 'big2', title: '乙', content: '乙'.repeat(40), quotes: [], sourceMessageIds: ['m2'] });
  const neighbors = [{
    docId: 'big1', messageId: 'm3', messageIds: ['m3'],
    speaker: '朵朵', role: 'user', timestamp: T0 + 2000, roundOffset: -1, content: '丙'.repeat(20),
  }];
  const { systemPrompt, memorySections } = buildSys({
    relatedMemories: [big1, big2], neighbors, tokenBudget: 100,
    stageSummaries: [],
  });
  // big1 约 48 token + 邻居约 24 token = 72，big2 再加 48 超预算 → 跳过
  assert.ok(systemPrompt.includes('甲'.repeat(10)), '第一条应注入');
  assert.ok(!systemPrompt.includes('乙'.repeat(10)), '超预算的第二条应跳过');
  assert.ok(memorySections.skippedByBudget.length >= 1, '预算跳过数如实记录');
  assert.ok(memorySections.skippedByBudget.some((x) => x.docId === 'big2'));
  // 只有排名第一超预算才截断
  const single = buildSys({
    relatedMemories: [fusedExp({ content: '甲'.repeat(200), quotes: [], sourceMessageIds: ['m2'] })],
    tokenBudget: 60, stageSummaries: [],
  });
  assert.equal(single.memorySections.evidence.items[0].truncated, true);
  assert.ok(single.memorySections.evidence.items[0].injectedText.length <= 60, '截断后的注入文本贴合预算');
  // budget 为 0/falsy 时不截断
  const noBudget = buildSys({ relatedMemories: [big1, big2], tokenBudget: 0, stageSummaries: [] });
  assert.equal(noBudget.memorySections.skippedByBudget.length, 0);
});

test('applySharedMemoryBudget 与 applyTokenBudget 同规则：跳过与首条截断', () => {
  const units = [
    { kind: 'evidence', text: '甲'.repeat(100) },
    { kind: 'evidence', text: '乙'.repeat(100) },
    { kind: 'assoc', text: '丙'.repeat(100) },
  ];
  const { kept, skipped } = applySharedMemoryBudget(units, 150);
  assert.equal(kept.length, 1);
  assert.equal(skipped.length, 2);
  assert.equal(kept[0].truncated, undefined, '首条未超预算不截断');
  const tiny = applySharedMemoryBudget(units, 10);
  assert.equal(tiny.kept.length, 1);
  assert.equal(tiny.kept[0].truncated, true, '首条超预算才截断');
  assert.equal(applySharedMemoryBudget(units, 0).kept.length, 3, 'budget 为 0 不截断');
});

/* ---------------- 6. 预览与发送一致 ---------------- */

test('预览内容等于请求内容：同一构建结果的预览（memorySections）与发送一致', () => {
  const a = buildSys({ assoc: assocOk, assocExperience: expRecord() });
  const b = buildSys({ assoc: assocOk, assocExperience: expRecord() });
  assert.equal(a.systemPrompt, b.systemPrompt, '同输入同输出');
  assert.deepEqual(a.memorySections, b.memorySections);
  // 预览展示的每条注入原文都在系统提示词里（逐字一致）
  for (const item of a.memorySections.evidence.items) {
    assert.ok(a.systemPrompt.includes(item.injectedText), `证据 ${item.docId} 的注入文本应在提示词里`);
  }
  assert.ok(a.systemPrompt.includes('以下为历史参考资料'), '证据区文案在提示词里');
  assert.ok(a.systemPrompt.includes('主模型可以不提起无助于本轮的旧事'), '不强制提及的文案在提示词里');
});

/* ---------------- 7. 签名含 model 与联想配置 ---------------- */

test('签名含主 API 的 model 与联想配置：只改模型也要失效缓存', () => {
  const base = { c: 'char_1', model: 'gpt-4o', assoc: true, vec: { th: 0.4 } };
  assert.equal(buildRequestSignature(base), buildRequestSignature({ ...base }));
  assert.notEqual(buildRequestSignature(base), buildRequestSignature({ ...base, model: 'gpt-5' }), '只改模型必须改变签名');
  assert.notEqual(buildRequestSignature(base), buildRequestSignature({ ...base, assoc: false }), '联想开关变化必须改变签名');
  assert.notEqual(buildRequestSignature(base), buildRequestSignature({ ...base, vec: { th: 0.5 } }), '向量设置变化必须改变签名');
});

test('召回路径文案：关键词/向量/融合排名齐全，未命中一路不写', () => {
  assert.equal(retrievalPathText({ keywordRank: 2, vectorRank: 1 }, 1), '关键词第 2 · 向量第 1 · 融合第 1');
  assert.equal(retrievalPathText({ keywordRank: null, vectorRank: 3 }, 2), '向量第 3 · 融合第 2');
  assert.equal(retrievalPathText({}, null), '直接召回');
});

/* ---------------- 8. Worker 回退 ---------------- */

test('Worker 回退：建不出 Worker 时主线程分片完成，结果与直接计算一致', async () => {
  const docs = [
    { docId: 'd1', docKind: 'journal', text: '我们去海边约好下周再去' },
    { docId: 'd2', docKind: 'journal', text: '猫在沙发上睡觉' },
  ];
  const { result, mode } = await executeRetrievalTask('build-keyword-postings', { docs }, {
    createWorker: () => { throw new Error('Blob URL 被禁'); },
  });
  assert.equal(mode, 'main', '建不出 Worker 应注明主线程模式');
  assert.deepEqual(result, buildKeywordPostings(docs));
  const sea = result.postings.find((r) => r.term === '海边');
  assert.ok(sea && sea.postings[0].docId === 'd1' && sea.postings[0].tf === 1);
  const cos = await executeRetrievalTask('cosine-scores', {
    queryVector: [1, 0], entries: [{ id: 'a', vector: [1, 0] }, { id: 'b', vector: [0, 1] }],
  }, { createWorker: () => null });
  assert.equal(cos.mode, 'main');
  assert.deepEqual(cos.result.map((r) => r.id), ['a', 'b']);
  assert.equal(cos.result[0].score, 1);
});

test('Worker 源码字符串本身可跑：与主线程同一份算法结果一致', () => {
  const posts = [];
  const self = { postMessage: (x) => posts.push(x) };
  new Function('self', RETRIEVAL_WORKER_SOURCE)(self);
  const docs = [{ docId: 'd1', docKind: 'journal', text: '我们去海边约好下周再去' }];
  self.onmessage({ data: { id: '1', kind: 'build-keyword-postings', payload: { docs } } });
  assert.equal(posts[0].ok, true);
  assert.deepEqual(posts[0].result, buildKeywordPostings(docs));
  self.onmessage({ data: { id: '2', kind: 'cosine-scores', payload: { queryVector: [1, 0], entries: [{ id: 'a', vector: [1, 0] }] } } });
  assert.deepEqual(posts[1].result, [{ id: 'a', score: 1 }]);
  self.onmessage({ data: { id: '3', kind: 'nope', payload: {} } });
  assert.equal(posts[2].ok, false, '未知任务应回错，不炸 Worker');
});

test('主线程分词与 keywordSearch.tokenize 严格一致', () => {
  // Worker 副本已同步：连续汉字只保留完整词串 + 相邻二元字串，不产单字
  // term；英文/数字小写、停用词表与 keywordSearch.tokenize 完全一致。
  // 三处分词（keywordSearch.tokenize、tokenizeText、Worker 源码内 tokenize）
  // 须严格相等——Worker 源码与主线程的等价性由“Worker 源码字符串本身可跑”
  // 一案覆盖（同一份 docs 下结果与 buildKeywordPostings 严格相等）。
  for (const text of ['我们去海边约好下周再去', 'Hello world 猫', '的了是在和']) {
    assert.deepEqual(tokenizeText(text), tokenize(text), `分词不一致：${text}`);
  }
  // 单字不再当 term：两边都不产单字
  assert.deepEqual(tokenize('猫'), []);
  assert.deepEqual(tokenizeText('猫'), []);
  assert.equal(scoreCosineEntries([1, 0], [{ id: 'a', vector: [1, 0] }])[0].score, cosineSimilarity([1, 0], [1, 0]));
});

/* ---------------- 9. 任务暂停/恢复进度持久化 ---------------- */

test('任务暂停/恢复：进度写 settings，刷新后可继续且不重复处理', async () => {
  const backend = new MemoryBackend();
  await backend.init();
  const seen = [];
  const job = createMemoryJob('backfill-clues', 'char_1');
  const signal = { cancelled: false };
  const processItem = async (item, i) => {
    seen.push(item);
    if (i === 2) signal.cancelled = true; // 处理完第 3 件后暂停
  };
  const first = await runMemoryJob({
    backend, job, items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], processItem, signal, sliceSize: 1,
  });
  assert.equal(first.cancelled, true);
  assert.equal(first.status, 'paused');
  assert.equal(first.done, 3, '暂停时已处理 3 件');
  // 进度已持久化到 settings 'memoryJobs'
  const saved = await loadMemoryJobs(backend);
  assert.equal(saved[job.id].done, 3);
  assert.equal(saved[job.id].status, 'paused');
  // “刷新后”：从 settings 重新读任务，继续跑，不重复处理
  const reloaded = await loadMemoryJobs(backend);
  const resumedJob = reloaded[job.id];
  const signal2 = { cancelled: false };
  const second = await runMemoryJob({
    backend, job: resumedJob, items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], processItem, signal: signal2, sliceSize: 4,
  });
  assert.equal(second.cancelled, false);
  assert.equal(second.status, 'done');
  assert.equal(second.done, 10);
  assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], '每件只处理一次，不重复写');
});

test('任务单件失败不阻断整批；页面关闭时 running 的任务回来显示已暂停', async () => {
  const backend = new MemoryBackend();
  await backend.init();
  const job = createMemoryJob('rebuild-keyword', 'char_1');
  const done = [];
  const res = await runMemoryJob({
    backend, job, items: ['a', 'b', 'c'], sliceSize: 2,
    processItem: async (item) => {
      if (item === 'b') throw new Error('这一件失败');
      done.push(item);
    },
  });
  assert.equal(res.status, 'done');
  assert.equal(res.failed, 1);
  assert.deepEqual(done, ['a', 'c']);
  const jobs = { [job.id]: { ...job, status: 'running' }, other: { id: 'other', status: 'done' } };
  const { jobs: fixed, changed } = markInterruptedJobsPaused(jobs);
  assert.equal(changed, true);
  assert.equal(fixed[job.id].status, 'paused');
  assert.match(fixed[job.id].note, /页面关闭时中断/);
  assert.equal(fixed.other.status, 'done');
  assert.match(memoryJobStatusText({ ...job, status: 'paused', done: 3, total: 10, mode: 'main' }), /已暂停.*主线程模式/);
});

/* ---------------- 10. 整角色删除清残留 ---------------- */

test('整角色删除清残留：经历、关键词索引、向量段一起清，别人的不动', async () => {
  const backend = new MemoryBackend();
  await backend.init();
  await backend.put('experiences', { id: 'e1', charId: 'char_A', title: 'A 的经历' });
  await backend.put('experiences', { id: 'e2', charId: 'char_B', title: 'B 的经历' });
  await backend.put('keywordIndex', { id: 'char_A:海边', charId: 'char_A', term: '海边', postings: [{ docId: 'e1' }] });
  await backend.put('keywordIndex', { id: 'char_B:猫', charId: 'char_B', term: '猫', postings: [{ docId: 'e2' }] });
  await backend.put('vectorChunks', { id: 'e1:c0', journalId: 'e1', charId: 'char_A', spaceKey: 's', chunkIndex: 0 });
  await backend.put('vectorChunks', { id: 'e2:c0', journalId: 'e2', charId: 'char_B', spaceKey: 's', chunkIndex: 0 });
  const counts = await cleanupCharacterRetrievalData(backend, 'char_A');
  assert.deepEqual(counts, { experiences: 1, keywordIndex: 1, vectorChunks: 1 });
  assert.equal((await backend.getAll('experiences')).length, 1);
  assert.equal((await backend.getAll('keywordIndex')).length, 1);
  assert.equal((await backend.getAll('vectorChunks')).length, 1);
  assert.equal((await backend.get('experiences', 'e2')).title, 'B 的经历');
});

/* ---------------- 11. 旧经历补线索 ---------------- */

test('旧经历补线索：无线索或线索过期（version 不符）才补，有效线索不补', () => {
  assert.equal(experienceNeedsClues(expRecord({ clues: [] })), true, '无线索要补');
  assert.equal(experienceNeedsClues(expRecord({
    clues: [{ text: '以后会问起海边', kind: 'future', excerpt: '下周去海边', sourceMessageIds: ['m2'], evidenceVersion: 1 }],
  })), false, '线索有效（evidenceVersion === version）不补');
  assert.equal(experienceNeedsClues(expRecord({
    version: 2,
    clues: [{ text: '以后会问起海边', kind: 'future', excerpt: '下周去海边', sourceMessageIds: ['m2'], evidenceVersion: 1 }],
  })), true, '经历被编辑导致 version 变化后线索过期，要补');
});

test('旧经历补线索任务：单件失败跳过不阻断，失败件计 failed', async () => {
  const backend = new MemoryBackend();
  await backend.init();
  const job = createMemoryJob('backfill-clues', 'char_1');
  const todo = [
    expRecord({ id: 'exp-a', title: 'A' }),
    expRecord({ id: 'exp-b', title: 'B' }),
    expRecord({ id: 'exp-c', title: 'C' }),
  ].filter(experienceNeedsClues);
  assert.equal(todo.length, 3);
  const processed = [];
  const res = await runMemoryJob({
    backend, job, items: todo, sliceSize: 2,
    // 模拟逐件调副 API 生成线索：B 失败抛错，其余成功
    processItem: async (exp) => {
      if (exp.id === 'exp-b') throw new Error('副 API 失败');
      processed.push(exp.id);
      return 'ok';
    },
  });
  assert.equal(res.status, 'done');
  assert.equal(res.failed, 1);
  assert.deepEqual(processed, ['exp-a', 'exp-c']);
});

/* ---------------- 12. 任务记录持久化键名 ---------------- */

test('任务进度键名：settings 键为 memoryJobs，结构可读', async () => {
  const backend = new MemoryBackend();
  await backend.init();
  const job = createMemoryJob('extract-all', 'char_1', 5);
  await saveMemoryJobs(backend, { [job.id]: job });
  const row = await backend.get('settings', MEMORY_JOBS_KEY);
  assert.equal(row.key, 'memoryJobs');
  assert.equal(row.value[job.id].kind, 'extract-all');
  assert.equal(row.value[job.id].status, 'pending');
});
