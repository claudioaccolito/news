// Edicola service worker: app shell offline, news always fresh when online.
// Only one copy of the news is kept: every refresh overwrites the previous one.

const VERSION = '__VERSION__';
const SHELL = `edicola-shell-${VERSION}`;
const DATA = 'edicola-data';

const SHELL_FILES = [
	'./',
	'index.html',
	'css/app.css',
	'js/app.js',
	'js/ai.js',
	'js/store.js',
	'js/feed-parser.js',
	'manifest.webmanifest',
	'icons/icon.svg',
	'icons/icon-192.png'
];

self.addEventListener('install', (e) => {
	e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
	e.waitUntil((async () => {
		for (const k of await caches.keys()) if (k !== SHELL && k !== DATA) await caches.delete(k);
		await self.clients.claim();
	})());
});

self.addEventListener('fetch', (e) => {
	const req = e.request;
	const url = new URL(req.url);
	if (req.method !== 'GET' || url.origin !== location.origin) return;

	if (url.pathname.includes('/data/')) {
		// Network first, fall back to the last copy for offline reading.
		e.respondWith((async () => {
			const cache = await caches.open(DATA);
			const key = url.origin + url.pathname; // ignore query strings: one copy per file
			try {
				const res = await fetch(req);
				if (res.ok) await cache.put(key, res.clone());
				return res;
			} catch {
				return (await cache.match(key)) || Response.error();
			}
		})());
		return;
	}

	// App shell: cache first, refreshed in the background.
	e.respondWith((async () => {
		const cache = await caches.open(SHELL);
		const cached = await cache.match(req, { ignoreSearch: true }) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
		const network = fetch(req).then((res) => {
			if (res.ok && res.type === 'basic') cache.put(req, res.clone());
			return res;
		}).catch(() => null);
		return cached || (await network) || Response.error();
	})());
});
