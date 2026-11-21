import test from 'node:test';
import assert from 'node:assert/strict';
import { AudioKeepAlive, AUDIO_KEEPALIVE_HONESTY, SILENT_WAV_DATA_URL } from '../js/audioKeepAlive.js';

function stubAudio({ rejectPlay = false } = {}) {
  const calls = [];
  return {
    calls,
    audio: {
      src: '', loop: false, played: false, paused: false,
      async play() { calls.push('play'); if (rejectPlay) { const e = new Error('NotAllowedError: play() failed'); e.name = 'NotAllowedError'; throw e; } this.played = true; },
      pause() { calls.push('pause'); this.paused = true; },
    },
  };
}
function fakeTimers() {
  const fns = new Map(); let n = 0;
  return {
    fns,
    setInterval(fn) { const id = ++n; fns.set(id, fn); return id; },
    clearInterval(id) { fns.delete(id); },
  };
}
function stubChannel() {
  const listeners = [];
  return {
    posted: [],
    postMessage(msg) { this.posted.push(msg); },
    set onmessage(fn) { listeners.push(fn); },
    get onmessage() { return listeners[0]; },
  };
}

test('无用户手势拒绝启动，不假装成功', async () => {
  const { audio } = stubAudio();
  const k = new AudioKeepAlive({ createAudio: () => audio, timers: fakeTimers(), now: () => 1000 });
  const r = await k.start({ userGesture: false });
  assert.equal(r.ok, false);
  assert.equal(k.getState().state, 'denied');
  assert.match(k.getState().error, /用户手势/);
  assert.equal(audio.played, false);
});

test('autoplay 拒绝：状态 denied，原因明确', async () => {
  const { audio } = stubAudio({ rejectPlay: true });
  const k = new AudioKeepAlive({ createAudio: () => audio, timers: fakeTimers(), now: () => 1000 });
  const r = await k.start({ userGesture: true });
  assert.equal(r.ok, false);
  assert.equal(k.getState().state, 'denied');
  assert.match(k.getState().error, /拒绝自动播放/);
});

test('启动成功：playing，心跳计时器记录最后心跳时间', async () => {
  const { audio } = stubAudio();
  const timers = fakeTimers();
  let now = 1000;
  const k = new AudioKeepAlive({ createAudio: () => audio, timers, now: () => now, heartbeatSec: 30 });
  const r = await k.start({ userGesture: true });
  assert.equal(r.ok, true);
  assert.equal(k.getState().state, 'playing');
  assert.equal(k.getState().lastHeartbeatAt, 1000);
  now = 31000;
  k.tickHeartbeat();
  assert.equal(k.getState().heartbeatCount, 1);
  assert.equal(k.getState().lastHeartbeatAt, 31000);
  assert.equal(timers.fns.size, 1);
  k.stop();
  assert.equal(k.getState().state, 'idle');
  assert.equal(timers.fns.size, 0);
});

test('中断后状态如实变为 interrupted，恢复前台不自动重建', async () => {
  const { audio } = stubAudio();
  const k = new AudioKeepAlive({ createAudio: () => audio, timers: fakeTimers(), now: () => 1000 });
  await k.start({ userGesture: true });
  const s = k.handleInterruption('系统来电中断');
  assert.equal(s.state, 'interrupted');
  assert.match(s.error, /中断/);
  const afterVisible = k.handleVisibility(false);
  assert.equal(afterVisible.state, 'interrupted'); // 不自动恢复
  assert.equal(audio.played, true); // 只播过一次，没有偷偷重建
});

test('与语音播放互斥：让位后暂停，不自动恢复', async () => {
  const { audio } = stubAudio();
  const k = new AudioKeepAlive({ createAudio: () => audio, timers: fakeTimers(), now: () => 1000 });
  await k.start({ userGesture: true });
  k.yieldToVoice();
  assert.equal(k.getState().state, 'paused');
  assert.equal(k.wasStoppedByVoice(), true);
});

test('多标签页协调：已有主标签页认领时后来者让位', async () => {
  const { audio } = stubAudio();
  const ch = stubChannel();
  const k = new AudioKeepAlive({
    createAudio: () => audio, timers: fakeTimers(), now: () => 1000, tabId: 'tab-B',
    channelFactory: () => ch,
  });
  // 模拟另一标签页已认领：收到它的 claim 后再启动应让位
  const r1 = await k.start({ userGesture: true });
  assert.equal(r1.ok, true);
  ch.onmessage({ data: { type: 'keepalive-claim', tabId: 'tab-A' } });
  assert.equal(k.getState().state, 'idle');
  assert.equal(k.getState().isLeader, false);
});

test('诚实常量：播放成功 ≠ 保活成功；iOS 锁屏/后台未验证', () => {
  assert.match(AUDIO_KEEPALIVE_HONESTY, /播放成功 ≠ 保活成功/);
  assert.match(AUDIO_KEEPALIVE_HONESTY, /iOS 锁屏\/后台.*未验证/);
  assert.ok(SILENT_WAV_DATA_URL.startsWith('data:audio/wav;base64,'));
});
