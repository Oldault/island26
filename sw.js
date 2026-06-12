/* ════════ ÍSLAND '26 — service worker ════════
   Le site entier (données, Leaflet, polices, tuiles déjà vues) survit
   aux coupures réseau. Stratégies :
   - page (navigation)        → réseau d'abord (timeout 3,5 s), sinon cache
   - leaflet / fonts / CDN    → cache d'abord (versionné, immuable)
   - tuiles carto             → cache d'abord, plafond ~600 tuiles
   ⚠ Bump VERSION à chaque modif de index.html ou de ce fichier
     (purge le cache statique ; les tuiles déjà vues survivent). */
'use strict';

const VERSION = 'v2';
const STATIC_CACHE = 'isl26-static-' + VERSION;
const TILE_CACHE = 'isl26-tiles-keep';
const TILE_LIMIT = 600;
const NAV_TIMEOUT_MS = 3500;

const SHELL = ['./', './index.html'];
const CDN = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://fonts.googleapis.com/css2?family=Unbounded:wght@600;800&family=Schibsted+Grotesk:ital,wght@0,400;0,500;0,700;1,400&family=Fragment+Mono:ital@0;1&display=swap',
];
const STATIC_HOSTS = ['unpkg.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    await cache.addAll(SHELL);
    /* CDN en mode CORS explicite : réponses non-opaques → compatibles SRI,
       pas de gonflement de quota. Best-effort : le runtime complètera. */
    await Promise.allSettled(CDN.map(async url => {
      const res = await fetch(url, { mode: 'cors' });
      if (res.ok) await cache.put(url, res);
    }));
    /* Les .woff2 référencés par la feuille Google Fonts */
    try {
      const cssRes = await cache.match(CDN[2], { ignoreVary: true });
      if (cssRes) {
        const css = await cssRes.text();
        const fontUrls = [...new Set(css.match(/https:\/\/fonts\.gstatic\.com\/[^()\s'"]+/g) || [])];
        await Promise.allSettled(fontUrls.map(async u => {
          const r = await fetch(u, { mode: 'cors' });
          if (r.ok) await cache.put(u, r);
        }));
      }
    } catch (err) { /* best-effort */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keep = [STATIC_CACHE, TILE_CACHE];
    for (const k of await caches.keys()) {
      if (k.startsWith('isl26-') && !keep.includes(k)) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') { e.respondWith(pageStrategy(req)); return; }
  if (url.hostname.endsWith('basemaps.cartocdn.com')) { e.respondWith(tileStrategy(req, e)); return; }
  if (STATIC_HOSTS.includes(url.hostname) || url.origin === self.location.origin) {
    e.respondWith(staticStrategy(req, url));
  }
  /* tout le reste (liens externes…) : réseau normal */
});

/* navigation : réseau d'abord avec timeout, cache en secours */
async function pageStrategy(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetchWithTimeout(req, NAV_TIMEOUT_MS);
    if (res && res.ok) {
      try { await cache.put('./index.html', res.clone()); } catch (err) { /* quota… */ }
      return res;
    }
    throw new Error('réponse non-ok : ' + (res && res.status));
  } catch (err) {
    const hit = await cache.match('./index.html', { ignoreVary: true })
      || await cache.match('./', { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

/* assets versionnés : cache d'abord.
   La feuille Google Fonts est demandée par la page en no-cors (réponse
   opaque, non-cacheable) → on la re-fetch en CORS pour pouvoir la stocker
   si le precache l'avait ratée. */
async function staticStrategy(req, url) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = (url && url.hostname === 'fonts.googleapis.com')
    ? await fetch(req.url, { mode: 'cors' })
    : await fetch(req);
  if (res && res.ok) {
    try { await cache.put(req, res.clone()); } catch (err) { /* quota… */ }
  }
  return res;
}

/* tuiles : cache d'abord + plafond FIFO */
async function tileStrategy(req, evt) {
  const cache = await caches.open(TILE_CACHE);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) {
    try {
      await cache.put(req, res.clone());
      evt.waitUntil(trimTiles(cache));
    } catch (err) { /* quota… */ }
  }
  return res;
}

let trimming = false;
async function trimTiles(cache) {
  if (trimming) return;
  trimming = true;
  try {
    const keys = await cache.keys();
    const excess = keys.length - TILE_LIMIT;
    for (let i = 0; i < excess; i++) await cache.delete(keys[i]);
  } catch (err) { /* best-effort */ } finally { trimming = false; }
}

/* fetch(reqNavigation, {signal}) est interdit dans certains moteurs →
   timeout par Promise.race, sans AbortController */
function fetchWithTimeout(req, ms) {
  return Promise.race([
    fetch(req),
    new Promise((_, rej) => setTimeout(() => rej(new Error('timeout réseau')), ms)),
  ]);
}
