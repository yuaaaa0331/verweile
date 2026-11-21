import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS_MODES, DEFAULT_STATUS_MODE, STATUS_MODE_LABELS,
  DEFAULT_INNER_VOICE_PROMPT, DEFAULT_HTML_STATUS_PROMPT,
  normalizeStatusMode, getStatusMode, setStatusMode,
  getInnerVoicePrompt, setInnerVoicePrompt,
  getStatusInstruction, selectStatusInstruction,
} from '../js/statusMode.js';

const char = (over = {}) => ({
  id: 'char_1',
  statusMode: 'concise',
  innerVoicePrompt: '',
  statusPanel: {
    enabled: true,
    promptSuffix: '状态栏：显示心情与位置。',
    regexPattern: '',
    replacePattern: '',
    history: [{ raw: '[状态：开心]', html: '<div>开心</div>', timestamp: 1 }],
  },
  ...over,
});

test('normalizeStatusMode：非法/缺失回落到 concise', () => {
  assert.equal(normalizeStatusMode('inner'), 'inner');
  assert.equal(normalizeStatusMode('html'), 'html');
  assert.equal(normalizeStatusMode('concise'), 'concise');
  assert.equal(normalizeStatusMode('bogus'), 'concise');
  assert.equal(normalizeStatusMode(undefined), 'concise');
  assert.equal(normalizeStatusMode(null), 'concise');
  assert.equal(DEFAULT_STATUS_MODE, 'concise');
  assert.deepEqual(STATUS_MODES, ['concise', 'inner', 'html']);
  assert.deepEqual(STATUS_MODE_LABELS, { concise: '简洁', inner: '心声', html: 'HTML 状态栏' });
});

test('getStatusMode / setStatusMode：切换只改选择字段，不删模板与历史', () => {
  const c = char();
  assert.equal(getStatusMode(c), 'concise');
  assert.equal(getStatusMode({}), 'concise');
  const next = setStatusMode(c, 'inner');
  assert.equal(next.statusMode, 'inner');
  assert.equal(c.statusMode, 'concise'); // 原对象不动
  assert.equal(next.statusPanel, c.statusPanel); // 模板原样保留
  assert.deepEqual(next.statusPanel.history, c.statusPanel.history); // 历史不删
  const back = setStatusMode(next, 'html');
  assert.equal(back.statusMode, 'html');
  assert.equal(back.statusPanel.promptSuffix, '状态栏：显示心情与位置。');
  assert.equal(setStatusMode(c, 'bogus').statusMode, 'concise');
});

test('getStatusInstruction：concise 返回空（不注入）', () => {
  assert.deepEqual(getStatusInstruction(char()), { mode: 'concise', instruction: '' });
  assert.deepEqual(getStatusInstruction({}), { mode: 'concise', instruction: '' });
});

test('getStatusInstruction：inner 返回心声指令，提示词可编辑', () => {
  const out = getStatusInstruction(char({ statusMode: 'inner' }));
  assert.equal(out.mode, 'inner');
  assert.equal(out.instruction, DEFAULT_INNER_VOICE_PROMPT);
  assert.ok(out.instruction.includes('[inner_voice]'));
  assert.ok(out.instruction.includes('1–3 句'));
  const custom = getStatusInstruction(char({
    statusMode: 'inner',
    innerVoicePrompt: '用三句话写内心独白。',
  }));
  assert.equal(custom.instruction, '用三句话写内心独白。');
});

test('getInnerVoicePrompt / setInnerVoicePrompt', () => {
  assert.equal(getInnerVoicePrompt(char()), DEFAULT_INNER_VOICE_PROMPT);
  assert.equal(getInnerVoicePrompt(char({ innerVoicePrompt: '  ' })), DEFAULT_INNER_VOICE_PROMPT);
  const next = setInnerVoicePrompt(char(), '自定义提示词');
  assert.equal(next.innerVoicePrompt, '自定义提示词');
  assert.equal(next.statusMode, 'concise'); // 只改提示词字段
});

test('getStatusInstruction：html 复用现有状态模板指令，不造新协议', () => {
  const out = getStatusInstruction(char({ statusMode: 'html' }));
  assert.equal(out.mode, 'html');
  assert.equal(out.instruction, '状态栏：显示心情与位置。'); // 即 statusPanel.promptSuffix
  // 模板未启用 → 不注入
  const disabled = getStatusInstruction(char({
    statusMode: 'html',
    statusPanel: { enabled: false, promptSuffix: '状态栏：显示心情。' },
  }));
  assert.equal(disabled.instruction, '');
  // 未写 promptSuffix → 兜底句（仍是现有协议措辞）
  const fallback = getStatusInstruction(char({
    statusMode: 'html',
    statusPanel: { enabled: true, promptSuffix: '' },
  }));
  assert.equal(fallback.instruction, DEFAULT_HTML_STATUS_PROMPT);
  // selectStatusInstruction 是同一选择器
  assert.deepEqual(selectStatusInstruction(char({ statusMode: 'html' })), out);
});
