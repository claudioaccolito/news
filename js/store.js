// Everything the app remembers lives here, on this device only (localStorage).
// Small self-cleaning caches: nothing older than a few days is kept.

const KEY = 'edicola:v1';
const KEEP_MS = 4 * 24 * 3600e3;

const DEFAULTS = {
	onboarded: false,
	sel: [],          // selected catalog source ids
	custom: [],       // [{ id, name, url, cat }]
	theme: 'auto',
	size: 'm',
	proxy: '',        // optional CORS proxy prefix for custom feeds (off by default)
	ai: {
		provider: 'none', // 'none' | 'openai' | 'anthropic'
		preset: '',
		base: '',
		model: '',
		key: '',
		auto: false,      // generate TL;DR automatically when opening an article
		maxItems: 60      // news items sent for the daily recap
	}
};

function read(key, fallback) {
	try {
		const v = localStorage.getItem(key);
		return v ? JSON.parse(v) : fallback;
	} catch {
		return fallback;
	}
}

function write(key, value) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
		return true;
	} catch {
		return false;
	}
}

export const settings = (() => {
	const s = read(KEY, {});
	return { ...DEFAULTS, ...s, ai: { ...DEFAULTS.ai, ...(s.ai || {}) } };
})();

export function save() {
	write(KEY, settings);
}

export function resetAll() {
	try {
		for (const k of Object.keys(localStorage)) if (k.startsWith('edicola:')) localStorage.removeItem(k);
	} catch {}
}

export function exportSettings() {
	const { ai, ...rest } = settings;
	// Never export the API key.
	return { ...rest, ai: { ...ai, key: '' }, exported: new Date().toISOString() };
}

export function importSettings(obj) {
	if (!obj || typeof obj !== 'object' || !Array.isArray(obj.sel)) throw new Error('File non valido');
	const key = settings.ai.key;
	Object.assign(settings, DEFAULTS, obj, { ai: { ...DEFAULTS.ai, ...(obj.ai || {}), key: obj.ai?.key || key } });
	delete settings.exported;
	settings.onboarded = true;
	save();
}

// A tiny map persisted to localStorage with automatic expiry.
function expiring(name) {
	const key = `edicola:${name}`;
	let map = read(key, {});
	const now = Date.now();
	let dirty = false;
	for (const [k, v] of Object.entries(map)) {
		if (!v || now - (v.ts || 0) > KEEP_MS) { delete map[k]; dirty = true; }
	}
	if (dirty) write(key, map);
	return {
		get: (k) => map[k]?.v,
		has: (k) => k in map,
		set(k, v) {
			map[k] = { v, ts: Date.now() };
			if (!write(key, map)) {
				// Storage full: drop the oldest half and retry.
				const entries = Object.entries(map).sort((a, b) => a[1].ts - b[1].ts);
				map = Object.fromEntries(entries.slice(Math.floor(entries.length / 2)));
				write(key, map);
			}
		},
		del(k) { delete map[k]; write(key, map); }
	};
}

export const readState = expiring('read');   // id -> 1
export const tldrCache = expiring('tldr');   // id -> text
export const recapCache = expiring('recap'); // day+filter -> text
