// EllieEdit service worker — minimal: cache the shell for fast loads,
// network-first for API and navigation (full offline NOT required).
const CACHE = 'ellieedit-v1';
const SHELL = [
  '/',
  '/index.html',
  '/js/shell.js',
  '/js/components/canvas-stack.js',
  '/js/components/pending.js',
  '/js/components/jobpanel.js',
  '/js/modules/facecycle.js',
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

  // Navigations & shell documents: network-first, fall back to cache.
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(
      fetch(e.request)
        .then(r => { caches.open(CACHE).then(c => c.put('/', r.clone())); return r; })
        .catch(() => caches.match('/')));
    return;
  }

  // Static assets: cache-first, refresh in background.
  e.respondWith(
    caches.match(e.request).then(hit => {
      const net = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => hit);
      return hit || net;
    }));
});
