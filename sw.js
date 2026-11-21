// sw.js — verweile Service Worker。
// 职责只有两件：① 收到 push 按 payload 显示通知；② 通知点击聚焦已有
// 客户端或打开对应聊天 URL。
// 缓存策略：
// - 版本化缓存名 verweile-v<VERSION>；更新时只删旧版本缓存，
// - index.html 网络优先（短缓存）；静态资源缓存优先。
// - 更新绝不清除 IndexedDB：Service Worker 没有、也不应有删除 IndexedDB
//   的代码；聊天记录、设置、唤醒状态都在 IndexedDB 里，删缓存 ≠ 删数据。
// 注意：本文件不在 build-preview.mjs 的拼接列表里（它是独立的
// Service Worker 脚本，不能被内联进单文件 HTML）；集成时由 build-icons
// 或部署流程把它复制到 dist/sw.js，并注册 /sw.js。未部署前不生效。

const VERSION = '2';
const CACHE_NAME = `verweile-v${VERSION}`;
// manifest / 图标可能尚未生成：逐个缓存，单个失败不影响其他资源，
// 也不阻塞 skipWaiting（旧版 cache.addAll 一个 404 就全失败）。
const STATIC_ASSETS = ['./', './index.html', './manifest.json', './icons/apple-touch-icon.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.allSettled(STATIC_ASSETS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      // 只删旧版本缓存；绝不碰 IndexedDB。
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // index.html：网络优先，离线才用缓存（短缓存，避免旧版久留）。
  if (url.pathname === '/' || url.pathname.endsWith('/index.html')) {
    event.respondWith(
      fetch(request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(request)),
    );
    return;
  }
  // 静态资源：缓存优先，后台更新缓存。
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((c) => c.put(request, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    }),
  );
});

// push：按 payload 显示通知；payload 只含唤醒元数据（wakeId/标题），
// 不含聊天正文——正文由前端在页面打开后从 IndexedDB 读取。
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'verweile';
  const body = data.body || '有新消息';
  const url = data.url || '/';
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      tag: data.tag || `wake-${data.wakeId || Date.now()}`,
      data: { messageId: data.messageId || null, charId: data.charId || null, url },
    }),
  );
});

// notificationclick：聚焦已有客户端或打开对应聊天 URL；不生成新消息。
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const target = new URL(url, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (client.url === target || new URL(client.url).pathname === new URL(target).pathname) {
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    }),
  );
});
