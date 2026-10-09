// EllieEdit service worker.
// Deployment discipline: BUMP CACHE on every deploy. Static JS/CSS are
// NETWORK-FIRST with cache fallback so a deploy is picked up on the next
// online load — a cache-first policy here poisoned clients with intermediate
// builds once already (blank-canvas incident 2026-10-07). Only heavy binary
// assets (icons, manifest) are cache-first.
const CACHE = 'ellieedit-v3-20261008n';
const SHELL = [
  '/',
  '/index.html',
  '/js/shell.js',
  '/js/components/canvas-stack.js',
  '/js/components/jobpanel.js',
  '/js/modules/gallery.js',
  '/js/modules/facecycle.js',
  '/js/modules/review.js',
  '/js/champion-ladder.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // network only

  // Navigations, shell documents, and all JS: network-first, cache fallback.
  // This is the deploy-freshness guarantee.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html' ||
      url.pathname.startsWith('/js/')) {
    e.respondWith(
      fetch(e.request)
        .then(r => {
          if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
          return r;
        })
        .catch(() => caches.match(e.request).then(hit => hit || caches.match('/'))));
    return;
  }

  // Heavy binary assets: cache-first, refresh in background.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || net;
    }));
});
