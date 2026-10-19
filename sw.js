// Mi Día — service worker: la app abre sin conexión y los datos se piden siempre frescos.
const CACHE = "midia-v22";
const SHELL = ["./", "index.html", "calendar.js", "manifest.json", "pets/zogli.png", "pets/casa.png", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // APIs: red directa
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("index.html")))
  );
});

// Aviso de la mañana: lo envía el puente de Cloudflare ya redactado.
self.addEventListener("push", (e) => {
  let msg = { title: "Mi Día", body: "Toca para ver tu día." };
  try { msg = { ...msg, ...e.data.json() }; } catch {}
  e.waitUntil(self.registration.showNotification(msg.title, {
    body: msg.body,
    icon: "icons/icon-192.png",
    badge: "icons/icon-192.png",
    tag: "mi-dia-manana",
    data: { url: msg.url || "./" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (wins.length) return wins[0].focus();
    return self.clients.openWindow(e.notification.data?.url || "./");
  })());
});
