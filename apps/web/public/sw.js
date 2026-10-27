/* Purchase Guardian service worker: installability, offline fallback, and push approvals. */
const CACHE = "guardian-shell-v1";
const OFFLINE_URL = "/offline.html";

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([OFFLINE_URL, "/pwa-icon/192"])));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network-first for page navigations; never cache API responses (they're per-user and live).
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(fetch(event.request).catch(() => caches.match(OFFLINE_URL)));
});

self.addEventListener("push", (event) => {
  let data = { title: "Purchase Guardian", body: "A purchase needs your attention.", url: "/approvals" };
  try {
    data = { ...data, ...event.data.json() };
  } catch {
    /* plain-text or empty payload */
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/pwa-icon/192",
      badge: "/pwa-icon/192",
      tag: data.tag || data.url,
      renotify: true,
      requireInteraction: true,
      data: { url: data.url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/approvals", self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      const existing = clients.find((c) => c.url.startsWith(self.location.origin));
      if (existing) return existing.navigate(target).then((c) => (c || existing).focus());
      return self.clients.openWindow(target);
    }),
  );
});
