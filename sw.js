// Keeps the app's own files on the phone so it opens with no signal. Data always goes to Supabase directly.
const CACHE = "caivan-dl-v2";
const SHELL = ["./", "index.html", "app.js", "logic.js", "config.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png",
  "lib/supabase.js", "lib/591.supabase.js", "lib/xlsx.full.min.js", "lib/jspdf.umd.min.js", "lib/exifr.umd.js"];

self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Same-site files: serve from the phone instantly, refresh in the background. Everything else: straight to the network.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const hit = await c.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
