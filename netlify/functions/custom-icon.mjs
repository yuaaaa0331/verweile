// custom-icon.mjs — 自定义主屏幕图标的服务端端点（Netlify Function）。
//
// 架构抉择：为什么必须走服务端真实文件，而不是 data URL / Blob URL / Service Worker
// ----------------------------------------------------------------------------------
// iOS“添加到主屏幕”抓图标发生在 OS 层：系统按 URL 从网络直接抓取图标文件，
// data URL / Blob URL / Service Worker 缓存都进不了这个流程（SW 只覆盖浏览器内
// 的 fetch，不覆盖 OS 层的 webclip 图标抓取）。同时 iOS 主屏幕图标由 OS 缓存，
// 不受 HTTP 缓存头控制——换图必须换真实文件名，query string 不可靠。
// 证据：reSOURCERY CHANGELOG v2.4.7（2026-07-16）：
//   “The service worker is network-first and doesn't cover the OS-level webclip
//    icon fetch”；“renamed icons/apple-touch-icon.png → icons/apple-touch-icon-v2.png.
//    A brand-new URL cannot be served from the stale cache … (A query string alone
//    is unreliable for iOS webclips; a real filename change is not.)”
//   以及 v2.4.6 Notes：“iOS Home Screen webclip icons are cached by the OS and are
//    not governed by HTTP headers — evicting those still requires removing and
//    re-adding the icon.”
//   https://github.com/seanvasey/resourcery/blob/HEAD/CHANGELOG.md
// 因此：客户端裁切后把 PNG POST 到这里，服务端存入 Netlify Blobs（site-scoped，
// 换部署不丢），每次上传生成新版本键 icon-<时间戳>.png，裸路径 302 到最新版本化
// URL；客户端把该 URL 写进 apple-touch-icon <link>，iOS 每次重装都抓到新文件。
//
// 安全说明：这是个人站，上传端点无鉴权——知道 URL 就能覆盖图标。风险限于图标
// 本身（只能换一张 PNG，不能读/写其他数据），且服务端只接受 image/png、≤2MB、
// 正方形、边长 180–2048 的图片，接受这一取舍。
//
// 存储：getStore({ name: 'custom-icon', consistency: 'strong' }) 是 site-scoped
// 的 store（绝不能用 getDeployStore——换部署会丢图标）；strong consistency 保证
// 上传后立即读得到。凭据由 Netlify 在函数内自动注入，无需配置。
// 键：版本 blob 为 `icon-<Date.now()>.png`；`current` 指针存当前版本号（UTF-8 文本）。

import { getStore } from '@netlify/blobs';
import { readPngSize } from '../../js/customIcon.js';

export const MAX_ICON_BYTES = 2 * 1024 * 1024;
export const MIN_ICON_SIDE = 180;
export const MAX_ICON_SIDE = 2048;
export const CURRENT_KEY = 'current';
export const DEFAULT_ICON_URL = '/apple-touch-icon.png';
export const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';

const VERSION_RE = /^icon-(\d+)\.png$/;

/** 从版本号解析上传时间戳（毫秒），解析失败返回 null。 */
export function versionTimestamp(version) {
  const m = VERSION_RE.exec(version || '');
  return m ? Number(m[1]) : null;
}

export function versionUrl(version) {
  return `/api/custom-icon/${version}`;
}

/** 同一毫秒内连续上传也必须生成不同版本号：单调递增的时间戳。 */
let lastVersionTs = 0;
export function nextVersion() {
  const ts = Math.max(Date.now(), lastVersionTs + 1);
  lastVersionTs = ts;
  return `icon-${ts}.png`;
}

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...extraHeaders },
  });
}

function fail(reason, status = 400) {
  return json({ ok: false, reason }, status);
}

/** store.get 返回 ArrayBuffer（真实 Blobs）或 Uint8Array（测试 mock）或 null。 */
async function getBytes(store, key) {
  const v = await store.get(key);
  if (v == null) return null;
  return v instanceof Uint8Array ? v : new Uint8Array(v);
}

async function getCurrentVersion(store) {
  const bytes = await getBytes(store, CURRENT_KEY);
  if (!bytes) return null;
  const version = new TextDecoder().decode(bytes).trim();
  return VERSION_RE.test(version) ? version : null;
}

