// custom-icon-api.test.mjs — /api/custom-icon 函数处理器的纯逻辑测试。
// 只测注入 store 的 createCustomIconHandler，不依赖真实 Netlify Blobs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { createCustomIconHandler, MAX_ICON_BYTES } from '../netlify/functions/custom-icon.mjs';

/** Map 实现的 mock store：handler 只用 get/set/delete。 */
class MockStore {
  constructor() { this.map = new Map(); }
  async get(key) {
    const v = this.map.get(key);
    return v === undefined ? null : v;
  }
  async set(key, value) {
    this.map.set(key, value instanceof Uint8Array ? value : new Uint8Array(value));
  }
  async delete(key) { this.map.delete(key); }
}

function handler(store = new MockStore()) {
  return { store, handle: createCustomIconHandler(store) };
}

const req = (path, { method = 'GET', headers = {}, body } = {}) =>
  new Request(`https://verweile0214.netlify.app${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : body,
  });

// --- 最小合法 PNG 生成（手写 IHDR + zlib 压缩的纯色 IDAT + IEND） ---

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])), 8 + data.length);
  return out;
}

/** 生成 width×height 的纯色 RGB PNG（边长由参数控制）。 */
function makePng(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type RGB
  const row = Buffer.alloc(1 + width * 3); // filter 0 + 纯黑像素
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const pngHeaders = { 'content-type': 'image/png' };

test('POST 校验：非 PNG → 400', async () => {
  const { handle } = handler();
  const res = await handle(req('/api/custom-icon', {
    method: 'POST',
    headers: { 'content-type': 'image/png' },
    body: Buffer.from('not a png at all, just text'),
  }));
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.ok, false);
  assert.match(body.reason, /PNG/);
});

test('POST 校验：Content-Type 不是 image/png → 400', async () => {
  const { handle } = handler();
  const res = await handle(req('/api/custom-icon', {
    method: 'POST',
    headers: { 'content-type': 'image/jpeg' },
    body: makePng(512, 512),
  }));
  assert.equal(res.status, 400);
  assert.equal((await res.json()).ok, false);
});

test('POST 校验：超 2MB → 400', async () => {
  const { handle } = handler();
  const big = Buffer.concat([makePng(512, 512), Buffer.alloc(MAX_ICON_BYTES)]);
  const res = await handle(req('/api/custom-icon', {
    method: 'POST',
    headers: pngHeaders,
    body: big,
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).reason, /2MB/);
});

test('POST 校验：非正方形 → 400', async () => {
  const { handle } = handler();
  const res = await handle(req('/api/custom-icon', {
    method: 'POST',
    headers: pngHeaders,
    body: makePng(512, 256),
  }));
  assert.equal(res.status, 400);
  assert.match((await res.json()).reason, /正方形/);
});

test('POST 校验：边长 <180 或 >2048 → 400', async () => {
  const { handle } = handler();
  const small = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: makePng(100, 100),
  }));
  assert.equal(small.status, 400);
  assert.match((await small.json()).reason, /180–2048/);
  const huge = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: makePng(2049, 2049),
  }));
  assert.equal(huge.status, 400);
  assert.match((await huge.json()).reason, /180–2048/);
});

test('POST 合法 512×512 PNG → 200，两次上传版本号不同，current 指向最新', async () => {
  const { store, handle } = handler();
  const png1 = makePng(512, 512);
  const res1 = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: png1,
  }));
  assert.equal(res1.status, 200);
  const b1 = await res1.json();
  assert.equal(b1.ok, true);
  assert.match(b1.version, /^icon-\d+\.png$/);
  assert.equal(b1.url, `/api/custom-icon/${b1.version}`);

  const png2 = makePng(180, 180);
  const res2 = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: png2,
  }));
  const b2 = await res2.json();
  assert.equal(res2.status, 200);
  assert.match(b2.version, /^icon-\d+\.png$/);
  assert.notEqual(b2.version, b1.version, '每次上传必须生成新版本号');

  // current 指针指向最新版本，且旧版本 blob 仍在（可回滚/可被直接访问）
  const current = new TextDecoder().decode(await store.get('current'));
  assert.equal(current, b2.version);
  assert.deepEqual(Buffer.from(await store.get(b1.version)), png1);
  assert.deepEqual(Buffer.from(await store.get(b2.version)), png2);
});

test('GET 裸路径：有图标 → 302 到版本化 URL；无图标 → 302 到默认图标', async () => {
  const empty = handler();
  const noIcon = await empty.handle(req('/api/custom-icon'));
  assert.equal(noIcon.status, 302);
  assert.equal(noIcon.headers.get('location'), '/apple-touch-icon.png');

  const { handle } = handler();
  const up = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: makePng(512, 512),
  }));
  const { version } = await up.json();
  const withIcon = await handle(req('/api/custom-icon'));
  assert.equal(withIcon.status, 302);
  assert.equal(withIcon.headers.get('location'), `/api/custom-icon/${version}`);
});

test('GET 版本化：存在 → 200 + image/png + immutable 缓存头 + 字节一致；不存在 → 404', async () => {
  const { handle } = handler();
  const png = makePng(512, 512);
  const up = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: png,
  }));
  const { version } = await up.json();

  const hit = await handle(req(`/api/custom-icon/${version}`));
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get('content-type'), 'image/png');
  assert.equal(hit.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  assert.deepEqual(Buffer.from(await hit.arrayBuffer()), png);

  const miss = await handle(req('/api/custom-icon/icon-1234567890123.png'));
  assert.equal(miss.status, 404);
  assert.equal((await miss.json()).ok, false);
});

test('GET meta：有图标 → hasCustom:true + version/url/updatedAt；无图标 → hasCustom:false', async () => {
  const empty = handler();
  const noIcon = await empty.handle(req('/api/custom-icon/meta'));
  assert.equal(noIcon.status, 200);
  assert.deepEqual(await noIcon.json(), {
    hasCustom: false, version: null, url: null, updatedAt: null,
  });

  const { handle } = handler();
  const before = Date.now();
  const up = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: makePng(512, 512),
  }));
  const { version } = await up.json();
  const meta = await handle(req('/api/custom-icon/meta'));
  assert.equal(meta.status, 200);
  const m = await meta.json();
  assert.equal(m.hasCustom, true);
  assert.equal(m.version, version);
  assert.equal(m.url, `/api/custom-icon/${version}`);
  // updatedAt 是从版本号里解析的真实时间戳
  const ts = Number(version.slice(5, -4));
  assert.equal(m.updatedAt, new Date(ts).toISOString());
  assert.ok(Date.parse(m.updatedAt) >= before);
});

test('DELETE：删当前版本 + 清 current → { ok:true, restored:true }，之后 meta 变 hasCustom:false', async () => {
  const { store, handle } = handler();
  const up = await handle(req('/api/custom-icon', {
    method: 'POST', headers: pngHeaders, body: makePng(512, 512),
  }));
  const { version } = await up.json();

  const del = await handle(req('/api/custom-icon', { method: 'DELETE' }));
  assert.equal(del.status, 200);
  assert.deepEqual(await del.json(), { ok: true, restored: true });
  assert.equal(await store.get(version), null);
  assert.equal(await store.get('current'), null);

  const meta = await handle(req('/api/custom-icon/meta'));
  assert.equal((await meta.json()).hasCustom, false);
  const bare = await handle(req('/api/custom-icon'));
  assert.equal(bare.headers.get('location'), '/apple-touch-icon.png');
});

test('其他方法 → 405；未知子路径 → 404', async () => {
  const { handle } = handler();
  const put = await handle(req('/api/custom-icon', { method: 'PUT' }));
  assert.equal(put.status, 405);
  const unknown = await handle(req('/api/custom-icon/whatever'));
  assert.equal(unknown.status, 404);
});
