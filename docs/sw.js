// Service worker: la app funciona sin conexión y avisa de nuevas versiones.
// IMPORTANTE: sube VERSION (y APP_VERSION en js/app.js) en cada cambio publicado,
// y añade aquí cualquier archivo nuevo de la app (los tests e2e lo comprueban).
const VERSION = '1.2.0';
const SHELL = `turnos-shell-${VERSION}`;
const RUNTIME = `turnos-runtime-${VERSION}`;
// Tesseract (vendor/): grande y cambia poco, por eso va aparte de VERSION.
// Sube VENDOR_VERSION cada vez que cambie algo en docs/vendor/ (la caché vieja se borra al activar).
const VENDOR_VERSION = 'tesseract-7.0.0-1';
const VENDOR = `turnos-vendor-${VENDOR_VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon.svg',
  'icons/maskable-512.png',
  'js/app.js',
  'js/core/advice.js',
  'js/core/cipher.js',
  'js/core/codes.js',
  'js/core/dates.js',
  'js/core/diff.js',
  'js/core/hours.js',
  'js/core/ics.js',
  'js/core/index.js',
  'js/core/ntfy.js',
  'js/core/reminders.js',
  'js/core/store.js',
  'js/core/sync.js',
  'js/core/util.js',
  'js/recognize/index.js',
  'js/recognize/ocr-pool.js',
  'js/recognize/pc/badges.js',
  'js/recognize/pc/calendar.js',
  'js/recognize/pc/cells.js',
  'js/recognize/pc/codes.js',
  'js/recognize/pc/debug.js',
  'js/recognize/pc/decide.js',
  'js/recognize/pc/geom.js',
  'js/recognize/pc/grid.js',
  'js/recognize/pc/img.js',
  'js/recognize/pc/lines.js',
  'js/recognize/pc/ocr.js',
  'js/recognize/pc/recognize.js',
  'js/recognize/pc/table.js',
  'js/recognize/pc/tmatch.js',
  'js/recognize/phone-a/calendar.js',
  'js/recognize/phone-a/codes.js',
  'js/recognize/phone-a/debug.js',
  'js/recognize/phone-a/geom.js',
  'js/recognize/phone-a/img.js',
  'js/recognize/phone-a/ocr.js',
  'js/recognize/phone-a/recognize.js',
  'js/recognize/phone-b/badgeocr.js',
  'js/recognize/phone-b/calendar.js',
  'js/recognize/phone-b/canon.js',
  'js/recognize/phone-b/codes.js',
  'js/recognize/phone-b/crops.js',
  'js/recognize/phone-b/debug.js',
  'js/recognize/phone-b/geom.js',
  'js/recognize/phone-b/img.js',
  'js/recognize/phone-b/layout.js',
  'js/recognize/phone-b/lines.js',
  'js/recognize/phone-b/ocr.js',
  'js/recognize/phone-b/raster.js',
  'js/recognize/phone-b/recognize.js',
  'js/recognize/phone-b/rows.js',
  'js/ui/attention.js',
  'js/ui/background.js',
  'js/ui/badge.js',
  'js/ui/banners.js',
  'js/ui/calendar.js',
  'js/ui/codeEditor.js',
  'js/ui/dayEditor.js',
  'js/ui/dom.js',
  'js/ui/hours.js',
  'js/ui/icons.js',
  'js/ui/install.js',
  'js/ui/onboarding.js',
  'js/ui/scan.js',
  'js/ui/settings.js',
  'js/ui/setup.js',
  'js/ui/sheet.js',
  'js/ui/shifts.js',
  'js/ui/syncStatus.js',
  'js/ui/toast.js',
  'js/ui/today.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE.map((u) => new Request(u, { cache: 'reload' })))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Borra las cachés de versiones anteriores (también las de vendor/ con otra VENDOR_VERSION)
    await Promise.all(keys
      .filter((k) => k.startsWith('turnos-') && k !== SHELL && k !== RUNTIME && k !== VENDOR)
      .map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports?.[0]?.postMessage({ version: VERSION, vendor: VENDOR_VERSION });
});

async function cacheFirst(request, cacheName, { ignoreSearch = true } = {}) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch });
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok && res.type === 'basic') cache.put(request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // GitHub, ntfy…: siempre a la red
  const scope = new URL(self.registration.scope).pathname;
  if (!url.pathname.startsWith(scope)) return;
  const rel = url.pathname.slice(scope.length);

  if (rel.startsWith('vendor/')) {
    event.respondWith(cacheFirst(req, VENDOR, { ignoreSearch: false }));
    return;
  }
  if (req.mode === 'navigate') {
    // La app es una sola página: siempre index.html (rápido y sin conexión)
    event.respondWith((async () => {
      const shell = await caches.open(SHELL);
      return (await shell.match('index.html')) || fetch(req);
    })());
    return;
  }
  event.respondWith((async () => {
    const shell = await caches.open(SHELL);
    const hit = await shell.match(req, { ignoreSearch: true });
    if (hit) return hit;
    return cacheFirst(req, RUNTIME);
  })());
});
