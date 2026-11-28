/* Absalam service worker v4 - offline shell + cached third-party start-up scripts.
 * Sits next to index.html, registered as 'absalam_sw.js'. Bump VERSION on every deploy.
 * v4 vs v3: the 5 MB page is fetched once at install (v3 fetched it twice) and revalidated with
 * If-None-Match afterwards; the Telegram SDK, Firebase and Google Fonts are cached so the app boots
 * offline with its real Telegram identity; slow third-party scripts are time-boxed; and a failed
 * script/css/font request no longer receives the HTML page as its body.
 */
'use strict';

var VERSION = 'absalam-v4';
var SCOPE = self.registration.scope;
var SHELL_KEY = new URL('index.html', SCOPE).href;
var SHELL_SRC = [SCOPE, SHELL_KEY];
var LIBS = [
  'https://telegram.org/js/telegram-web-app.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-app-compat.js',
  'https://www.gstatic.com/firebasejs/13.4.0/firebase-database-compat.js'
];
var STATIC = /\.(js|css|png|jpe?g|gif|webp|svg|ico|woff2?|webmanifest)$/i;

function wait(p, ms) {                       /* resolves undefined if p fails or takes longer than ms */
  return Promise.race([p.catch(function () {}), new Promise(function (r) { setTimeout(r, ms); })]);
}
function usable(r) { return !!r && (r.ok || r.type === 'opaque'); }
function empty(type) { return new Response('', { status: 200, headers: { 'content-type': type } }); }
function offline() {
  return new Response('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font:16px system-ui;padding:32px;text-align:center"><h2>Offline</h2>' +
    '<p>Open the app once while online so it can be saved for offline use.</p></body>',
    { status: 503, headers: { 'content-type': 'text/html; charset=utf-8' } });
}
function clean(r) {                          /* a redirected response cannot be served to a navigation */
  if (!r.redirected) return Promise.resolve(r);
  return r.blob().then(function (b) { return new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }); });
}
function fetchShell() {                      /* revalidates with the server; unchanged page = cheap 304 */
  var i = 0;
  function next() {
    if (i >= SHELL_SRC.length) return Promise.reject(new Error('shell unavailable'));
    return fetch(SHELL_SRC[i++], { cache: 'no-cache' }).then(function (r) { return r.ok ? clean(r) : next(); }, next);
  }
  return next();
}
function fetchLib(u) {                       /* CORS first (no storage padding), opaque as a fallback */
  return fetch(u, { mode: 'cors', credentials: 'omit' }).catch(function () {
    return fetch(u, { mode: 'no-cors', credentials: 'omit' });
  });
}
function cacheLib(c, u) {
  return fetchLib(u).then(function (r) { return usable(r) ? c.put(u, r) : null; });
}
function refreshShell(c, hit) {
  return fetchShell().then(function (r) {
    var a = hit.headers.get('etag'), b = r.headers.get('etag');
    var la = hit.headers.get('last-modified'), lb = r.headers.get('last-modified');
    if ((a && a === b) || (!a && la && la === lb)) { try { r.body.cancel(); } catch (e) {} return; }
    return c.put(SHELL_KEY, r);
  }).catch(function () {});
}

function navigate(e, url) {
  var isShell = url.pathname === new URL(SCOPE).pathname || /\/index\.html$/.test(url.pathname);
  return caches.open(VERSION).then(function (c) {
    return c.match(SHELL_KEY).then(function (hit) {
      if (isShell && hit) { e.waitUntil(refreshShell(c, hit)); return hit; }       /* cache first, update in background */
      var net = isShell ? fetchShell() : fetch(e.request);
      return net.then(function (r) {
        if (isShell) c.put(SHELL_KEY, r.clone()).catch(function () {});
        return r;
      }).catch(function () { return hit || offline(); });
    });
  }).catch(function () { return fetch(e.request).catch(offline); });
}
function sameOrigin(e) {
  var req = e.request;
  return caches.open(VERSION).then(function (c) {
    return c.match(req).then(function (hit) {
      var net = fetch(req).then(function (r) {
        if (r && r.ok && r.status === 200 && r.type === 'basic') c.put(req, r.clone()).catch(function () {});
        return r;
      });
      if (hit) { e.waitUntil(net.catch(function () {})); return hit; }
      return net.catch(function () { return Response.error(); });
    });
  });
}
function lib(e, refresh, ms, type) {         /* cache first; time-boxed network when nothing is saved yet */
  var u = e.request.url;
  return caches.open(VERSION).then(function (c) {
    return c.match(u, { ignoreVary: true }).then(function (hit) {
      if (hit) {
        if (refresh) e.waitUntil(cacheLib(c, u).catch(function () {}));
        return hit;
      }
      return wait(fetchLib(u).then(function (r) {
        if (usable(r)) c.put(u, r.clone()).catch(function () {});
        return r;
      }), ms).then(function (r) { return r || (type ? empty(type) : Response.error()); });
    });
  });
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(VERSION).then(function (c) {
      var shell = fetchShell().then(function (r) { return c.put(SHELL_KEY, r); });                 /* required */
      var libs = wait(Promise.all(LIBS.map(function (u) { return cacheLib(c, u).catch(function () {}); })), 8000);   /* best effort */
      return Promise.all([shell, libs]);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== VERSION && k.indexOf('absalam-') === 0) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;                  /* POSTs go straight to the network */
  var url = new URL(req.url), host = url.hostname;

  if (/workers\.dev$/.test(host)) {                  /* API: network only, but fail softly so the app can queue */
    e.respondWith(fetch(req).catch(function () {
      return new Response(JSON.stringify({ ok: false, offline: true }), { status: 503, headers: { 'content-type': 'application/json' } });
    }));
    return;
  }
  if (req.mode === 'navigate') { e.respondWith(navigate(e, url)); return; }

  if (url.origin === location.origin) {
    if (/\/sdk\.js$/.test(url.pathname)) return;     /* ad SDK copy: leave to the network */
    if (STATIC.test(url.pathname)) e.respondWith(sameOrigin(e));
    return;
  }
  if (host === 'telegram.org' && url.pathname === '/js/telegram-web-app.js') e.respondWith(lib(e, true, 8000));
  else if (host === 'www.gstatic.com' && url.pathname.indexOf('/firebasejs/') === 0) e.respondWith(lib(e, false, 8000));
  else if (host === 'fonts.googleapis.com') e.respondWith(lib(e, true, 3500, 'text/css'));
  else if (host === 'fonts.gstatic.com') e.respondWith(lib(e, false, 3500));
  else if (host === 'libtl.com') e.respondWith(wait(fetch(req), 4000).then(function (r) { return r || empty('application/javascript'); }));
});

self.addEventListener('message', function (e) {
  if (e.data === 'abs-skip-waiting') self.skipWaiting();
});
