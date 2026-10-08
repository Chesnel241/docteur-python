/* Docteur Python : service worker (mode hors ligne) */
const VERSION = "dp-928a26f9fe";
const CORE = ["/", "/py-worker.js", "/favicon.svg", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];
const PY = ["/pyodide/pyodide.js", "/pyodide/pyodide.asm.js", "/pyodide/pyodide.asm.wasm", "/pyodide/python_stdlib.wasm", "/pyodide/pyodide-lock.json"];
const PY_CACHE = "dp-pyodide-0.27.8";
const FONT_CACHE = "dp-fonts";

self.addEventListener("install", (e) => {
  e.waitUntil(Promise.all([
    caches.open(VERSION).then((c) => c.addAll(CORE)),
    caches.open(PY_CACHE).then((c) => c.addAll(PY))
  ]).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => ![VERSION, PY_CACHE, FONT_CACHE].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

async function cacheFirst(req, name) {
  const hit = await caches.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) (await caches.open(name)).put(req, res.clone());
  return res;
}
async function staleWhileRevalidate(req, name) {
  const cache = await caches.open(name);
  const hit = await cache.match(req);
  const net = fetch(req).then((res) => { if (res.ok || res.type === "opaque") cache.put(req, res.clone()); return res; }).catch(() => hit);
  return hit || net;
}
async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) (await caches.open(VERSION)).put("/", res.clone());
    return res;
  } catch (e) {
    return (await caches.match("/")) || Response.error();
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith("/pyodide/")) e.respondWith(cacheFirst(req, PY_CACHE));
    else if (req.mode === "navigate") e.respondWith(networkFirst(req));
    else e.respondWith(staleWhileRevalidate(req, VERSION));
  } else if (url.hostname === "fonts.googleapis.com" || url.hostname === "fonts.gstatic.com") {
    e.respondWith(staleWhileRevalidate(req, FONT_CACHE));
  }
});
