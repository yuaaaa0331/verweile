import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryBackend, templateIdFor, saveStatusTemplate } from '../js/storage.js';
import {
  normalizeBackup, previewCounts, importNormalized, exportAll,
  detectBackupFormat, stableMessageId,
} from '../js/importExport.js';
import { buildRequest } from '../js/historyBuilder.js';
import { buildSystemPrompt } from '../js/promptBuilder.js';
import { fixtureCharacter, fixtureWorldBooks, globalSettings } from './helpers.mjs';
import zlib from 'node:zlib';

function sampleBackup() {
  return {
    version: 1,
    characters: [{
      id: 'char_1', realName: '阿澈', myName: '朵朵', status: '在线',
      persona: '温柔。', myPersona: '我。', worldBookIds: ['wb1'],
      memoryMode: 'vector',
      memoryJournals: [
        { id: 'j1', title: '收藏的记忆', content: '雨天。', isFavorited: true },
        { id: 'j2', title: '普通记忆', content: '散步。', isFavorited: false },
      ],
      history: [
        { id: 'm1', role: 'user', content: '[朵朵的消息：你好]', timestamp: 1000, parts: [{ type: 'text', text: '[朵朵的消息：你好]' }] },
        { role: 'assistant', content: '[阿澈的消息：你好呀]', timestamp: 1000, parts: [{ type: 'text', text: '[阿澈的消息：你好呀]' }] }, // 无 ID、与上一条同时间戳
        { id: 'm3', role: 'user', content: '[朵朵的消息：你好]', timestamp: 2000 }, // 同正文不同时间
        { id: 'm4', role: 'assistant', content: '[阿澈的消息：撤回测试]', timestamp: 3000, isWithdrawn: true, originalContent: '撤回测试', someFutureField: { x: 1 } },
      ],
      vectorEntries: [{ id: 'v1', embedding: [0.1, 0.2] }],
      customFieldFromFuture: '保留我',
    }],
    worldBooks: [{ id: 'wb1', title: '背景', content: '住在海边。', position: 'before', depth: 1 }],
    myStickers: [{ id: 's1', name: '贴贴', group: '日常' }],
    apiSettings: { url: 'https://api.example.com', key: 'sk-SECRET-DO-NOT-LEAK', model: 'gpt-x', provider: 'openai' },
    apiPresets: [{ name: '备用', data: { apiUrl: 'https://x.example', apiKey: 'sk-OTHER-SECRET', model: 'm' } }],
    someUnknownTopLevel: { keep: true },
  };
}

test('导入导出往返：ID/顺序/正文/时间/人设/世界书/记忆/未知字段保持，密钥默认排除', async () => {
  const backend = new MemoryBackend();
  const normalized = normalizeBackup(sampleBackup());
  const preview = previewCounts(normalized);
  assert.equal(preview.messages, 4);
  assert.equal(preview.characters[0].messages, 4);
  assert.ok(preview.gaps.some((g) => g.includes('vector')), '向量缺口应列出');
  assert.ok(preview.unknownKeys.includes('someUnknownTopLevel'));

  const report = await importNormalized(backend, normalized, { mode: 'merge', mainCharacterId: 'char_1' });
  assert.equal(report.added.characters, 1);
  assert.equal(report.added.messages, 4, '同正文/同时间戳的消息不得被删');
  const exported = await exportAll(backend, { includeKeys: false });
  const exportedJson = JSON.stringify(exported);
  assert.ok(!exportedJson.includes('sk-SECRET-DO-NOT-LEAK'), '默认导出不得含密钥');
  assert.ok(!exportedJson.includes('sk-OTHER-SECRET'));
  assert.ok(exportedJson.includes('customFieldFromFuture'), '未知字段应保留');
  assert.ok(exportedJson.includes('someFutureField'));
  assert.ok(exportedJson.includes('vectorEntries'), '向量数据原样保存');

  // 重新导入：不重复增添
  const backend2 = new MemoryBackend();
  const report2 = await importNormalized(backend2, normalizeBackup(exported), { mode: 'merge' });
  assert.equal(report2.added.messages, 4);
  const report3 = await importNormalized(backend2, normalizeBackup(exported), { mode: 'merge' });
  assert.equal(report3.added.messages || 0, 0, '重复导入不应重复增添');
  assert.ok((report3.skipped.messages || 0) >= 4);

  // 顺序与内容
  const msgs = await backend2.getAllMessages('char_1');
  assert.deepEqual(msgs.map((m) => m.id), ['m1', stableMessageId({ content: '[阿澈的消息：你好呀]', timestamp: 1000 }, 'char_1'), 'm3', 'm4']);
  assert.equal(msgs[2].content, '[朵朵的消息：你好]');
  assert.equal(msgs[3].isWithdrawn, true);
});

