// Moinho Raios — service worker: mostra as notificações de mensagens e abre a conversa ao tocar.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  const conv = (e.notification.data && e.notification.data.conv) || "geral";
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(lista => {
    for (const c of lista) { c.postMessage({ abrirConversa: conv }); return c.focus(); }
    return self.clients.openWindow("/#chat");
  }));
});
