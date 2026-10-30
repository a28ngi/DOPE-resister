// 電波が悪い会場でも画面が開けるよう、画面のファイルを端末に保存しておく。
// 画面は保存した分をすぐ出し、裏で最新版を取りに行く。/api は保存しない。
const CACHE = 'dopepos-v3';
const SHELL = ['/', '/app.js', '/app.css', '/logo.webp', '/manifest.webmanifest', '/icon-180.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;
  const key = url.origin === location.origin && e.request.mode === 'navigate' ? '/' : e.request;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(key);
    const net = fetch(e.request).then((r) => {
      if (r.ok && (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname.endsWith('googleapis.com'))) c.put(key, r.clone());
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
