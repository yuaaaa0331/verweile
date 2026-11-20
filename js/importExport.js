// importExport.js — 导入导出（importExport）。
// 支持普通 JSON 与 gzip / zlib / ZIP / UTF-16 / base64 包装的 .ee，按文件实际内容识别格式，不只看扩展名。
// 旧版 Safari 没有 DecompressionStream 时，用纯 JS 的 DEFLATE 解码兜底。
// 原始结构：characters / worldBooks / memoryJournals / history 等。
// 原则：保留原 ID、timestamp、顺序、quote、parts、记忆来源与世界书关联；
// 不以相同正文/时间戳删消息；重复导入用稳定 ID + 冲突报告判断；
// 未识别字段（向量 entries、模板绑定、记忆来源等）原样保存，标注“待接入”；
// 凭据默认不导出，含密钥的私人备份需明确选择。
import { hashString } from './utils.js';

function toUint8(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  return new Uint8Array(input);
}

export function leadingBytesHex(input, count = 16) {
  const bytes = toUint8(input);
  return Array.from(bytes.slice(0, count)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** 导入失败时给 Dolores 看的诊断信息：文件名、大小、文件头，便于截图反馈。 */
export function describeBackupBytes(input, name = '') {
  const bytes = toUint8(input);
  let headText = '';
  try { headText = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 120)).replace(/[\u0000-\u001f]/g, ' '); } catch { headText = ''; }
  return { name, size: bytes.length, format: detectBackupFormat(bytes), headHex: leadingBytesHex(bytes), headText: headText.trim().slice(0, 120) };
}

function base64ToBytes(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (typeof atob === 'function') {
    const bin = atob(clean);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(clean, 'base64'));
  throw new Error('当前环境不支持 base64 解码');
}

function looksBase64Wrapped(text) {
  const clean = String(text).replace(/\s+/g, '');
  if (clean.length < 8 || clean.length % 4 !== 0) return false;
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(clean)) return false;
  try {
    const decoded = base64ToBytes(clean);
    return detectBackupFormat(decoded) !== 'unknown';
  } catch { return false; }
}

export function detectBackupFormat(input) {
  if (input instanceof Uint8Array || input instanceof ArrayBuffer) {
    const bytes = toUint8(input);
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'zip';
    if (bytes.length >= 2 && bytes[0] === 0x78 && (((bytes[0] << 8) + bytes[1]) % 31 === 0)) return 'zlib';
    if (bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))) return 'utf16';
    // 无 BOM 的 UTF-16：{ 或 [ 后面跟着 0x00
    if (bytes.length >= 4 && ((bytes[0] === 0x7b && bytes[1] === 0x00) || (bytes[0] === 0x00 && bytes[1] === 0x7b)
      || (bytes[0] === 0x5b && bytes[1] === 0x00) || (bytes[0] === 0x00 && bytes[1] === 0x5b))) return 'utf16';
    let text = '';
    try { text = new TextDecoder('utf-8').decode(bytes).trim(); } catch { text = ''; }
    if (text.startsWith('{') || text.startsWith('[')) return 'json';
    if (text && looksBase64Wrapped(text)) return 'base64';
    return 'unknown';
  }
  const text = String(input ?? '').trim();
  if (text.startsWith('{') || text.startsWith('[')) return 'json';
  if (text && looksBase64Wrapped(text)) return 'base64';
  return 'unknown';
}

/* ---------------- 纯 JS 解压（RFC 1951，无 DecompressionStream 时的兜底） ---------------- */
// 旧版 Safari / WebView 没有 DecompressionStream，之前 gunzipText 会直接抛错，
// .ee 备份就导不进。现在原生解压失败时自动降级到这套纯 JS 实现。

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

function makeHuffman(lengths) {
  const maxLen = lengths.reduce((m, l) => Math.max(m, l), 0);
  const counts = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l) counts[l]++;
  const symbols = [];
  for (let len = 1; len <= maxLen; len++) {
    for (let n = 0; n < lengths.length; n++) if (lengths[n] === len) symbols.push(n);
  }
  return {
    decode(readBit) {
      let code = 0, first = 0, index = 0;
      for (let len = 1; len <= maxLen; len++) {
        code |= readBit();
        const count = counts[len];
        if (code - first < count) return symbols[index + (code - first)];
        index += count;
        first = (first + count) << 1;
        code <<= 1;
      }
      throw new Error('无效的 Huffman 编码');
    },
  };
}

