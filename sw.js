/* بداية التخزين المؤقت لنسخة PWA */
const CACHE = "invoice-program-v20260914f";
const ASSETS = [
  "./", "./index.html", "./style.css", "./central-config.js", "./app.js?rev=20260914f",
  "./search-worker.js", "./manifest.json", "./logo.png",
  "./fonts/cairo-400.ttf", "./fonts/cairo-600.ttf", "./fonts/cairo-700.ttf", "./fonts/cairo-800.ttf",
  "./vendor/zxing-browser.min.js", "./vendor/jsQR.js", "./vendor/mdb-reader.min.js", "./vendor/xlsx.full.min.js",
  "./Database/products.json", "./Database/customers.json", "./Database/customer_history.json", "./Database/users.json"
];
self.addEventListener("install", (event) => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(ASSETS.map(async (asset) => {
    try { const response = await fetch(asset, { cache: "no-cache" }); if (response.ok) await cache.put(asset, response); } catch (error) {}
  }));
  await self.skipWaiting();
})()));
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name.startsWith("invoice-program-") && name !== CACHE).map((name) => caches.delete(name)));
  await self.clients.claim();
})()));
self.addEventListener("message", (event) => { if (event.data?.type === "SKIP_WAITING") self.skipWaiting(); });
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith((async () => {
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response?.ok && new URL(event.request.url).origin === self.location.origin) {
        const cache = await caches.open(CACHE); await cache.put(event.request, response.clone());
      }
      return response;
    } catch (error) {
      if (event.request.mode === "navigate") return caches.match("./index.html");
      return new Response("", { status: 503, statusText: "Offline" });
    }
  })());
});
/* نهاية التخزين المؤقت لنسخة PWA */
