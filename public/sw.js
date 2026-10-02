self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

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
