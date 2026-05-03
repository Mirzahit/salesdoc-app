// ВАЖНО: при каждом значимом релизе бампать CACHE_NAME синхронно с <title> в index.html.
// Иначе SW отдаёт пользователям закэшированный старый index.html и новые фичи (страницы, скрипты)
// становятся видны только после ручного Ctrl+Shift+R. См. CLAUDE.md → раздел про SW.
var CACHE_NAME = 'salesdoc-v148';
var PRECACHE = ['/', '/manifest.json', '/icon-192.svg'];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE);
    })
  );
  self.skipWaiting();
});

// Позволяет странице принудительно активировать новую версию SW сразу
self.addEventListener('message', function(e){
  if(e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', function(e) {
  var url = e.request.url;
  // Google API, Apps Script, Telegram — network only, но кэшируем ответы
  if (url.indexOf('googleapis.com') !== -1 || url.indexOf('script.google') !== -1 || url.indexOf('api.telegram') !== -1) {
    e.respondWith(
      fetch(e.request).then(function(resp) {
        var clone = resp.clone();
        caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
        return resp;
      }).catch(function() {
        return caches.match(e.request);
      })
    );
    return;
  }
  // CDN libs (jsPDF etc) — cache first
  if (url.indexOf('cdn.jsdelivr.net') !== -1 || url.indexOf('cdnjs.cloudflare.com') !== -1 || url.indexOf('unpkg.com') !== -1) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(resp) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
          return resp;
        });
      })
    );
    return;
  }
  // Google Fonts — cache first
  if (url.indexOf('fonts.googleapis.com') !== -1 || url.indexOf('fonts.gstatic.com') !== -1) {
    e.respondWith(
      caches.match(e.request).then(function(cached) {
        return cached || fetch(e.request).then(function(resp) {
          var clone = resp.clone();
          caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
          return resp;
        });
      })
    );
    return;
  }
  // App files — network first, fallback to cache
  e.respondWith(
    fetch(e.request).then(function(resp) {
      var clone = resp.clone();
      caches.open(CACHE_NAME).then(function(cache) { cache.put(e.request, clone); });
      return resp;
    }).catch(function() {
      return caches.match(e.request);
    })
  );
});
