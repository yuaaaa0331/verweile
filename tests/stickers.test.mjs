// stickers.test.mjs — 表情包取图优先级与分组/搜索过滤。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stickerImageSrc, stickerGroupOf, stickerGroupsOf, filterStickers, knownStickerNames, STICKER_PAGE_SIZE } from '../js/stickers.js';
import { collectStickerNames } from '../js/promptBuilder.js';
import { normalizeBackup } from '../js/importExport.js';
import { parseReplyText } from '../js/replyParser.js';
import { fixtureCharacter } from './helpers.mjs';

const uwuSticker = (over = {}) => ({
  id: 'stk_1', name: '贴贴', group: '日常',
  data: 'https://i.postimg.cc/example/tietie.jpg', lastUsedTime: 0, ...over,
});

test('取图优先级：dataUrl > attachmentId > 原版 data', () => {
  assert.deepEqual(stickerImageSrc(uwuSticker()), { kind: 'url', src: 'https://i.postimg.cc/example/tietie.jpg' });
  assert.deepEqual(
    stickerImageSrc(uwuSticker({ dataUrl: 'data:image/png;base64,AAA' })),
    { kind: 'url', src: 'data:image/png;base64,AAA' },
  );
  assert.deepEqual(
    stickerImageSrc(uwuSticker({ dataUrl: 'data:image/png;base64,AAA', attachmentId: 'att_1' })),
    { kind: 'url', src: 'data:image/png;base64,AAA' },
  );
  assert.deepEqual(
    stickerImageSrc(uwuSticker({ data: undefined, attachmentId: 'att_1' })),
    { kind: 'attachment', id: 'att_1' },
  );
  // 原版 data 也可以是 data: URL
  assert.deepEqual(
    stickerImageSrc(uwuSticker({ data: 'data:image/gif;base64,BBB' })),
    { kind: 'url', src: 'data:image/gif;base64,BBB' },
  );
  assert.equal(stickerImageSrc({ id: 'x', name: '空' }), null);
  assert.equal(stickerImageSrc(null), null);
});

test('导入原样保存原版 data 字段（不清洗丢弃）', () => {
  const normalized = normalizeBackup({
    characters: [{ id: 'c1', realName: 'A', history: [] }],
    myStickers: [uwuSticker(), uwuSticker({ id: 'stk_2', name: '哼', group: '撒娇' })],
  });
  assert.equal(normalized.stickers.length, 2);
  assert.equal(normalized.stickers[0].data, 'https://i.postimg.cc/example/tietie.jpg');
  assert.equal(normalized.stickers[1].group, '撒娇');
});

test('分组：缺 group / 空白归入未分类，按首次出现顺序去重', () => {
  assert.equal(stickerGroupOf({ name: 'x' }), '未分类');
  assert.equal(stickerGroupOf({ name: 'x', group: '  ' }), '未分类');
  assert.equal(stickerGroupOf({ name: 'x', group: ' 日常 ' }), '日常');
  assert.deepEqual(
    stickerGroupsOf([uwuSticker(), uwuSticker({ id: '2', group: '撒娇' }), { id: '3', name: '无组' }, uwuSticker({ id: '4' })]),
    ['日常', '撒娇', '未分类'],
  );
});

test('过滤：按分组 + 名称搜索（不区分大小写），全部不过滤分组', () => {
  const list = [
    uwuSticker(),
    uwuSticker({ id: '2', name: '贴贴贴', group: '撒娇' }),
    uwuSticker({ id: '3', name: 'TieTie', group: '日常' }),
    { id: '4', name: '哼', group: '' },
  ];
  assert.deepEqual(filterStickers(list, { group: '日常', query: '' }).map((s) => s.id), ['stk_1', '3']);
  assert.deepEqual(filterStickers(list, { group: '全部', query: '贴贴' }).map((s) => s.id), ['stk_1', '2']);
  assert.deepEqual(filterStickers(list, { group: '', query: 'tietie' }).map((s) => s.id), ['3']);
  assert.deepEqual(filterStickers(list, { group: '未分类', query: '' }).map((s) => s.id), ['4']);
  assert.deepEqual(filterStickers(list, { group: '撒娇', query: '贴' }).map((s) => s.id), ['2']);
  assert.deepEqual(filterStickers(list, { group: '日常', query: '不存在' }), []);
  assert.deepEqual(filterStickers(list, {}).map((s) => s.id), ['stk_1', '2', '3', '4']);
});

test('collectStickerNames 仍按 name 字段匹配（原版 data 格式不受影响）', () => {
  const char = { stickerGroups: '日常,撒娇' };
  assert.deepEqual(
    collectStickerNames(char, [uwuSticker(), uwuSticker({ id: '2', name: '哼', group: '撒娇' }), uwuSticker({ id: '3', name: '哭', group: '委屈' })]),
    ['贴贴', '哼'],
  );
});

test('分批渲染页大小为 60', () => {
  assert.equal(STICKER_PAGE_SIZE, 60);
});

test('自己发的表情包也解析为 sticker：原版用户格式是 [myName发送的表情包：X]，面板发的与 AI 的都认', () => {
  const char = fixtureCharacter(); // realName 阿澈，myName 朵朵
  const allowed = ['贴贴'];
  // 面板现在按原版格式发 [朵朵发送的表情包：贴贴]；导入的旧记录也是这个格式
  const mine = parseReplyText('[朵朵发送的表情包：贴贴]', char, { allowedStickers: allowed });
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, 'sticker');
  assert.equal(mine[0].name, '贴贴');
  // 不带“发送”的旧写法仍认（面板以前发的、AI 的）
  const mineOld = parseReplyText('[朵朵的表情包：贴贴]', char, { allowedStickers: allowed });
  assert.equal(mineOld[0].kind, 'sticker');
  const ai = parseReplyText('[阿澈的表情包：贴贴]', char, { allowedStickers: allowed });
  assert.equal(ai[0].kind, 'sticker');
  // 不在可用分组里的名字仍回退为 stickerUnknown（不显示破图）
  const unknown = parseReplyText('[朵朵发送的表情包：不存在的名字]', char, { allowedStickers: allowed });
  assert.equal(unknown[0].kind, 'stickerUnknown');
});

test('knownStickerNames：分组内优先，全库兜底——角色分组为空时库里名字都认', () => {
  const list = [
    uwuSticker(),
    uwuSticker({ id: '2', name: '哼', group: '撒娇' }),
    uwuSticker({ id: '3', name: '哭', group: '委屈' }),
    uwuSticker({ id: '4', name: '贴贴', group: '撒娇' }),
  ];
  // 分组内的在前，其余库内名字在后，均去重
  assert.deepEqual(knownStickerNames(list, '日常,撒娇'), ['贴贴', '哼', '哭']);
  // 角色分组为空：全库名字都认（不再把已导入的表情包判成未知）
  assert.deepEqual(knownStickerNames(list, ''), ['贴贴', '哼', '哭']);
  assert.deepEqual(knownStickerNames(list), ['贴贴', '哼', '哭']);
  // 空库
  assert.deepEqual(knownStickerNames([], '日常'), []);
});
