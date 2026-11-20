import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import {
  detectBackupFormat, decodeBackupBytes, decodeGzipBytes, decodeZlibBytes,
  inflateRaw, extractZipEntries, gunzipText, normalizeBackup, previewCounts,
} from '../js/importExport.js';

const sample = { version: 1, characters: [{ id: 'char_1', realName: '阿澈', history: [{ id: 'm1', role: 'user', content: '你好', timestamp: 1000 }] }], worldBooks: [] };
const sampleJson = JSON.stringify(sample);
const sampleBytes = new TextEncoder().encode(sampleJson);

// 小 CRC32（测 ZIP 用，与 Node zlib 的 crc32 口径一致）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };

/** 组一个最小 ZIP：entries 为 [{ name, data: Buffer, method: 0|8 }]。 */
function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name);
    const comp = e.method === 8 ? zlib.deflateRawSync(e.data) : e.data;
    const crc = crc32(e.data);
    locals.push(Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(e.method), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(e.data.length), u16(nameBuf.length), u16(0), nameBuf, comp,
    ]));
    centrals.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(e.method), u16(0), u16(0),
      u32(crc), u32(comp.length), u32(e.data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]));
    offset += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cd.length), u32(offset), u16(0),
  ]);
  return new Uint8Array(Buffer.concat([...locals, cd, eocd]));
}

test('detectBackupFormat：按文件头认 gzip / zlib / zip / utf16 / json / base64', () => {
  assert.equal(detectBackupFormat(new Uint8Array(zlib.gzipSync(sampleJson))), 'gzip');
  assert.equal(detectBackupFormat(new Uint8Array(zlib.deflateSync(sampleJson))), 'zlib');
  assert.equal(detectBackupFormat(buildZip([{ name: 'backup.json', data: Buffer.from(sampleJson), method: 0 }])), 'zip');
  assert.equal(detectBackupFormat(new Uint8Array(Buffer.from('\ufeff' + sampleJson, 'utf16le'))), 'utf16');
  assert.equal(detectBackupFormat(sampleBytes), 'json');
  assert.equal(detectBackupFormat(sampleJson), 'json');
  const b64 = Buffer.from(zlib.gzipSync(sampleJson)).toString('base64');
  assert.equal(detectBackupFormat(new TextEncoder().encode(b64)), 'base64');
  assert.equal(detectBackupFormat('not json'), 'unknown');
  assert.equal(detectBackupFormat(new Uint8Array([1, 2, 3, 4])), 'unknown');
});

test('纯 JS inflate：与 Node zlib 互通（固定 + 动态块）', () => {
  const text = '你好阿澈，'.repeat(200) + 'lorem ipsum dolor sit amet '.repeat(50) + JSON.stringify(sample).repeat(5);
  const raw = zlib.deflateRawSync(text);
  assert.equal(new TextDecoder().decode(inflateRaw(new Uint8Array(raw))), text);
  // deflateRawSync 默认动态块；再测一次小数据（固定块为主）
  const small = zlib.deflateRawSync('hi');
  assert.equal(new TextDecoder().decode(inflateRaw(new Uint8Array(small))), 'hi');
  // stored 块：deflateRawSync level 0
  const stored = zlib.deflateRawSync(text, { level: 0 });
  assert.equal(new TextDecoder().decode(inflateRaw(new Uint8Array(stored))), text);
});

test('纯 JS gzip 解析：带文件名头的 gzip 也能解', async () => {
  const gz = zlib.gzipSync(sampleJson, { filename: 'backup.ee' });
  assert.equal(new TextDecoder().decode(decodeGzipBytes(new Uint8Array(gz))), sampleJson);
  const r = await decodeBackupBytes(new Uint8Array(gz));
  assert.equal(r.format, 'gzip');
  assert.equal(r.text, sampleJson);
});

test('gunzipText：自定义解压抛错时降级，不直接失败', async () => {
  const gz = new Uint8Array(zlib.gzipSync(sampleJson));
  const text = await gunzipText(gz, async () => { throw new Error('nope'); });
  assert.equal(text, sampleJson);
});

