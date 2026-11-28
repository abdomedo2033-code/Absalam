/* Absalam service worker — offline shell (v3).
 * Put this file next to index.html and register it as 'absalam_sw.js'.
 * Bump SHELL_VERSION on every deploy so clients pick up the new build.
 */
'use strict';

var SHELL_VERSION = 'absalam-v3';
var SHELL = ['./', './index.html'];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_VERSION).then(function (c) {
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      /* drop older absalam shells, but never the one we just built */
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_VERSION && k.indexOf('absalam-') === 0) {
          return caches.delete(k).catch(function () {});
        }
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isApi(url) {
  return /workers\.dev$/.test(url.hostname);
}

/* the app shell, whatever URL the user opened it with (query strings, filenames) */
function shellFromCache() {
  return caches.open(SHELL_VERSION).then(function (c) {
    return c.match('./index.html', { ignoreSearch: true })
      .then(function (r) { return r || c.match('./', { ignoreSearch: true }); })
      .then(function (r) {
        if (r) return r;
        return c.keys().then(function (list) {
          for (var i = 0; i < list.length; i++) {
            if (/\.html$/.test(list[i].url) || /\/$/.test(list[i].url)) return c.match(list[i]);
          }
          return null;
        });
      });
  });
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                  /* POSTs go straight to the network */
  var url = new URL(req.url);

  if (isApi(url)) {
    /* network-only, but fail softly with JSON the app can queue */
    e.respondWith(fetch(req).catch(function () {
      return new Response(JSON.stringify({ ok: false, offline: true }), {
        status: 503, headers: { 'content-type': 'application/json' }
      });
    }));
    return;
  }

  /* ---- app shell: serve from cache first, refresh in the background ---- */
  if (req.mode === 'navigate' || /\.(html|js|css|png|svg|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req, { ignoreSearch: true }).then(function (hit) {
        if (hit) {
          fetch(req).then(function (res) {
            if (res && res.ok) {
              caches.open(SHELL_VERSION).then(function (c) { c.put(req, res.clone()); }).catch(function () {});
            }
          }).catch(function () {});
          return hit;
        }
        return fetch(req).then(function (res) {
          if (res && res.ok && res.type !== 'opaque') {
            var copy = res.clone();
            caches.open(SHELL_VERSION).then(function (c) { c.put(req, copy); }).catch(function () {});
          }
          return res;
        }).catch(function () {
          return shellFromCache().then(function (r) {
            return r || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
          });
        });
      }).catch(function () {
        return shellFromCache().then(function (r) {
          return r || new Response('Offline', { status: 503, headers: { 'content-type': 'text/plain' } });
        });
      })
    );
  }
});

self.addEventListener('message', function (e) {
  if (e.data === 'abs-skip-waiting') self.skipWaiting();
});