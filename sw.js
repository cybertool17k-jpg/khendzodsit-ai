const CACHE='khendzodsit-ai-v26';
const ASSETS=['./','./index.html','./styles.css','./app.js','./economic-calendar.js','./labor-dashboard.js','./panel-collapse.js','./voice-assistant.js','./chart-scan.js','./chart-scan-worker.js','./manifest.webmanifest','./icon.svg','./logo-wide.png','./icon-192.png','./icon-512.png'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS))));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k))))));
self.addEventListener('fetch',e=>{if(e.request.method!=='GET')return;e.respondWith(caches.match(e.request).then(hit=>hit||fetch(e.request).then(res=>{const copy=res.clone();caches.open(CACHE).then(c=>c.put(e.request,copy));return res;}).catch(()=>caches.match('./index.html'))));});
self.addEventListener('notificationclick',e=>{e.notification.close();e.waitUntil(clients.matchAll({type:'window',includeUncontrolled:true}).then(list=>{for(const client of list){if('focus'in client)return client.focus();}return clients.openWindow('./');}));});