test('格式识别按实际内容：gzip 魔数优先于扩展名', () => {
  const gz = zlib.gzipSync(JSON.stringify({ a: 1 }));
  assert.equal(detectBackupFormat(new Uint8Array(gz)), 'gzip');
  assert.equal(detectBackupFormat('{"a":1}'), 'json');
  assert.equal(detectBackupFormat('not json'), 'unknown');
});

test('状态模板去重：同一模板只存一份实体，多条消息共用引用；缺快照仍可读原文', async () => {
  const backend = new MemoryBackend();
  const panel = { regexPattern: '/\\[状态：(.*?)\\]/', replacePattern: '<span>$1</span>', promptSuffix: 'x' };
  const t1 = await saveStatusTemplate(backend, panel);
  const t2 = await saveStatusTemplate(backend, panel);
  assert.equal(t1.id, t2.id, '同一模板应去重为同一 id');
  assert.equal((await backend.getAll('statusTemplates')).length, 1);
  // 缺少旧快照的状态消息：只存原始状态文本 + templateId，仍可读取
  const msg = {
    id: 'st1', charId: 'char_1', role: 'assistant',
    content: '[阿澈更新状态为：正在看电影...]',
    statusText: '正在看电影...', templateId: t1.id, templateVersion: t1.version,
    isStatusUpdate: true,
  };
  await backend.put('messages', msg);
  const back = await backend.get('messages', 'st1');
  assert.equal(back.statusText, '正在看电影...');
  assert.equal(back.templateId, t1.id);
  assert.equal(back.statusSnapshot, undefined, '不再给每条消息重复存整份模板');
});

test('3 万条合成消息：增量写入 + 分页只取 50 条 + 请求只用尾部 80 条', async () => {
  const backend = new MemoryBackend();
  const charId = 'synth_1';
  const N = 30000;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) {
    await backend.put('messages', {
      id: `synth_${i}`, charId, role: i % 2 ? 'assistant' : 'user',
      content: `[消息：第${i}条]`, timestamp: 1700000000000 + i * 1000,
    });
  }
  const count = await backend.countMessages(charId);
  assert.equal(count, N);
  const page1 = await backend.getMessagesPage(charId, { limit: 50 });
  assert.equal(page1.messages.length, 50);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.messages[49].content, '[消息：第29999条]');
  assert.equal(page1.messages[0].content, '[消息：第29950条]');
  const page2 = await backend.getMessagesPage(charId, { before: page1.oldestTimestamp, limit: 50 });
  assert.equal(page2.messages[49].content, '[消息：第29949条]');

  // 请求组装只处理尾部 maxMemory 条
  const char = fixtureCharacter({ maxMemory: '80' });
  const sys = buildSystemPrompt(char, { worldBooks: fixtureWorldBooks(), stickers: [], globalSettings });
  const all = await backend.getAllMessages(charId);
  assert.equal(all.length, N);
  const { stats } = buildRequest(char, all, sys);
  assert.equal(stats.sliced, 80);
  assert.ok(Date.now() - t0 < 30000, '合成验证应在合理时间内完成');
});
