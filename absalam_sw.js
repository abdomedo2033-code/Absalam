/* Absalam service worker — offline shell + offline-first API behaviour.
 * Deploy: put this file next to index.html, then in the app call
 *   navigator.serviceWorker.register('absalam_sw.js')
 * Bump SHELL_VERSION on every app deploy so users pick up the new build.
 */
'use strict';

var SHELL_VERSION = 'absalam-v1';           /* bump on every deploy */
var SHELL = [ './', './index.html', './sdk.js' ];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(SHELL_VERSION).then(function (c) {
      /* addAll is all-or-nothing; sdk.js may 404, so add individually */
      return Promise.all(SHELL.map(function (u) {
        return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL_VERSION && k.indexOf('absalam-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isApi(url) {
  /* the worker lives on workers.dev; never cache API traffic */
  return /workers\.dev$/.test(url.hostname);
}

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                  /* POSTs go straight to the network */
  var url = new URL(req.url);

  if (isApi(url)) {
    /* network-only, but survive failure with a JSON error the app can queue */
    e.respondWith(fetch(req).catch(function () {
      return new Response(JSON.stringify({ ok: false, offline: true }), {
        status: 503, headers: { 'content-type': 'application/json' }
      });
    }));
    return;
  }

  if (req.mode === 'navigate' || /\.(html|js|css|png|svg|woff2?)$/.test(url.pathname)) {
    /* cache-first shell: opens instantly offline, updates on next visit */
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) {
          fetch(req).then(function (res) {
            if (res && res.ok) caches.open(SHELL_VERSION).then(function (c) { c.put(req, res); });
          }).catch(function () {});
          return hit;
        }
        return fetch(req).then(function (res) {
          if (res && res.ok) {
            var copy = res.clone();
            caches.open(SHELL_VERSION).then(function (c) { c.put(req, copy); });
          }
          return res;
        }).catch(function () {
          return caches.match('./index.html');       /* last resort: the shell */
        });
      })
    );
  }
});

self.addEventListener('message', function (e) {
  if (e.data === 'abs-skip-waiting') self.skipWaiting();
});