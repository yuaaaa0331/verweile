// import-backup-fix.test.mjs — 2026-11-21 导入/备份修复波的回归测试。
// 覆盖验证波发现的三个真实问题：
//  1. import 别名 withoutAuxKey 在 dist 里未定义，含副 API 设置的备份点“开始导入”抛错；
//  2. 经历不在备份范围内，备份→恢复丢全部经历；
//  3. 导入预览记忆恒为 0、角色列渲染成 [object Object]。
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MemoryBackend } from '../js/storage.js';
import { normalizeBackup, importNormalized, exportAll, previewCounts } from '../js/importExport.js';
import { createExperienceRecord } from '../js/experiences.js';
import { withoutKey } from '../js/auxApi.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function fixtureExperience(over = {}) {
  return createExperienceRecord({
    id: 'exp_1',
    charId: 'c1',
    title: '第一次去海边',
    summary: '约好周末去海边，结果下雨改期。',
    quotes: [{ text: '周末去海边吧', messageId: 'm1', speaker: '阿澈', timestamp: 1000 }],
    speakers: ['阿澈'],
    timestamp: 1000,
    plan_state: 'planned',
    outcome_state: { state: 'rescheduled', evidenceMessageIds: ['m2'], at: 2000 },
    sourceMessageIds: ['m1'],
    clues: [{
      text: '当时在聊周末计划', kind: 'context', excerpt: '周末去海边吧',
      sourceMessageIds: ['m1'], evidenceVersion: 1,
    }],
    lastMentionedRoundSeq: 7,
    ...over,
  });
}

async function seedDb() {
  const db = new MemoryBackend();
  await db.init();
  await db.put('characters', {
    id: 'c1', realName: '阿澈', remarkName: '阿澈', myName: '朵朵',
    memoryJournals: undefined, history: undefined,
  });
  await db.put('messages', { id: 'm1', charId: 'c1', role: 'assistant', content: '周末去海边吧', timestamp: 1000 });
  await db.put('messages', { id: 'm2', charId: 'c1', role: 'user', content: '下雨了，改下周吧', timestamp: 2000 });
  await db.put('journals', { id: 'j1', charId: 'c1', title: '第一次见面', content: '雨天共伞。', isFavorited: true, timestamp: 900 });
  await db.put('journals', { id: 'j2', charId: 'c1', title: '没收藏的', content: '普通一天。', isFavorited: false, timestamp: 950 });
  await db.put('experiences', fixtureExperience());
  await db.put('experiences', fixtureExperience({
    id: 'exp_2', title: '一起养猫', plan_state: 'none', outcome_state: null,
    quotes: [{ text: '养只猫吧', messageId: 'm2', speaker: '朵朵', timestamp: 2000 }],
    clues: [], lastMentionedRoundSeq: null,
  }));
  await db.put('settings', { key: 'summaryApi', value: { provider: 'openai', url: 'https://api.example.com/v1', key: 'sk-summary-123', model: 'gpt-4o-mini' } });
  await db.put('settings', { key: 'embeddingApi', value: { provider: 'openai', url: 'https://api.example.com/v1', key: 'sk-embed-456', model: 'text-embedding-3-small' } });
  return db;
}

