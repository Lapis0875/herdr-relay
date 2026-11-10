/**
 * herdr-relay service worker (scope `/herdr-relay/`), plain JS served from packages/web.
 *
 * - Offline shell: the page, app.js and app.css are fetched from the network first and kept for offline starts
 *   (the app then shows its IndexedDB cache marked stale); fonts and icons are cache-first. A navigation's answer is
 *   kept as the page only when it is one: 200, same-origin, not redirected, `text/html`; any other answer (a script,
 *   an error page, a redirect) passes through uncached, so it can never replace the offline page.
 * - Never touched: `api/`, `ws`, `push/`, `assets/` (authenticated, live) and anything outside the scope.
 * - Web Push (D11): the bridge's payload `{title, body, tag, url, terminal, kind}` becomes a notification (a payload
 *   that is not JSON still shows one, with its text as the body: iOS and Chrome expect one for every push); tapping it
 *   focuses an open app page (which focuses the terminal) or opens `url` (`./?terminal=<address>`) in the scope.
 */

const VERSION = "2";
const SHELL_CACHE = `herdr-relay-shell-${VERSION}`;
const STATIC_CACHE = "herdr-relay-static-1";
const SHELL_FILES = ["./", "app.js", "app.css", "manifest.webmanifest", "icons/icon-192.png"];
const LIVE = /^(api\/|ws$|push\/|assets\/|dev\/)/;
const STATIC = /^(fonts|icons)\//;

const scope = new URL(self.registration.scope);
const rel = (
  url,
) => (url.origin === scope.origin && url.pathname.startsWith(scope.pathname)
  ? url.pathname.slice(scope.pathname.length)
  : null);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    await cache.addAll(SHELL_FILES.map((f) => new Request(new URL(f, scope), { cache: "reload" })));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith("herdr-relay-shell-") && key !== SHELL_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

/** A navigation answer that may stand in for the page offline: the bridge's own HTML page, as served. */
function isPage(res) {
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  return res.status === 200 && res.type === "basic" && !res.redirected && type === "text/html";
}

async function networkFirst(request, cacheKey, keep = (res) => res.ok) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const res = await fetch(request);
    if (keep(res)) await cache.put(cacheKey, res.clone());
    return res;
  } catch (e) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
    throw e;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (res.ok) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  const path = rel(url);
  if (path === null || LIVE.test(path)) return;
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, new URL("./", scope).href, isPage));
    return;
  }
  if (STATIC.test(path)) {
    event.respondWith(cacheFirst(req));
    return;
  }
  if (SHELL_FILES.includes(path)) event.respondWith(networkFirst(req, new URL(path, scope).href));
});

const text = (v) => (typeof v === "string" ? v : "");

self.addEventListener("push", (event) => {
  let data = {};
  if (event.data) {
    try {
      const parsed = event.data.json();
      if (parsed && typeof parsed === "object") data = parsed;
    } catch {
      data = { body: event.data.text() };
    }
  }
  // `renotify` needs a non-empty tag.
  const tag = text(data.tag) || undefined;
  const options = {
    body: text(data.body),
    tag,
    renotify: tag !== undefined,
    icon: new URL("icons/icon-192.png", scope).href,
    badge: new URL("icons/badge-96.png", scope).href,
    data: { url: text(data.url) || "./", terminal: text(data.terminal) || null },
  };
  event.waitUntil(self.registration.showNotification(text(data.title) || "herdr-relay", options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  let target = new URL(text(data.url) || "./", scope);
  if (rel(target) === null) target = new URL("./", scope);
  const terminal = text(data.terminal) || null;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    // The app's own page, not a dev page under the scope.
    const open = windows.find((c) => {
      const path = rel(new URL(c.url));
      return path !== null && !path.startsWith("dev/");
    });
    if (open) {
      try {
        await open.focus();
        open.postMessage({ type: "open", url: target.href, terminal });
        return;
      } catch {
        // The window could not be brought forward: open the app instead.
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
