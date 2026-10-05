// Makes the lead desk installable. Deliberately caches NOTHING: lead data is
// patient information and must never be stored on the device.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