/* ---------- 问题 2：导出→导入往返保留经历 ---------- */
test('2. 导出含全部经历；导入后经历（含线索、plan/outcome、冷却序号）完整恢复', async () => {
  const db = await seedDb();
  const exported = await exportAll(db, { includeKeys: false });
  assert.equal(exported.experiences.length, 2, '导出里没有经历');
  const exp1 = exported.experiences.find((e) => e.id === 'exp_1');
  assert.equal(exp1.title, '第一次去海边');
  assert.equal(exp1.clues.length, 1);
  assert.equal(exp1.clues[0].kind, 'context');
  assert.equal(exp1.plan_state, 'planned');
  assert.equal(exp1.outcome_state.state, 'rescheduled');
  assert.deepEqual(exp1.outcome_state.evidenceMessageIds, ['m2']);
  assert.equal(exp1.lastMentionedRoundSeq, 7);
  assert.equal(exp1.quotes[0].messageId, 'm1');

  const fresh = new MemoryBackend();
  await fresh.init();
  const norm = normalizeBackup(JSON.parse(JSON.stringify(exported)));
  assert.equal(norm.experiences.length, 2);
  const report = await importNormalized(fresh, norm, { mode: 'merge', mainCharacterId: 'c1' });
  assert.equal(report.added.experiences, 2, `导入报告经历新增数不对：${JSON.stringify(report.added)}`);
  const restored = await fresh.getAll('experiences');
  assert.equal(restored.length, 2);
  const r1 = restored.find((e) => e.id === 'exp_1');
  assert.equal(r1.clues[0].text, '当时在聊周末计划');
  assert.equal(r1.plan_state, 'planned');
  assert.equal(r1.outcome_state.state, 'rescheduled');
  assert.equal(r1.lastMentionedRoundSeq, 7);
  assert.equal(r1.quotes[0].text, '周末去海边吧');
  // 向量/关键词索引是可重建缓存，不随备份导出。
  assert.equal('vectorChunks' in exported, false);
  assert.equal('keywordIndex' in exported, false);
});

test('2. 重复导入经历按 id 去重，不覆盖、不重复计入', async () => {
  const db = await seedDb();
  const exported = await exportAll(db, { includeKeys: false });
  const fresh = new MemoryBackend();
  await fresh.init();
  const norm = normalizeBackup(JSON.parse(JSON.stringify(exported)));
  await importNormalized(fresh, norm, { mode: 'merge' });
  const second = await importNormalized(fresh, normalizeBackup(JSON.parse(JSON.stringify(exported))), { mode: 'merge' });
  assert.equal(second.added.experiences || 0, 0, '重复导入又新增了经历');
  assert.equal(second.skipped.experiences, 2);
  assert.equal((await fresh.getAll('experiences')).length, 2);
  assert.ok(second.conflicts.some((c) => c.includes('第一次去海边')), '重复导入没有冲突报告');
});

test('2. replace 模式清空经历表后再导入', async () => {
  const db = await seedDb();
  const exported = await exportAll(db, { includeKeys: false });
  const target = new MemoryBackend();
  await target.init();
  await target.put('experiences', fixtureExperience({ id: 'exp_old', title: '旧经历' }));
  await importNormalized(target, normalizeBackup(JSON.parse(JSON.stringify(exported))), { mode: 'replace' });
  const all = await target.getAll('experiences');
  assert.equal(all.length, 2);
  assert.equal(all.some((e) => e.id === 'exp_old'), false, 'replace 没有清空旧经历');
});

/* ---------- 问题 1：副 API 设置 + 别名 ---------- */
test('1. 默认导出剥离副 API 的 Key；含 Key 私人备份才含 Key；导入的副 API 设置不含 Key', async () => {
  const db = await seedDb();
  const def = await exportAll(db, { includeKeys: false });
  const defJson = JSON.stringify(def);
  assert.equal(defJson.includes('sk-summary-123'), false, '默认导出带出了 summaryApi 的 Key');
  assert.equal(defJson.includes('sk-embed-456'), false, '默认导出带出了 embeddingApi 的 Key');
  assert.equal(def.summaryApi.model, 'gpt-4o-mini', '默认导出把副 API 非 Key 字段也丢了');
  assert.equal(def.embeddingApi.model, 'text-embedding-3-small');
  const priv = await exportAll(db, { includeKeys: true });
  assert.equal(JSON.stringify(priv).includes('sk-summary-123'), true, '含 Key 备份反而丢了 summaryApi 的 Key');
  assert.equal(JSON.stringify(priv).includes('sk-embed-456'), true);

  // 导入侧：normalize 保留副 API 设置；app.js 的“开始导入”路径只留非 Key 字段。
  const norm = normalizeBackup(JSON.parse(JSON.stringify(def)));
  assert.equal(norm.summaryApi.key, undefined);
  assert.equal(norm.embeddingApi.key, undefined);
  assert.equal(withoutKey(norm.summaryApi).model, 'gpt-4o-mini');
  assert.equal(withoutKey(norm.embeddingApi).model, 'text-embedding-3-small');
  // 含 Key 的私人备份 normalize 后仍带 Key，但 withoutKey（导入落库前剥离）一定去掉。
  const normPriv = normalizeBackup(JSON.parse(JSON.stringify(priv)));
  assert.equal(normPriv.summaryApi.key, 'sk-summary-123', '私人备份的 Key 在 normalize 阶段就不该丢（由导入侧决定是否恢复）');
  assert.equal(withoutKey(normPriv.summaryApi).key, undefined);
});

