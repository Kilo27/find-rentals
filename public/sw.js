const SHELL = "rw-shell-v1";
const SHELL_FILES = ["/", "/app.js", "/app-model.js", "/ui.js", "/map.js", "/map-model.js", "/setup.js", "/styles.css", "/manifest.webmanifest", "/icons/icon-192.png"];
const SHELL_PATHS = new Set(SHELL_FILES);

self.addEventListener("install", (event) => {
  self.skipWaiting();
  // The app's own files, so the Home Screen app still opens (on the last list it saw) with no connection. A file that
  // can't be fetched now is simply not kept; it is never a reason to fail the install.
  event.waitUntil(caches.open(SHELL).then((cache) => Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => {})))));
});
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== SHELL) await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);

// The app's own files come from the network first, as they always have (a deploy shows at once), and the copy kept here
// only answers when the network can't. The page itself is kept under "/" whatever address it was opened at, so a sign-in
// link in the address is never stored. Everything else (the API, the map tiles, other sites) isn't touched.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const page = req.mode === "navigate";
  if (!page && !SHELL_PATHS.has(url.pathname)) return;
  const key = page ? "/" : url.pathname;
  event.respondWith(
    (async () => {
      try {
        const res = await fetch(req);
        if (res.ok && (!page || url.search === "")) {
          const copy = res.clone();
          event.waitUntil(caches.open(SHELL).then((cache) => cache.put(key, copy)).catch(() => {}));
        }
        return res;
      } catch (err) {
        const kept = await caches.match(key);
        if (kept) return kept;
        throw err;
      }
    })(),
  );
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  event.waitUntil(
    self.registration.showNotification(data.title || "Rental alert", {
      body: data.body || "",
      icon: "/icons/icon-192.png",
      tag: data.tag || undefined,
      data: { url: data.url || "/" },
    }),
  );
});

// A tap on an alert opens the app on that listing. If the app is already open, it is brought forward and told which
// listing to show, so nothing reloads. An address on another site (alerts sent before this behaviour) opens as before.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || "/", self.registration.scope);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === target.origin);
      if (open && "focus" in open) {
        await open.focus();
        const listing = target.searchParams.get("listing");
        if (listing) open.postMessage({ type: "open-listing", listing });
        return;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