test('decodeBackupBytes：zlib / zip（stored + deflate）/ utf16 / base64 / json', async () => {
  const zl = await decodeBackupBytes(new Uint8Array(zlib.deflateSync(sampleJson)));
  assert.equal(zl.format, 'zlib');
  assert.equal(zl.text, sampleJson);

  const zipStored = await decodeBackupBytes(buildZip([{ name: 'backup.json', data: Buffer.from(sampleJson), method: 0 }]));
  assert.equal(zipStored.format, 'zip:backup.json');
  assert.equal(zipStored.text, sampleJson);

  const zipDeflated = await decodeBackupBytes(buildZip([
    { name: 'readme.txt', data: Buffer.from('ignore me'), method: 0 },
    { name: 'data.ee', data: Buffer.from(sampleJson), method: 8 },
  ]));
  assert.equal(zipDeflated.format, 'zip:data.ee');
  assert.equal(zipDeflated.text, sampleJson);
  const entries = extractZipEntries(buildZip([
    { name: 'a.json', data: Buffer.from(sampleJson), method: 0 },
    { name: 'b.json', data: Buffer.from(sampleJson), method: 8 },
  ]));
  assert.equal(entries.length, 2);

  const utf16 = await decodeBackupBytes(new Uint8Array(Buffer.from('\ufeff' + sampleJson, 'utf16le')));
  assert.equal(utf16.format, 'utf16');
  assert.equal(utf16.text, sampleJson);

  const b64 = Buffer.from(zlib.gzipSync(sampleJson)).toString('base64');
  const b64r = await decodeBackupBytes(new TextEncoder().encode(b64));
  assert.equal(b64r.format, 'base64');
  assert.equal(b64r.text, sampleJson);

  const js = await decodeBackupBytes(sampleBytes);
  assert.equal(js.format, 'json');
  assert.equal(js.text, sampleJson);
});

test('decodeBackupBytes：认不出的格式报错要带文件头信息', async () => {
  await assert.rejects(decodeBackupBytes(new Uint8Array([1, 2, 3, 4, 5])), /无法识别的备份格式/);
});

test('normalizeBackup：Dexie 导出按表归组', () => {
  const dexie = {
    formatName: 'dexie', formatVersion: 1,
    data: {
      databaseName: 'uwu', databaseVersion: 1,
      tables: [
        { name: 'characters', schema: '', rowCount: 1, rows: [{ id: 'char_1', realName: '阿澈' }] },
        { name: 'messages', schema: '', rowCount: 2, rows: [
          { id: 'm1', charId: 'char_1', role: 'user', content: '你好', timestamp: 1000 },
          { id: 'm2', charId: 'char_9', role: 'assistant', content: '在', timestamp: 2000 },
        ] },
        { name: 'worldBooks', schema: '', rowCount: 0, rows: [] },
      ],
    },
  };
  const norm = normalizeBackup(dexie);
  assert.equal(norm.characters.length, 2);
  assert.equal(norm.characters[0].history.length, 1);
  assert.equal(norm.characters[1].id, 'char_9');
  assert.equal(norm.characters[1].history.length, 1);
  assert.equal(previewCounts(norm).messages, 2);
});

test('normalizeBackup：顶层消息表 / 角色 messages 字段 / 纯消息数组', () => {
  const top = normalizeBackup({
    characters: [{ id: 'char_1', realName: '阿澈', history: [] }],
    messages: [{ id: 'm1', charId: 'char_1', role: 'user', content: '嗨', timestamp: 1 }],
  });
  assert.equal(top.characters[0].history.length, 1);
  assert.equal(previewCounts(top).messages, 1);

  const byField = normalizeBackup({
    characters: [{ id: 'char_1', realName: '阿澈', messages: [{ id: 'm1', role: 'user', content: '嗨', timestamp: 1 }] }],
  });
  assert.equal(byField.characters[0].history.length, 1);

  const arr = normalizeBackup([{ id: 'm1', charId: 'c1', role: 'user', content: '嗨', timestamp: 1 }]);
  assert.equal(arr.characters.length, 1);
  assert.equal(arr.characters[0].history.length, 1);
  const arrNoChar = normalizeBackup([{ id: 'm1', role: 'user', content: '嗨', timestamp: 1 }]);
  assert.equal(arrNoChar.characters[0].id, 'char_imported');
  assert.ok(arrNoChar.gaps.some((g) => g.includes('只有消息表')));
});

test('decodeZlibBytes：拒绝坏的 zlib 头', () => {
  assert.throws(() => decodeZlibBytes(new Uint8Array([0x78, 0x00])), /zlib 头校验失败/);
});