async function setCurrentVersion(store, version) {
  await store.set(CURRENT_KEY, new TextEncoder().encode(version));
}

async function buildMeta(store) {
  const version = await getCurrentVersion(store);
  if (!version) return { hasCustom: false, version: null, url: null, updatedAt: null };
  const ts = versionTimestamp(version);
  return {
    hasCustom: true,
    version,
    url: versionUrl(version),
    updatedAt: ts ? new Date(ts).toISOString() : null,
  };
}

async function handleUpload(store, req) {
  const contentType = (req.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'image/png') {
    return fail(`只接受 image/png（实际 ${contentType || '未知'}）。`);
  }
  const declared = Number(req.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) {
    return fail(`图片超过 2MB（实际 ${(declared / 1024 / 1024).toFixed(1)}MB）。`);
  }
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.length > MAX_ICON_BYTES) {
    return fail(`图片超过 2MB（实际 ${(bytes.length / 1024 / 1024).toFixed(1)}MB）。`);
  }
  const size = readPngSize(bytes);
  if (!size.ok) return fail(size.reason || '不是有效的 PNG 文件。');
  if (size.width !== size.height) {
    return fail(`图标须为正方形（实际 ${size.width}×${size.height}）。`);
  }
  if (size.width < MIN_ICON_SIDE || size.width > MAX_ICON_SIDE) {
    return fail(`图标边长须在 ${MIN_ICON_SIDE}–${MAX_ICON_SIDE}px 之间（实际 ${size.width}px）。`);
  }
  const version = nextVersion();
  await store.set(version, bytes);
  await setCurrentVersion(store, version);
  return json({ ok: true, version, url: versionUrl(version) });
}

async function handleDelete(store) {
  const version = await getCurrentVersion(store);
  if (version) await store.delete(version);
  await store.delete(CURRENT_KEY);
  return json({ ok: true, restored: true });
}

/**
 * 核心处理器：可注入 store（测试用 Map mock，不依赖真实 Blobs）。
 * 路由（全部同源 /api/custom-icon）：
 *   GET  /api/custom-icon            → 302 到最新版本化 URL；无图标时 302 到默认图标
 *   GET  /api/custom-icon/<v>.png   → PNG 字节（immutable 长缓存）；不存在 → 404
 *   GET  /api/custom-icon/meta      → { hasCustom, version, url, updatedAt }
 *   POST /api/custom-icon            → raw image/png body，校验后存新版本
 *   DELETE /api/custom-icon          → 删当前版本 + 清 current
 *   其他方法 → 405；其他子路径 → 404。
 */
export function createCustomIconHandler(store) {
  return async function handleCustomIcon(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = (req.method || 'GET').toUpperCase();

    if (path === '/api/custom-icon') {
      if (method === 'GET') {
        const version = await getCurrentVersion(store);
        return new Response(null, {
          status: 302,
          headers: { location: version ? versionUrl(version) : DEFAULT_ICON_URL },
        });
      }
      if (method === 'POST') return handleUpload(store, req);
      if (method === 'DELETE') return handleDelete(store);
      return fail('不支持的方法。', 405);
    }

    if (path === '/api/custom-icon/meta') {
      if (method !== 'GET') return fail('不支持的方法。', 405);
      return json(await buildMeta(store));
    }

    const versionMatch = /^\/api\/custom-icon\/(icon-\d+\.png)$/.exec(path);
    if (versionMatch) {
      if (method !== 'GET') return fail('不支持的方法。', 405);
      const bytes = await getBytes(store, versionMatch[1]);
      if (!bytes) return fail('图标版本不存在。', 404);
      return new Response(bytes, {
        status: 200,
        headers: {
          'content-type': 'image/png',
          'cache-control': VERSIONED_CACHE_CONTROL,
          'content-length': String(bytes.length),
        },
      });
    }

    return fail('未找到。', 404);
  };
}

export default async function handler(req, context) {
  const store = getStore({ name: 'custom-icon', consistency: 'strong' });
  return createCustomIconHandler(store)(req, context);
}

export const config = { path: ['/api/custom-icon', '/api/custom-icon/*'] };