function makeBitReader(bytes, start) {
  let pos = start, bitBuf = 0, bitLen = 0;
  return {
    readBit() {
      if (bitLen === 0) {
        if (pos >= bytes.length) throw new Error('DEFLATE 数据意外结束');
        bitBuf = bytes[pos++]; bitLen = 8;
      }
      const b = bitBuf & 1; bitBuf >>= 1; bitLen--;
      return b;
    },
    readBits(n) { let v = 0; for (let i = 0; i < n; i++) v |= this.readBit() << i; return v; },
    alignByte() { bitBuf = 0; bitLen = 0; },
    getPos() { return pos; },
    setPos(p) { pos = p; },
  };
}

/** 原始 DEFLATE 流解码（RFC 1951），input 从 start 开始。 */
export function inflateRaw(input, start = 0) {
  const bytes = toUint8(input);
  const r = makeBitReader(bytes, start);
  const out = [];
  const decodeBlock = (litHuff, distHuff) => {
    for (;;) {
      const sym = litHuff.decode(() => r.readBit());
      if (sym < 256) { out.push(sym); continue; }
      if (sym === 256) return;
      const li = sym - 257;
      if (li < 0 || li >= 29) throw new Error('无效的长度码');
      const len = LENGTH_BASE[li] + r.readBits(LENGTH_EXTRA[li]);
      const dsym = distHuff.decode(() => r.readBit());
      if (dsym >= 30) throw new Error('无效的距离码');
      const dist = DIST_BASE[dsym] + r.readBits(DIST_EXTRA[dsym]);
      if (dist > out.length) throw new Error('距离超出已解压数据');
      let from = out.length - dist;
      for (let k = 0; k < len; k++) out.push(out[from++]);
    }
  };
  let finalBlock = false;
  while (!finalBlock) {
    finalBlock = r.readBit() === 1;
    const type = r.readBits(2);
    if (type === 0) {
      r.alignByte();
      const pos = r.getPos();
      if (pos + 4 > bytes.length) throw new Error('stored 块长度缺失');
      const len = bytes[pos] | (bytes[pos + 1] << 8);
      const nlen = bytes[pos + 2] | (bytes[pos + 3] << 8);
      if (len !== (~nlen & 0xffff)) throw new Error('stored 块长度校验失败');
      if (pos + 4 + len > bytes.length) throw new Error('stored 块数据缺失');
      for (let i = 0; i < len; i++) out.push(bytes[pos + 4 + i]);
      r.setPos(pos + 4 + len);
    } else if (type === 1) {
      const litLengths = new Array(288);
      for (let i = 0; i < 144; i++) litLengths[i] = 8;
      for (let i = 144; i < 256; i++) litLengths[i] = 9;
      for (let i = 256; i < 280; i++) litLengths[i] = 7;
      for (let i = 280; i < 288; i++) litLengths[i] = 8;
      decodeBlock(makeHuffman(litLengths), makeHuffman(new Array(32).fill(5)));
    } else if (type === 2) {
      const hlit = r.readBits(5) + 257;
      const hdist = r.readBits(5) + 1;
      const hclen = r.readBits(4) + 4;
      const clen = new Array(19).fill(0);
      for (let i = 0; i < hclen; i++) clen[CLEN_ORDER[i]] = r.readBits(3);
      const clHuff = makeHuffman(clen);
      const lengths = new Array(hlit + hdist).fill(0);
      let i = 0;
      while (i < hlit + hdist) {
        const sym = clHuff.decode(() => r.readBit());
        if (sym <= 15) { lengths[i++] = sym; continue; }
        if (sym === 16) {
          if (i === 0) throw new Error('重复码缺少前一个长度');
          const prev = lengths[i - 1];
          const rep = 3 + r.readBits(2);
          for (let k = 0; k < rep; k++) lengths[i++] = prev;
          continue;
        }
        if (sym === 17) { i += 3 + r.readBits(3); continue; }
        if (sym === 18) { i += 11 + r.readBits(7); continue; }
        throw new Error('无效的码长码');
      }
      if (i > hlit + hdist) throw new Error('码长超出范围');
      decodeBlock(makeHuffman(lengths.slice(0, hlit)), makeHuffman(lengths.slice(hlit)));
    } else {
      throw new Error('无效的 DEFLATE 块类型');
    }
  }
  return new Uint8Array(out);
}

