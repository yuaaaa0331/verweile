import test from 'node:test';
import assert from 'node:assert/strict';
import {
  INNER_VOICE_OPEN, INNER_VOICE_CLOSE, INNER_VOICE_MAX_SENTENCES,
  hasInnerVoice, splitSentences, truncateInnerVoice,
  parseInnerVoice, stripAllInnerVoiceBlocks, collapseBlankLines,
} from '../js/innerVoice.js';

test('无心声：原文不动，innerVoice=null', () => {
  const out = parseInnerVoice('今天天气不错，我们去散步吧。');
  assert.equal(out.cleanContent, '今天天气不错，我们去散步吧。');
  assert.equal(out.innerVoice, null);
  assert.equal(out.truncated, false);
  assert.equal(hasInnerVoice('今天天气不错'), false);
});

test('正常心声块：剥离进 innerVoice，正文不留协议标记', () => {
  const out = parseInnerVoice(
    '好呀，一起去。\n[inner_voice]她居然主动约我，心跳有点快。[/inner_voice]',
  );
  assert.equal(out.cleanContent, '好呀，一起去。');
  assert.equal(out.innerVoice, '她居然主动约我，心跳有点快。');
  assert.equal(out.truncated, false);
  assert.equal(out.cleanContent.includes(INNER_VOICE_OPEN), false);
  assert.equal(out.cleanContent.includes(INNER_VOICE_CLOSE), false);
  assert.equal(hasInnerVoice('好呀[inner_voice]想[/inner_voice]'), true);
});

test('默认 1～3 句：超长截断并标记 truncated', () => {
  const out = parseInnerVoice(
    '嗯。\n[inner_voice]第一句。第二句！第三句？第四句。第五句。[/inner_voice]',
  );
  assert.equal(out.innerVoice, '第一句。第二句！第三句？');
  assert.equal(out.truncated, true);
  assert.equal(out.cleanContent, '嗯。');
  // 正好 3 句不截断
  const ok = parseInnerVoice('[inner_voice]一句。两句。三句。[/inner_voice]正文');
  assert.equal(ok.innerVoice, '一句。两句。三句。');
  assert.equal(ok.truncated, false);
});

test('闭标签缺失：安静降级，innerVoice=null，半截协议不留在正文里', () => {
  const out = parseInnerVoice('好呀。\n[inner_voice]她居然主动约我，心跳有点快。');
  assert.equal(out.innerVoice, null);
  assert.equal(out.cleanContent, '好呀。');
  assert.equal(out.cleanContent.includes('[inner_voice]'), false);
});

test('孤闭标签与空白块：删掉标记，innerVoice=null', () => {
  const stray = parseInnerVoice('正文在这里。[/inner_voice]还有半句。');
  assert.equal(stray.innerVoice, null);
  assert.equal(stray.cleanContent.includes('[/inner_voice]'), false);
  assert.equal(stray.cleanContent, '正文在这里。还有半句。');
  const empty = parseInnerVoice('正文。[inner_voice]   [/inner_voice]尾巴。');
  assert.equal(empty.innerVoice, null);
  assert.equal(empty.cleanContent, '正文。尾巴。');
});

test('多个块：只取第一个，其余同样从正文删掉', () => {
  const out = parseInnerVoice(
    'A[inner_voice]第一个。[/inner_voice]B[inner_voice]第二个。[/inner_voice]C',
  );
  assert.equal(out.innerVoice, '第一个。');
  assert.equal(out.cleanContent, 'ABC');
});

test('splitSentences / truncateInnerVoice：中英文标点切句、字符上限', () => {
  assert.deepEqual(splitSentences('一句。两句！Three? Four…'), ['一句。', '两句！', 'Three?', 'Four…']);
  assert.deepEqual(splitSentences('只有一句'), ['只有一句']);
  assert.deepEqual(splitSentences(''), []);
  const t = truncateInnerVoice('a'.repeat(300), { maxSentences: 3, maxChars: 10 });
  assert.equal(t.text.length, 10);
  assert.equal(t.truncated, true);
  assert.equal(INNER_VOICE_MAX_SENTENCES, 3);
});

test('stripAllInnerVoiceBlocks / collapseBlankLines', () => {
  assert.equal(stripAllInnerVoiceBlocks('a[inner_voice]x[/inner_voice]b'), 'ab');
  assert.equal(stripAllInnerVoiceBlocks('a[inner_voice]x'), 'a');
  assert.equal(stripAllInnerVoiceBlocks('a[/inner_voice]b'), 'ab');
  assert.equal(collapseBlankLines('a\n\n\n\nb'), 'a\n\nb');
  assert.equal(collapseBlankLines('  前后空白  '), '前后空白');
});

test('绝不触碰 reasoning/thinking：模块只处理文本字段', () => {
  // 模拟一条带 reasoning 字段的 API 返回：调用方只把 content 文本传进来，
  // 模块的返回值里不可能出现 reasoning 内容（它根本没见过这个字段）。
  const apiMessage = {
    content: '好呀。[inner_voice]心跳有点快。[/inner_voice]',
    reasoning: '这是模型内部推理，绝不能展示',
    thinking: '内部思考过程',
  };
  const out = parseInnerVoice(apiMessage.content);
  assert.equal(JSON.stringify(out).includes('推理'), false);
  assert.equal(JSON.stringify(out).includes('思考过程'), false);
  assert.equal(out.innerVoice, '心跳有点快。');
});
