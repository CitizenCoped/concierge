/* Angel Concierge service worker: Web Push display + notification deep links. */

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: "Angel Concierge", message: event.data?.text() || "" };
  }
  const title = data.title || "Angel Concierge";
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.message || "",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: data.event || "angel-concierge",
      data: { url: data.url || "/" },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((windows) => {
        for (const win of windows) {
          if ("focus" in win) {
            win.navigate(url);
            return win.focus();
          }
        }
        return self.clients.openWindow(url);
      })
  );
});