test('1. 构建产物 dist/bundle.mjs 里没有任何 import 别名的未定义引用', () => {
  execFileSync('node', ['scripts/build-preview.mjs'], { cwd: root, encoding: 'utf8' });
  const bundle = readFileSync(resolve(root, 'dist/bundle.mjs'), 'utf8');
  assert.equal(/\bwithoutAuxKey\b/.test(bundle), false, 'bundle 里仍有 withoutAuxKey（本次事故的别名）');
  assert.ok(/\bfunction withoutKey\b/.test(bundle), 'bundle 里没有 function withoutKey 定义');
  // 全仓库 import 别名扫描：源码里出现过的每个别名都不应出现在 bundle 里。
  const aliases = new Set();
  const srcFiles = ['js/app.js', 'js/auxApi.js', 'js/experiences.js', 'js/importExport.js', 'js/storage.js'];
  for (const f of srcFiles) {
    const src = readFileSync(resolve(root, f), 'utf8');
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from/g)) {
      for (const spec of m[1].split(',')) {
        const a = spec.match(/^\s*([\w$]+)\s+as\s+([\w$]+)\s*$/);
        if (a) aliases.add(a[2]);
      }
    }
  }
  for (const alias of aliases) {
    assert.equal(new RegExp(`\\b${alias}\\b`).test(bundle), false, `bundle 里出现未定义的 import 别名 ${alias}`);
  }
});

/* ---------- 问题 3：导入预览计数 ---------- */
test('3. previewCounts：记忆数 = 角色内嵌 + 顶层去重；经历数正确；角色带名', () => {
  const norm = normalizeBackup({
    characters: [{
      id: 'c1', realName: '阿澈', remarkName: '阿澈', worldBookIds: ['w1'],
      memoryJournals: [
        { id: 'j1', title: '第一次见面', content: '雨天共伞。' },
        { id: 'j2', title: '没收藏的', content: '普通一天。' },
      ],
      history: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 1000 }],
    }],
    // 顶层 journals 与角色内嵌是同一批记忆的两种写法：j1 重复出现只计一次。
    memoryJournals: [
      { id: 'j1', charId: 'c1', title: '第一次见面', content: '雨天共伞。' },
      { id: 'j3', charId: 'c1', title: '顶层才有的记忆', content: '另外一条。' },
    ],
    experiences: [fixtureExperience(), fixtureExperience({ id: 'exp_2', title: '一起养猫' })],
  });
  const counts = previewCounts(norm);
  assert.equal(counts.journals, 3, `记忆数应为 3（内嵌 2 + 顶层新增 1），实际 ${counts.journals}`);
  assert.equal(counts.experiences, 2);
  assert.equal(counts.messages, 1);
  assert.equal(counts.characters.length, 1);
  assert.equal(counts.characters[0].realName, '阿澈');
  assert.equal(counts.characters[0].remarkName, '阿澈');
  // 角色列不再是 [object Object]：名字可直接拼成字符串。
  const names = counts.characters.map((c) => c.remarkName || c.realName || '未命名').join('、');
  assert.equal(names, '阿澈');
  assert.equal(String(counts.characters).includes('[object Object]'), true, '测试前提：对象数组直接拼字符串确实会出 [object Object]，修复必须走名字字段');
});

test('3. 导出→预览：真实导出结构的记忆数不再恒为 0', async () => {
  const db = await seedDb();
  const exported = await exportAll(db, { includeKeys: false });
  const counts = previewCounts(normalizeBackup(JSON.parse(JSON.stringify(exported))));
  assert.equal(counts.journals, 2, `真实导出结构的预览记忆数应为 2，实际 ${counts.journals}`);
  assert.equal(counts.experiences, 2);
});
