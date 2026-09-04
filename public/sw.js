/* ============================================================================
   sw.js — the offline shell.

   What has to be true: Conor opens the app at a barn with no signal and it works.
   That means the shell, the fonts, the client library and all 3.2 MB of catalog
   are on the phone before he gets there — precached on the first visit that has
   signal, and served from cache forever after.

   What must NOT be cached: anything going to Supabase. Sync is the outbox's job.
   A cached POST response or a stale row read would be a lie about what the team
   has marked, which is worse than an honest offline state.
   ========================================================================== */

var VERSION = 'salebook-v1';
var SHELL = [
  './',
  'index.html',
  'app.css',
  'app.js',
  'store.js',
  'auth.js',
  'config.js',
  'vendor/supabase.js',
  'manifest.webmanifest',
  'data/catalog.v1.json',
  'fonts/ibm-plex-sans-latin-400-normal.woff2',
  'fonts/ibm-plex-sans-latin-500-normal.woff2',
  'fonts/ibm-plex-sans-latin-600-normal.woff2',
  'fonts/ibm-plex-sans-latin-700-normal.woff2',
  'fonts/ibm-plex-mono-latin-500-normal.woff2',
  'fonts/ibm-plex-mono-latin-600-normal.woff2',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

self.addEventListener('install', function(e){
  e.waitUntil(
    caches.open(VERSION)
      .then(function(c){ return c.addAll(SHELL); })
      .then(function(){ return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e){
  e.waitUntil(
    caches.keys().then(function(keys){
      return Promise.all(keys.filter(function(k){ return k !== VERSION; })
                            .map(function(k){ return caches.delete(k); }));
    }).then(function(){ return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e){
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // Supabase and anything else: untouched

  // Every route renders the same shell; the app reads the hash itself.
  if (req.mode === 'navigate'){
    e.respondWith(
      caches.match('index.html').then(function(hit){
        return hit || fetch(req);
      })
    );
    return;
  }

  // Cache-first: these assets are versioned by filename, so a hit is always correct.
  e.respondWith(
    caches.match(req).then(function(hit){
      if (hit) return hit;
      return fetch(req).then(function(res){
        if (res && res.ok && res.type === 'basic'){
          var copy = res.clone();
          caches.open(VERSION).then(function(c){ c.put(req, copy); });
        }
        return res;
      });
    })
  );
});