/** 纯 JS 解析 gzip（跳过文件名/注释等可选字段），返回解压后的字节。 */
export function decodeGzipBytes(input) {
  const bytes = toUint8(input);
  if (bytes.length < 18 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('不是 gzip 数据');
  if (bytes[2] !== 8) throw new Error('不支持的 gzip 压缩方法');
  const flg = bytes[3];
  let p = 10;
  if (flg & 0x04) {
    if (p + 2 > bytes.length) throw new Error('gzip 扩展字段缺失');
    p += 2 + (bytes[p] | (bytes[p + 1] << 8));
  }
  if (flg & 0x08) { while (p < bytes.length && bytes[p] !== 0) p++; p++; }
  if (flg & 0x10) { while (p < bytes.length && bytes[p] !== 0) p++; p++; }
  if (flg & 0x02) p += 2;
  if (p >= bytes.length) throw new Error('gzip 数据缺失');
  return inflateRaw(bytes, p);
}

/** 纯 JS 解析 zlib 包装（0x78 开头，2 字节头 + DEFLATE + 4 字节校验）。 */
export function decodeZlibBytes(input) {
  const bytes = toUint8(input);
  if (bytes.length < 2) throw new Error('不是 zlib 数据');
  if ((bytes[0] & 0x0f) !== 8) throw new Error('不是 zlib 数据');
  if (((bytes[0] << 8) + bytes[1]) % 31 !== 0) throw new Error('zlib 头校验失败');
  return inflateRaw(bytes, 2);
}

function readU16(bytes, p) { return bytes[p] | (bytes[p + 1] << 8); }
function readU32(bytes, p) { return (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0; }

/** 最小 ZIP 读取：优先用中央目录（能处理数据描述符），否则顺序扫本地头。 */
export function extractZipEntries(input) {
  const bytes = toUint8(input);
  const entries = [];
  const readLocal = (localOff) => {
    if (readU32(bytes, localOff) !== 0x04034b50) return null;
    const method = readU16(bytes, localOff + 8);
    const compSize = readU32(bytes, localOff + 18);
    const nameLen = readU16(bytes, localOff + 26);
    const extraLen = readU16(bytes, localOff + 28);
    const name = new TextDecoder('utf-8').decode(bytes.slice(localOff + 30, localOff + 30 + nameLen));
    const dataStart = localOff + 30 + nameLen + extraLen;
    const data = bytes.slice(dataStart, dataStart + compSize);
    if (method === 0) return { name, data };
    if (method === 8) return { name, data: inflateRaw(data) };
    throw new Error(`ZIP 条目「${name}」使用了不支持的压缩方法 ${method}`);
  };
  // 找 EOCD（PK\x05\x06），从文件尾往前扫
  let eocd = -1;
  for (let p = bytes.length - 22; p >= 0 && p >= bytes.length - 22 - 65536; p--) {
    if (readU32(bytes, p) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd >= 0) {
    const count = readU16(bytes, eocd + 10);
    let p = readU32(bytes, eocd + 16);
    for (let i = 0; i < count; i++) {
      if (readU32(bytes, p) !== 0x02014b50) break;
      const nameLen = readU16(bytes, p + 28);
      const extraLen = readU16(bytes, p + 30);
      const commentLen = readU16(bytes, p + 32);
      const localOff = readU32(bytes, p + 42);
      const entry = readLocal(localOff);
      if (entry) entries.push(entry);
      p += 46 + nameLen + extraLen + commentLen;
    }
    if (entries.length) return entries;
  }
  // 回退：顺序扫描本地文件头
  let p = 0;
  while (p + 30 <= bytes.length && readU32(bytes, p) === 0x04034b50) {
    const entry = readLocal(p);
    if (!entry) break;
    entries.push(entry);
    const nameLen = readU16(bytes, p + 26);
    const extraLen = readU16(bytes, p + 28);
    const compSize = readU32(bytes, p + 18);
    p += 30 + nameLen + extraLen + compSize;
  }
  return entries;
}

function decodeUtf16(bytes, littleEndian) {
  if (typeof TextDecoder !== 'undefined') {
    try { return new TextDecoder(littleEndian ? 'utf-16le' : 'utf-16be').decode(bytes); } catch { /* 手动解码 */ }
  }
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode(littleEndian ? (bytes[i] | (bytes[i + 1] << 8)) : ((bytes[i] << 8) | bytes[i + 1]));
  }
  return s;
}

/**
 * 按文件实际内容解码备份：gzip / zlib / ZIP 包 / UTF-16 / JSON / base64 包装。
 * 返回 { text, format }，format 如 'gzip'、'zip:backup.json'、'base64'。
 * 之前只认 gzip 一种，旧 Safari 上连这一种也解不开（缺 DecompressionStream 又无兜底）。
 */
export async function decodeBackupBytes(input, depth = 0) {
  const bytes = toUint8(input);
  if (depth > 3) throw new Error('备份嵌套包装层数过多');
  const fmt = detectBackupFormat(bytes);
  const utf8 = (b) => new TextDecoder('utf-8').decode(b);
  if (fmt === 'gzip') return { text: await gunzipText(bytes), format: 'gzip' };
  if (fmt === 'zlib') return { text: utf8(decodeZlibBytes(bytes)), format: 'zlib' };
  if (fmt === 'zip') {
    const entries = extractZipEntries(bytes);
    if (!entries.length) throw new Error('ZIP 包里没有文件');
    const pick = entries.find((e) => /\.(json|ee)$/i.test(e.name))
      || entries.find((e) => /\.txt$/i.test(e.name)) || entries[0];
    const inner = await decodeBackupBytes(pick.data, depth + 1);
    return { text: inner.text, format: `zip:${pick.name}` };
  }
  if (fmt === 'utf16') {
    const be = bytes[0] === 0xfe && bytes[1] === 0xff;
    const hasBom = (bytes[0] === 0xff && bytes[1] === 0xfe) || be;
    return { text: decodeUtf16(bytes.slice(hasBom ? 2 : 0), !be), format: 'utf16' };
  }
  if (fmt === 'json') return { text: utf8(bytes), format: 'json' };
  if (fmt === 'base64') {
    const inner = await decodeBackupBytes(base64ToBytes(utf8(bytes).trim()), depth + 1);
    return { text: inner.text, format: 'base64' };
  }
  throw new Error(`无法识别的备份格式（文件头 ${leadingBytesHex(bytes)}，需要 JSON 或 .ee 备份）`);
}

export async function gunzipText(bytes, decompressImpl) {
  const buf = bytes instanceof ArrayBuffer ? bytes : bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (decompressImpl) {
    try { return await decompressImpl(buf); } catch { /* 降级到原生 / 纯 JS */ }
  }
  if (typeof DecompressionStream !== 'undefined') {
    try {
      const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
      return await new Response(stream).text();
    } catch { /* 降级到纯 JS */ }
  }
  return new TextDecoder('utf-8').decode(decodeGzipBytes(new Uint8Array(buf)));
}

export async function gzipBytes(text, compressImpl) {
  if (compressImpl) return compressImpl(text);
  if (typeof CompressionStream !== 'undefined') {
    const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  throw new Error('当前环境不支持 gzip 压缩，将导出未压缩 JSON。');
}

const KNOWN_CHAR_FIELDS = new Set(['id', 'realName', 'myName', 'remarkName', 'myRemarkName', 'avatar', 'myAvatar',
  'status', 'persona', 'myPersona', 'worldBookIds', 'memoryJournals', 'history', 'stickerGroups',
  'bilingualModeEnabled', 'replyCountMin', 'replyCountMax', 'replyCountEnabled', 'maxMemory',
  'exclusivePromptVersion', 'exclusiveApiEnabled', 'exclusiveApiPreset', 'statusPanel', 'gallery',
  'useRealGallery', 'shopInteractionEnabled', 'momentsEnabled', 'videoCallEnabled', 'autoAirDropEnabled',
  'isPinned', 'avatarMode', 'showTimestamp', 'timestampPosition', 'customBubbleCss', 'useCustomBubbleCss',
  'showStatusUpdateMsg', 'promptOverride', 'memoryMode', 'isContextDisabled']);
const KNOWN_TOP_FIELDS = new Set(['characters', 'groups', 'worldBooks', 'myStickers', 'memoryJournals',
  'apiSettings', 'apiPresets', 'cotSettings', 'cotPresets', 'globalSettings', 'settings',
  'version', 'appVersion', 'exportedAt', 'backupVersion', 'messages', 'history', 'data', 'formatName', 'formatVersion']);

/** Dexie 导出（{ formatName, data: { tables: [{ name, rows }] } }）转回标准备份结构。 */
function dexieTablesToBackup(tables) {
  const byName = new Map(tables.map((t) => [t.name, Array.isArray(t.rows) ? t.rows : []]));
  const out = { characters: [], worldBooks: [], myStickers: [], memoryJournals: [], groups: [] };
  const charMap = new Map();
  for (const c of byName.get('characters') || []) {
    const copy = { ...c, history: [] };
    charMap.set(c.id, copy);
    out.characters.push(copy);
  }
  for (const m of byName.get('messages') || []) {
    const cid = m.charId || m.characterId || null;
    let ch = cid ? charMap.get(cid) : null;
    if (!ch && out.characters.length === 1 && !cid) ch = out.characters[0];
    if (!ch && cid) {
      ch = { id: cid, realName: '未命名角色', history: [] };
      charMap.set(cid, ch);
      out.characters.push(ch);
    }
    if (ch) ch.history.push(m);
  }
  if (byName.get('worldBooks')) out.worldBooks = byName.get('worldBooks');
  if (byName.get('stickers')) out.myStickers = byName.get('stickers');
  if (byName.get('myStickers')) out.myStickers = byName.get('myStickers');
  if (byName.get('memoryJournals')) out.memoryJournals = byName.get('memoryJournals');
  if (byName.get('journals')) out.memoryJournals = [...out.memoryJournals, ...byName.get('journals')];
  if (byName.get('groups')) out.groups = byName.get('groups');
  return out;
}

/** 只有消息表、没有角色表时，按 charId 归组；没有 charId 的进一个占位角色。 */
function groupMessagesIntoCharacters(messages) {
  const groups = new Map();
  for (const m of messages || []) {
    const cid = (m && typeof m === 'object' && (m.charId || m.characterId)) || 'char_imported';
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(m);
  }
  return [...groups.entries()].map(([cid, history]) => ({
    id: cid, realName: cid === 'char_imported' ? '导入的消息' : '未命名角色', history,
  }));
}

/** 把原始备份解析成规范结构，未知字段原样保留在 _unknown / unknown 中。 */
export function normalizeBackup(raw) {
  let data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (Array.isArray(data)) {
    data = { characters: groupMessagesIntoCharacters(data) };
  }
  if (!data || typeof data !== 'object') throw new Error('备份不是有效的 JSON 对象。');
  const wasDexie = Array.isArray(data?.data?.tables);
  // Dexie 导出：{ formatName: 'dexie', data: { tables: [...] } }
  if (Array.isArray(data?.data?.tables)) {
    data = dexieTablesToBackup(data.data.tables);
  } else if (data.data && typeof data.data === 'object' && !Array.isArray(data.data)
    && (data.data.characters || data.data.messages || data.data.history)) {
    data = data.data; // { data: { characters, ... } } 包装
  }
  // 顶层只有消息表：{ messages: [...] } / { history: [...] }
  const topMessages = Array.isArray(data.messages) ? data.messages
    : (Array.isArray(data.history) ? data.history : null);
  if (topMessages && !Array.isArray(data.characters)) {
    data = { ...data, characters: groupMessagesIntoCharacters(topMessages) };
  }
  const out = {
    characters: [], worldBooks: [], stickers: [], journals: [],
    groups: [], apiSettings: null, apiPresets: [], cotSettings: null,
    unknown: {}, gaps: [],
  };
  const chars = Array.isArray(data.characters) ? data.characters : [];
  for (const c of chars) {
    const { _unknown, ...rest } = splitUnknown(c, KNOWN_CHAR_FIELDS);
    const journals = Array.isArray(c.memoryJournals) ? c.memoryJournals : [];
    // 有的备份把消息放在 c.messages 而不是 c.history
    const history = Array.isArray(c.history) ? c.history : (Array.isArray(c.messages) ? c.messages : []);
    out.characters.push({
      ...rest,
      memoryJournals: journals.map((j) => normalizeJournal(j, c.id)),
      history: history.map((m) => normalizeMessage(m, c.id)),
      _unknown,
    });
    for (const j of journals) {
      if (j && typeof j === 'object' && (j.vectorEntries || j.embedding || j.memoryMode)) {
        out.gaps.push(`记忆「${j.title || ''}」含有向量数据，已原样保存，待向量检索接入。`);
      }
    }
    if (c.memoryMode) out.gaps.push(`角色「${c.realName || c.id}」的 memoryMode=${c.memoryMode} 已保存；向量检索尚未接入。`);
  }
  // 角色表和消息表分开给时，把顶层消息按 charId 归到对应角色
  if (topMessages && out.characters.length) {
    for (const m of topMessages) {
      const cid = (m && typeof m === 'object' && (m.charId || m.characterId)) || null;
      const target = (cid && out.characters.find((c) => c.id === cid))
        || (out.characters.length === 1 ? out.characters[0] : null);
      if (target) target.history.push(normalizeMessage(m, target.id));
      else out.gaps.push('有消息找不到对应角色，已跳过（请检查备份里的 charId）。');
    }
  }
  if (wasDexie) out.gaps.push('Dexie 导出结构已转换：按表名归组为角色 / 消息 / 世界书。');
  if (out.characters.some((c) => c.id === 'char_imported')) out.gaps.push('备份只有消息表、没有角色信息，已按角色归组导入。');
  out.worldBooks = Array.isArray(data.worldBooks) ? data.worldBooks.map((w) => {
    const { _unknown, ...rest } = splitUnknown(w, new Set(['id', 'title', 'content', 'position', 'depth', 'category', 'type', 'enabled']));
    return { ...rest, _unknown };
  }) : [];
  out.stickers = Array.isArray(data.myStickers) ? data.myStickers : [];
  if (Array.isArray(data.memoryJournals)) {
    out.journals = data.memoryJournals.map((j) => normalizeJournal(j, null));
  }
  out.groups = Array.isArray(data.groups) ? data.groups : [];
  if (out.groups.length) out.gaps.push(`备份含 ${out.groups.length} 个群聊，本阶段为单人聊天，不展示群聊，但数据已原样保存。`);
  out.apiSettings = data.apiSettings || null;
  out.apiPresets = Array.isArray(data.apiPresets) ? data.apiPresets : [];
  // 全局提示词设置：顶层 cotSettings 优先，其次 globalSettings 里的 cotSettings。
  out.cotSettings = data.cotSettings || data.globalSettings?.cotSettings || null;
  for (const k of Object.keys(data)) {
    if (!KNOWN_TOP_FIELDS.has(k)) out.unknown[k] = data[k];
  }
  if (data.vectorEntries || data.embeddings) out.gaps.push('备份含顶层向量数据，已原样保存，待向量检索接入。');
  return out;
}

function splitUnknown(obj, known) {
  const _unknown = {};
  const rest = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (known.has(k)) rest[k] = v; else _unknown[k] = v;
  }
  return { _unknown, ...rest };
}

function normalizeJournal(j, charId) {
  if (!j || typeof j !== 'object') return j;
  const { _unknown, ...rest } = splitUnknown(j, new Set(['id', 'title', 'content', 'isFavorited', 'timestamp', 'createdAt', 'source', 'charId', 'characterId']));
  return { ...rest, charId: charId ?? j.charId ?? j.characterId ?? null, _unknown };
}

/** 无 ID 的消息用稳定 ID 识别：charId + timestamp + 内容哈希；绝不按正文/时间去重删除。 */
export function stableMessageId(msg, charId) {
  if (msg?.id) return String(msg.id);
  const content = typeof msg?.content === 'string' ? msg.content
    : JSON.stringify(msg?.parts || '');
  return `msg_stable_${hashString(`${charId}|${msg?.timestamp ?? ''}|${content}`)}`;
}

function normalizeMessage(m, charId) {
  if (!m || typeof m !== 'object') return m;
  const { _unknown, ...rest } = splitUnknown(m, new Set(['id', 'role', 'content', 'parts', 'timestamp',
    'quote', 'isWithdrawn', 'originalContent', 'isContextDisabled', 'isThinking', 'isStatusUpdate',
    'statusSnapshot', 'stickerData', 'stickerName', 'transferStatus', 'giftStatus', 'senderId',
    'roundId', 'templateId', 'templateVersion', 'statusText', 'voiceText', 'photoDescription']));
  return { ...rest, id: stableMessageId(m, charId), charId, _unknown };
}

export function previewCounts(normalized) {
  const messages = normalized.characters.reduce((s, c) => s + (c.history?.length || 0), 0);
  return {
    characters: normalized.characters.map((c) => ({
      id: c.id, realName: c.realName, messages: c.history?.length || 0,
      journals: c.memoryJournals?.length || 0, worldBooks: (c.worldBookIds || []).length,
    })),
    worldBooks: normalized.worldBooks.length,
    stickers: normalized.stickers.length,
    journals: normalized.journals.length,
    messages,
    groups: normalized.groups.length,
    unknownKeys: Object.keys(normalized.unknown),
    gaps: normalized.gaps,
  };
}

function stripKeys(value) {
  if (Array.isArray(value)) return value.map(stripKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 注意：apiSettings 里的字段名就是裸 'key'，只匹配 apiKey/api_key 会漏掉它，
      // 默认导出会把密钥带出去。裸 key 字段一律按凭据处理。
      if (/api[_-]?key|^key$|password|token|secret/i.test(k)) continue;
      out[k] = stripKeys(v);
    }
    return out;
  }
  return value;
}

/**
 * 合并导入。mode 'merge'（默认，不覆盖已有库）或 'replace'（先清空同类表）。
 * 返回报告 { added, updated, skipped, conflicts[], unknownPreserved, keysStripped }。
 */
export async function importNormalized(backend, normalized, { mode = 'merge', mainCharacterId = null } = {}) {
  const report = { added: {}, updated: {}, skipped: {}, conflicts: [], unknownPreserved: [], keysStripped: true };
  const count = (t, n) => { report.added[t] = (report.added[t] || 0) + n; };
  if (mode === 'replace') {
    for (const t of ['characters', 'worldBooks', 'stickers', 'journals', 'messages']) await backend.clear(t);
  }
  const existingChars = new Map((await backend.getAll('characters')).map((c) => [c.id, c]));
  for (const c of normalized.characters) {
    const { history, ...charData } = c;
    const isMain = mainCharacterId ? c.id === mainCharacterId : false;
    if (existingChars.has(c.id)) {
      const prev = existingChars.get(c.id);
      report.conflicts.push(`角色「${c.realName || c.id}」已存在：保留原有角色，导入的设定未覆盖（主角色=${isMain ? '是' : '否'}）。`);
      report.skipped.characters = (report.skipped.characters || 0) + 1;
      void prev;
    } else {
      await backend.put('characters', { ...charData, memoryJournals: undefined, history: undefined, _isMain: isMain });
      count('characters', 1);
    }
    // 记忆日记分开保存
    for (const j of c.memoryJournals || []) {
      const jid = j.id || `journal_${hashString(`${c.id}|${j.title || ''}|${j.timestamp || ''}`)}`;
      const existing = await backend.get('journals', jid);
      if (!existing) { await backend.put('journals', { ...j, id: jid, charId: c.id }); count('journals', 1); }
      else report.skipped.journals = (report.skipped.journals || 0) + 1;
    }
    // 消息增量写入（按稳定 ID 去重，不按正文/时间删）
    const existingIds = new Set();
    if (mode === 'merge') {
      const all = await backend.getAllMessages(c.id);
      for (const m of all) existingIds.add(m.id);
    }
    let added = 0, skipped = 0;
    for (const m of history || []) {
      if (existingIds.has(m.id)) { skipped++; continue; }
      await backend.put('messages', m);
      existingIds.add(m.id);
      added++;
    }
    count('messages', added);
    if (skipped) report.skipped.messages = (report.skipped.messages || 0) + skipped;
  }
  for (const w of normalized.worldBooks) {
    const existing = await backend.get('worldBooks', w.id);
    if (!existing) { await backend.put('worldBooks', w); count('worldBooks', 1); }
    else report.skipped.worldBooks = (report.skipped.worldBooks || 0) + 1;
  }
  for (const s of normalized.stickers) {
    const existing = await backend.get('stickers', s.id);
    if (!existing) { await backend.put('stickers', s); count('stickers', 1); }
    else report.skipped.stickers = (report.skipped.stickers || 0) + 1;
  }
  for (const j of normalized.journals) {
    const jid = j.id || `journal_${hashString(`${j.title || ''}|${j.timestamp || ''}`)}`;
    const existing = await backend.get('journals', jid);
    if (!existing) { await backend.put('journals', { ...j, id: jid }); count('journals', 1); }
  }
  for (const [k, v] of Object.entries(normalized.unknown || {})) {
    await backend.put('unknown', { key: `backup:${k}`, value: v });
    report.unknownPreserved.push(k);
  }
  if (normalized.groups?.length) {
    await backend.put('unknown', { key: 'backup:groups', value: normalized.groups });
    report.unknownPreserved.push('groups');
  }
  // 全局提示词设置（不含凭据）：导入的 cotSettings 直接生效，决定 TT/UWU 版本与 CoT 开关。
  // 之前 normalize 只解析不保存，界面写死了 promptVersion='tt'，导入的设置根本没用上。
  if (normalized.cotSettings) {
    await backend.put('settings', { key: 'cotSettings', value: normalized.cotSettings });
  }
  // 凭据永不随导入落库：apiSettings/apiPresets 仅在用户于 API 页手动填写后保存。
  return report;
}

/** 导出：默认不含密钥；includeKeys=true 时需用户在导出页明确勾选（私人备份）。 */
export async function exportAll(backend, { includeKeys = false } = {}) {
  const characters = await backend.getAll('characters');
  const out = { version: 1, app: 'uwu-chat', exportedAt: new Date().toISOString(), characters: [], worldBooks: [], myStickers: [], unknown: {} };
  for (const c of characters) {
    const history = await backend.getAllMessages(c.id);
    const journals = (await backend.getAll('journals')).filter((j) => j.charId === c.id);
    out.characters.push({ ...c, history, memoryJournals: journals });
  }
  out.worldBooks = await backend.getAll('worldBooks');
  out.myStickers = await backend.getAll('stickers');
  const unknowns = await backend.getAll('unknown');
  for (const u of unknowns) {
    if (String(u.key).startsWith('backup:')) out.unknown[u.key.slice(7)] = u.value;
  }
  const settings = await backend.get('settings', 'api');
  if (settings) out.apiSettings = settings.value;
  const presets = await backend.get('settings', 'apiPresets');
  if (presets) out.apiPresets = presets.value;
  if (!includeKeys) {
    // 显式删除（stripKeys 也会处理，双重保障）：默认导出绝不含密钥。
    if (out.apiSettings) { const { key, ...rest } = out.apiSettings; void key; out.apiSettings = rest; }
    if (Array.isArray(out.apiPresets)) {
      out.apiPresets = out.apiPresets.map((p) => { const { key, ...rest } = p || {}; void key; return rest; });
    }
  }
  return includeKeys ? out : stripKeys(out);
}
