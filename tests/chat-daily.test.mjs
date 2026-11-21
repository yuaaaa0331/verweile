import test from 'node:test';
import assert from 'node:assert/strict';
import {
  draftKey, saveDraft, loadDraft, clearDraft, createDraftSaver,
  readingPositionKey, saveReadingPosition, loadReadingPosition,
  decideNewMessageDisplay, distanceFromBottom,
  isFailed, canRetry, markFailed, retryMessage,
  recoverInterruptedMessages, shouldResumeGeneration,
} from '../js/chatDaily.js';

function memoryStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
  };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('草稿：按角色保存、切页恢复、发送后清除、空文本不留占位', () => {
  const storage = memoryStorage();
  assert.equal(draftKey('char_1'), 'uwu-chat.draft.char_1');
  assert.equal(loadDraft(storage, 'char_1'), '');
  saveDraft(storage, 'char_1', '还没发出去的话');
  assert.equal(loadDraft(storage, 'char_1'), '还没发出去的话');
  // 另一个角色互不干扰
  assert.equal(loadDraft(storage, 'char_2'), '');
  saveDraft(storage, 'char_2', '另一个角色的草稿');
  assert.equal(loadDraft(storage, 'char_1'), '还没发出去的话');
  // 空文本清除
  saveDraft(storage, 'char_1', '   ');
  assert.equal(loadDraft(storage, 'char_1'), '');
  // 发送后清除
  saveDraft(storage, 'char_1', '要发的话');
  clearDraft(storage, 'char_1');
  assert.equal(loadDraft(storage, 'char_1'), '');
});

test('createDraftSaver：防抖保存、flush 立即落盘、cancel 丢弃', async () => {
  const storage = memoryStorage();
  const saver = createDraftSaver(storage, 'char_1', { debounceMs: 15 });
  saver.schedule('第');
  saver.schedule('第一');
  saver.schedule('第一句');
  assert.equal(loadDraft(storage, 'char_1'), ''); // 未到时间不写
  await sleep(40);
  assert.equal(loadDraft(storage, 'char_1'), '第一句'); // 只写最后一次
  // flush 立即落盘
  saver.schedule('第二句还没停稳');
  assert.equal(saver.pending, true);
  saver.flush();
  assert.equal(loadDraft(storage, 'char_1'), '第二句还没停稳');
  // cancel 丢弃未落盘输入
  saver.schedule('不要这句');
  saver.cancel();
  await sleep(40);
  assert.equal(loadDraft(storage, 'char_1'), '第二句还没停稳');
});

test('阅读位置：保存最后可见消息 id + 距底偏移，损坏数据返回 null', () => {
  const storage = memoryStorage();
  assert.equal(readingPositionKey('char_1'), 'uwu-chat.readpos.char_1');
  assert.equal(loadReadingPosition(storage, 'char_1'), null);
  const saved = saveReadingPosition(storage, 'char_1', {
    lastVisibleMessageId: 'm42',
    distanceFromBottom: 320,
  });
  assert.equal(saved.lastVisibleMessageId, 'm42');
  assert.equal(saved.distanceFromBottom, 320);
  assert.deepEqual(
    { ...loadReadingPosition(storage, 'char_1'), savedAt: 0 },
    { lastVisibleMessageId: 'm42', distanceFromBottom: 320, savedAt: 0 },
  );
  storage.setItem(readingPositionKey('char_1'), '{坏掉的 json');
  assert.equal(loadReadingPosition(storage, 'char_1'), null);
});

test('decideNewMessageDisplay：贴底跟随拉底，上翻不强制拉底并显示 pill', () => {
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 0 }), {
    shouldStickToBottom: true, showNewMessagesPill: false,
  });
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 48 }), {
    shouldStickToBottom: true, showNewMessagesPill: false,
  });
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 49 }), {
    shouldStickToBottom: false, showNewMessagesPill: true,
  });
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 500 }), {
    shouldStickToBottom: false, showNewMessagesPill: true,
  });
  // 自定义阈值
  assert.deepEqual(decideNewMessageDisplay({ distanceFromBottom: 100 }, 100), {
    shouldStickToBottom: true, showNewMessagesPill: false,
  });
});

test('distanceFromBottom：距底偏移换算', () => {
  assert.equal(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 500 }), 0);
  assert.equal(distanceFromBottom({ scrollHeight: 2000, scrollTop: 1200, clientHeight: 500 }), 300);
  assert.equal(distanceFromBottom({}), 0);
});

test('发送失败重试：标 failed、重试复用同一 messageId，不产生重复记录', () => {
  const msg = { id: 'm1', role: 'user', content: '你好', timestamp: 1000 };
  assert.equal(isFailed(msg), false);
  assert.equal(canRetry(msg), false);
  assert.equal(retryMessage(msg), null);
  const failed = markFailed(msg, 'network error');
  assert.equal(isFailed(failed), true);
  assert.equal(canRetry(failed), true);
  assert.equal(failed.id, 'm1');
  assert.equal(failed.sendError, 'network error');
  assert.equal(msg.sendState, undefined); // 原对象不动
  const retried = retryMessage(failed);
  assert.equal(retried.id, 'm1'); // 同一个 id，写回 IndexedDB 是 put 不是 add
  assert.equal(retried.sendState, 'sending');
  assert.equal('failedAt' in retried, false);
  assert.equal('sendError' in retried, false);
  assert.equal(retried.content, '你好');
  assert.equal(canRetry(retried), false);
});

test('recoverInterruptedMessages：刷新后 generating 标为 interrupted，不自动续生成', () => {
  const messages = [
    { id: 'm1', sendState: 'sent' },
    { id: 'm2', sendState: 'generating', content: '半截回复…' },
    { id: 'm3', generating: true, content: '旧写法标记的生成中' },
    { id: 'm4', sendState: 'failed' },
  ];
  const { messages: out, wasGenerating } = recoverInterruptedMessages(messages);
  assert.equal(wasGenerating, true);
  assert.equal(out[0].sendState, 'sent');
  assert.equal(out[1].sendState, 'interrupted');
  assert.equal(out[1].content, '半截回复…'); // 内容保留
  assert.equal('generating' in out[2], false);
  assert.equal(out[2].sendState, 'interrupted');
  assert.equal(out[3].sendState, 'failed'); // failed 不动，不混为 interrupted
  assert.equal(messages[1].sendState, 'generating'); // 原数组不动
  // 没有生成中的消息
  assert.deepEqual(recoverInterruptedMessages([{ id: 'm1', sendState: 'sent' }]), {
    messages: [{ id: 'm1', sendState: 'sent' }],
    wasGenerating: false,
  });
  assert.deepEqual(recoverInterruptedMessages([]), { messages: [], wasGenerating: false });
  assert.equal(shouldResumeGeneration(), false);
});
