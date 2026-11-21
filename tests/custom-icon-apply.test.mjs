import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CUSTOM_ICON_API_URL, CUSTOM_ICON_VERSION_KEY,
  buildCustomIconVersionedUrl, uploadCustomIcon, fetchCustomIconMeta,
  applyCustomIconUrl, deleteCustomIcon,
} from '../js/customIcon.js';

test('版本化 URL 拼装：version 形如 icon-<时间戳>.png', () => {
  assert.equal(CUSTOM_ICON_API_URL, '/api/custom-icon');
  assert.equal(CUSTOM_ICON_VERSION_KEY, 'verweile.customIcon.version');
  assert.equal(buildCustomIconVersionedUrl('icon-1793123456789.png'), '/api/custom-icon/icon-1793123456789.png');
});

function stubDoc() {
  const idLink = { id: 'apple-touch-icon-link', rel: 'apple-touch-icon', href: '/apple-touch-icon.png' };
  const extraLink = { rel: 'apple-touch-icon', href: '/old.png' };
  const links = [idLink, extraLink];
  return {
    links,
    getElementById: (id) => links.find((l) => l.id === id) || null,
    querySelectorAll: (sel) => (sel === 'link[rel="apple-touch-icon"]' ? [...links] : []),
  };
}

test('applyCustomIconUrl：id link 与全部 rel link 的 href 都改', () => {
  const doc = stubDoc();
  applyCustomIconUrl('/api/custom-icon/icon-1793123456789.png', doc);
  assert.equal(doc.links[0].href, '/api/custom-icon/icon-1793123456789.png');
  assert.equal(doc.links[1].href, '/api/custom-icon/icon-1793123456789.png');
  // 恢复默认：指回部署文件
  applyCustomIconUrl('/apple-touch-icon.png', doc);
  assert.equal(doc.links[0].href, '/apple-touch-icon.png');
  assert.equal(doc.links[1].href, '/apple-touch-icon.png');
});

test('applyCustomIconUrl：页面里没有 link 时不抛错', () => {
  const emptyDoc = { getElementById: () => null, querySelectorAll: () => [] };
  assert.doesNotThrow(() => applyCustomIconUrl('/api/custom-icon/icon-1.png', emptyDoc));
  assert.doesNotThrow(() => applyCustomIconUrl('/api/custom-icon/icon-1.png', null));
  assert.doesNotThrow(() => applyCustomIconUrl('/api/custom-icon/icon-1.png', undefined));
});

test('uploadCustomIcon：POST 到 /api/custom-icon，Content-Type 为 image/png，返回 version/url', async () => {
  const calls = [];
  const blob = new Blob(['fake-png'], { type: 'image/png' });
  const stubFetch = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true, json: async () => ({ version: 'icon-1793123456789.png', url: '/api/custom-icon/icon-1793123456789.png' }) };
  };
  const r = await uploadCustomIcon(blob, stubFetch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/custom-icon');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['Content-Type'], 'image/png');
  assert.equal(calls[0].opts.body, blob);
  assert.equal(r.version, 'icon-1793123456789.png');
  assert.equal(r.url, '/api/custom-icon/icon-1793123456789.png');
});

test('uploadCustomIcon：服务端 400 时抛错并带上 reason', async () => {
  const stubFetch = async () => ({
    ok: false, status: 400,
    json: async () => ({ reason: 'not a png' }),
    text: async () => 'not a png',
  });
  await assert.rejects(() => uploadCustomIcon(new Blob(['x'], { type: 'image/png' }), stubFetch), /not a png/);
});

test('fetchCustomIconMeta / deleteCustomIcon：走约定 URL 与方法', async () => {
  const calls = [];
  const stubFetch = async (url, opts) => {
    calls.push({ url, method: opts?.method || 'GET' });
    return { ok: true, json: async () => ({ version: 'icon-1793123456789.png' }) };
  };
  const meta = await fetchCustomIconMeta(stubFetch);
  assert.equal(meta.version, 'icon-1793123456789.png');
  const del = await deleteCustomIcon(stubFetch);
  assert.equal(del.version, 'icon-1793123456789.png');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    'GET /api/custom-icon/meta',
    'DELETE /api/custom-icon',
  ]);
});
