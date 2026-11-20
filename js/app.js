import { settings, save, readState, tldrCache, recapCache, resetAll, exportSettings, importSettings } from './store.js';
import * as AI from './ai.js';
import * as WebLLM from './webllm.js';
import { parseFeed, truncate } from './feed-parser.js';

const view = document.getElementById('view');
const PAGE = 80;

const state = {
	catalog: null,
	sources: new Map(),   // id -> source (catalog + custom)
	cats: new Map(),      // id -> category
	news: null,           // { at, status, items }
	custom: [],           // items from custom feeds
	customStatus: {},     // id -> 'ok' | error
	content: new Map(),   // id -> long text (custom feeds)
	shards: new Map(),    // shard -> Promise<object>
	loadedAt: 0,
	filter: { cat: '', src: '', q: '' },
	limit: PAGE,
	listScroll: 0,
	cameFromList: false,
	aiCtrl: null
};

/* ---------- Helpers ---------- */

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const $ = (sel, root = view) => root.querySelector(sel);
const $$ = (sel, root = view) => [...root.querySelectorAll(sel)];

function hash(str) {
	let h = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
	return (h >>> 0).toString(16).padStart(8, '0');
}

const dayStart = (t) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const fmtTime = (t) => new Date(t).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

function fmtShort(t) {
	const today = dayStart(Date.now());
	const d = dayStart(t);
	const time = fmtTime(t);
	if (d === today) return `oggi ${time}`;
	if (d === today - 864e5) return `ieri ${time}`;
	return `${new Date(t).toLocaleDateString('it-IT', { day: 'numeric', month: 'short' })} ${time}`;
}

function fmtDay(t) {
	const today = dayStart(Date.now());
	const d = dayStart(t);
	if (d === today) return 'Oggi';
	if (d === today - 864e5) return 'Ieri';
	return new Date(t).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
}

const fmtLong = (t) => new Date(t).toLocaleString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function toast(msg) {
	document.querySelector('.toast')?.remove();
	const el = document.createElement('div');
	el.className = 'toast';
	el.setAttribute('role', 'status');
	el.textContent = msg;
	document.body.append(el);
	setTimeout(() => el.remove(), 2600);
}

function highlight(text, terms) {
	let out = esc(text);
	if (!terms.length) return out;
	// Accent-insensitive highlight on the escaped string.
	const n = norm(out);
	const marks = [];
	for (const t of terms) {
		let i = 0;
		while ((i = n.indexOf(t, i)) >= 0) { marks.push([i, i + t.length]); i += t.length; }
	}
	if (!marks.length) return out;
	marks.sort((a, b) => a[0] - b[0]);
	let res = '', pos = 0;
	for (const [a, b] of marks) {
		if (a < pos) continue;
		// Avoid breaking HTML entities.
		const before = out.slice(pos, a);
		if (/&[a-z#0-9]*$/i.test(before)) continue;
		res += before + '<mark>' + out.slice(a, b) + '</mark>';
		pos = b;
	}
	return res + out.slice(pos);
}

/* ---------- Look ---------- */

function applyLook() {
	const root = document.documentElement;
	root.dataset.style = settings.style || 'notte';
	if (settings.theme === 'auto') delete root.dataset.theme;
	else root.dataset.theme = settings.theme;
	// Browser chrome follows the page background.
	requestAnimationFrame(() => {
		const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
		document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
	});
}

applyLook();
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyLook);

/* ---------- Data ---------- */

async function loadCatalog() {
	const res = await fetch('data/catalog.json');
	state.catalog = await res.json();
	state.cats = new Map(state.catalog.categories.map((c) => [c.id, c]));
	indexSources();
}

function indexSources() {
	state.sources = new Map(state.catalog.sources.map((s) => [s.id, s]));
	for (const c of settings.custom) state.sources.set(c.id, { ...c, custom: true });
}

async function loadNews(force = false) {
	try {
		const res = await fetch('data/news.json', { cache: force ? 'reload' : 'no-cache' });
		if (!res.ok) throw new Error(res.status);
		state.news = await res.json();
		state.loadedAt = Date.now();
	} catch {
		if (!state.news) state.news = { at: 0, status: {}, items: [], offline: true };
	}
	await loadCustom();
}

function proxied(url) {
	const p = settings.proxy.trim();
	if (!p) return null;
	return p.includes('{url}') ? p.replace('{url}', encodeURIComponent(url)) : p + encodeURIComponent(url);
}

export async function fetchFeedText(url) {
	const attempts = [url, proxied(url)].filter(Boolean);
	let lastErr;
	for (const u of attempts) {
		try {
			const ctrl = new AbortController();
			const timer = setTimeout(() => ctrl.abort(), 15000);
			const res = await fetch(u, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
			clearTimeout(timer);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			return await res.text();
		} catch (e) {
			lastErr = e;
		}
	}
	throw new Error(settings.proxy
		? `non raggiungibile (${lastErr?.message || 'errore'})`
		: 'il sito non permette la lettura diretta dal browser (CORS)');
}

async function loadCustom() {
	const selected = settings.custom.filter((c) => settings.sel.includes(c.id));
	const cutoff = Date.now() - 72 * 3600e3;
	const results = await Promise.all(selected.map(async (src) => {
		try {
			const feed = parseFeed(await fetchFeedText(src.url));
			state.customStatus[src.id] = 'ok';
			return feed.items.filter((it) => it.date && it.date > cutoff).slice(0, 40).map((it) => {
				const id = 'c' + hash(it.link);
				const summary = it.summary && it.summary !== it.title ? it.summary : it.content;
				const long = it.content.length > summary.length ? it.content : summary;
				const d = truncate(summary.replace(/\s*\n+\s*/g, ' '), 280);
				if (long.length > d.length + 40) state.content.set(id, long);
				return { id, s: src.id, t: it.title, d, u: it.link, p: Math.min(it.date, Date.now()), a: it.author, c: long.length > d.length + 40 ? 1 : 0 };
			});
		} catch (e) {
			state.customStatus[src.id] = e.message;
			return [];
		}
	}));
	state.custom = results.flat();
}

function allItems() {
	const items = state.news?.items || [];
	return state.custom.length ? [...items, ...state.custom].sort((a, b) => b.p - a.p) : items;
}

function selectedItems() {
	const sel = new Set(settings.sel);
	const seen = new Set();
	const out = [];
	for (const it of allItems()) {
		if (!sel.has(it.s) || seen.has(it.id)) continue;
		seen.add(it.id);
		out.push(it);
	}
	return out;
}

function terms() {
	return norm(state.filter.q).split(/\s+/).filter((t) => t.length > 1);
}

function filteredItems() {
	const { cat, src } = state.filter;
	const ts = terms();
	return selectedItems().filter((it) => {
		const s = state.sources.get(it.s);
		if (!s) return false;
		if (src && it.s !== src) return false;
		if (cat && s.cat !== cat) return false;
		if (ts.length) {
			const hay = norm(`${it.t} ${it.d || ''} ${s.name}`);
			return ts.every((t) => hay.includes(t));
		}
		return true;
	});
}

async function longText(item) {
	if (state.content.has(item.id)) return state.content.get(item.id);
	if (!item.c || item.id[0] === 'c') return '';
	const shard = item.id[0];
	if (!state.shards.has(shard)) {
		state.shards.set(shard, fetch(`data/content/${shard}.json`).then((r) => r.json()).catch(() => {
			state.shards.delete(shard);
			return {};
		}));
	}
	return (await state.shards.get(shard))[item.id] || '';
}

/* ---------- Views ---------- */

function setNav(route) {
	for (const a of document.querySelectorAll('.bar-nav a')) {
		a.toggleAttribute('aria-current', a.getAttribute('href') === `#${route}`);
		if (a.hasAttribute('aria-current')) a.setAttribute('aria-current', 'page');
	}
	document.querySelector('.nav-ai').hidden = !AI.isEnabled(settings.ai);
}

function renderList() {
	const usedCats = new Set(settings.sel.map((id) => state.sources.get(id)?.cat).filter(Boolean));
	const cats = state.catalog.categories.filter((c) => usedCats.has(c.id));
	if (state.filter.cat && !usedCats.has(state.filter.cat)) state.filter.cat = '';
	const srcs = settings.sel.map((id) => state.sources.get(id)).filter((s) => s && (!state.filter.cat || s.cat === state.filter.cat))
		.sort((a, b) => a.name.localeCompare(b.name, 'it'));
	if (state.filter.src && !srcs.some((s) => s.id === state.filter.src)) state.filter.src = '';

	const at = state.news?.at;
	// Per-category counts for the desktop sidebar (ignoring the category filter itself).
	const counts = new Map();
	const all = selectedItems();
	for (const it of all) {
		const c = state.sources.get(it.s)?.cat;
		counts.set(c, (counts.get(c) || 0) + 1);
	}
	view.innerHTML = `
		<div class="layout">
		<aside class="side" aria-label="Argomenti">
			<p class="side-h">Argomenti</p>
			<button class="side-link" data-cat="" aria-pressed="${!state.filter.cat}"><span>Tutte</span><span class="n">${all.length}</span></button>
			${cats.map((c) => `<button class="side-link" data-cat="${c.id}" aria-pressed="${state.filter.cat === c.id}"><span>${esc(c.name)}</span><span class="n">${counts.get(c.id) || 0}</span></button>`).join('')}
			<a class="side-more" href="#/fonti">Gestisci le fonti →</a>
			<p class="side-h">Tastiera</p>
			<dl class="keys">
				<dt><kbd>/</kbd></dt><dd>cerca</dd>
				<dt><kbd>j</kbd> <kbd>k</kbd></dt><dd>notizia successiva / precedente</dd>
				<dt><kbd>Invio</kbd></dt><dd>apri</dd>
				<dt><kbd>o</kbd></dt><dd>apri la fonte</dd>
				<dt><kbd>Esc</kbd></dt><dd>torna indietro</dd>
			</dl>
		</aside>
		<div class="main">
		<p class="dateline">${esc(new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }))} · ${settings.sel.length} fonti</p>
		<div class="tools">
			<label class="search">
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.5 15.5 20 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
				<input type="search" id="q" placeholder="Cerca nelle notizie" autocomplete="off" value="${esc(state.filter.q)}" aria-label="Cerca nelle notizie">
			</label>
			${cats.length > 1 ? `<div class="chips" role="toolbar" aria-label="Categorie">
				<button class="chip" data-cat="" aria-pressed="${!state.filter.cat}">Tutte</button>
				${cats.map((c) => `<button class="chip" data-cat="${c.id}" aria-pressed="${state.filter.cat === c.id}">${esc(c.name)}</button>`).join('')}
			</div>` : ''}
			<div class="subtools">
				<select class="select" id="src" aria-label="Fonte">
					<option value="">Tutte le fonti</option>
					${srcs.map((s) => `<option value="${s.id}" ${state.filter.src === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
				</select>
				<span>${at ? `Aggiornato ${fmtShort(at)}` : state.news?.offline ? 'Offline' : ''} · <button class="linkbtn" id="refresh">aggiorna</button></span>
			</div>
		</div>
		<div id="items"></div>
		</div>
		</div>`;

	renderItems();

	let t;
	$('#q').addEventListener('input', (e) => {
		clearTimeout(t);
		t = setTimeout(() => { state.filter.q = e.target.value; state.limit = PAGE; renderItems(); }, 120);
	});
	for (const chip of $$('[data-cat]')) {
		chip.addEventListener('click', () => {
			state.filter.cat = chip.dataset.cat;
			state.filter.src = '';
			state.limit = PAGE;
			const y = window.scrollY;
			renderList();
			if (chip.classList.contains('side-link')) window.scrollTo(0, Math.min(y, 0));
			const c = $(`.chip[data-cat="${state.filter.cat}"]`);
			if (c && c.offsetParent) c.scrollIntoView({ block: 'nearest', inline: 'center' });
		});
	}
	$('#src').addEventListener('change', (e) => { state.filter.src = e.target.value; state.limit = PAGE; renderItems(); });
	$('#refresh').addEventListener('click', async (e) => {
		e.target.textContent = 'aggiornamento…';
		await loadNews(true);
		renderList();
		toast(`${selectedItems().length} notizie`);
	});
}

function renderItems() {
	const box = $('#items');
	if (!box) return;
	if (!settings.sel.length) {
		box.innerHTML = `<div class="empty"><strong>Nessuna fonte selezionata</strong>Scegli da dove leggere le notizie.<br><br><a class="btn primary" href="#/fonti">Scegli le fonti</a></div>`;
		return;
	}
	const items = filteredItems();
	if (!items.length) {
		const offline = state.news?.offline;
		box.innerHTML = `<div class="empty"><strong>${state.filter.q ? 'Nessun risultato' : offline ? 'Sei offline' : 'Nessuna notizia'}</strong>${
			state.filter.q ? 'Prova con altre parole o togli i filtri.' : offline ? 'Le notizie torneranno appena c\'è connessione.' : 'Le fonti scelte non hanno pubblicato nulla negli ultimi giorni.'}</div>`;
		return;
	}
	const ts = terms();
	const shown = items.slice(0, state.limit);
	let html = '';
	let lastDay = null;
	for (const it of shown) {
		const day = dayStart(it.p);
		if (day !== lastDay) {
			if (lastDay !== null) html += '</ul>';
			html += `<h3 class="day">${esc(fmtDay(it.p))}</h3><ul class="list">`;
			lastDay = day;
		}
		const s = state.sources.get(it.s);
		html += `<li class="item${readState.has(it.id) ? ' read' : ''}"><a href="#/a/${it.id}">
			<div class="meta"><span class="src">${esc(s?.name || it.s)}</span><span class="dot"></span><time datetime="${new Date(it.p).toISOString()}">${fmtShort(it.p)}</time></div>
			<h2>${highlight(it.t, ts)}</h2>
			${it.d ? `<p>${highlight(it.d, ts)}</p>` : ''}
		</a></li>`;
	}
	html += '</ul>';
	if (items.length > shown.length) {
		html += `<button class="btn more" id="more">Mostra altre (${items.length - shown.length})</button>`;
	} else {
		html += `<p class="foot" style="text-align:center">${items.length} notizie degli ultimi tre giorni.</p>`;
	}
	box.innerHTML = html;
	const more = $('#more');
	if (more) {
		more.addEventListener('click', () => { state.limit += PAGE * 2; renderItems(); });
		new IntersectionObserver((entries, obs) => {
			if (entries[0].isIntersecting) { obs.disconnect(); state.limit += PAGE; renderItems(); }
		}, { rootMargin: '600px' }).observe(more);
	}
}

function paragraphs(text) {
	return text.split(/\n{2,}|\n(?=• )/).map((p) => p.trim()).filter(Boolean)
		.map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

async function renderArticle(id) {
	const item = allItems().find((it) => it.id === id);
	if (!item) {
		view.innerHTML = `<div class="empty"><strong>Articolo non più disponibile</strong>Edicola tiene solo le notizie degli ultimi tre giorni.<br><br><a class="btn" href="#/">Torna alle notizie</a></div>`;
		return;
	}
	readState.set(id, 1);
	const s = state.sources.get(item.s) || { name: item.s };
	const cat = state.cats.get(s.cat);
	const ai = AI.isEnabled(settings.ai);
	let host = '';
	try { host = new URL(item.u).hostname.replace(/^www\./, ''); } catch {}

	view.innerHTML = `
		<article class="article">
			<div class="article-nav">
				<button class="back" id="back"><span aria-hidden="true">←</span> Notizie</button>
				<a class="btn small" href="${esc(item.u)}" target="_blank" rel="noopener noreferrer">Apri la fonte ↗</a>
			</div>
			<div class="meta"><span class="src">${esc(s.name)}</span>${cat ? `<span class="dot"></span><span>${esc(cat.name)}</span>` : ''}</div>
			<h1>${esc(item.t)}</h1>
			<p class="byline">${item.a ? `di <span class="author">${esc(item.a)}</span> · ` : ''}<time datetime="${new Date(item.p).toISOString()}">${esc(fmtLong(item.p))}</time></p>
			${ai ? `<section class="ai-box" id="tldr"><div class="label"><span>TL;DR</span></div><div class="ai-out" id="tldr-out"></div></section>` : ''}
			<div class="prose" id="body">${item.d ? `<p class="lead">${esc(item.d)}</p>` : ''}</div>
			<div class="actions">
				<a class="btn primary" href="${esc(item.u)}" target="_blank" rel="noopener noreferrer">Leggi su ${esc(host || s.name)} ↗</a>
				${navigator.share ? '<button class="btn" id="share">Condividi</button>' : '<button class="btn" id="share">Copia link</button>'}
			</div>
		</article>`;

	$('#back').addEventListener('click', () => {
		if (state.cameFromList) history.back();
		else location.hash = '#/';
	});
	$('#share').addEventListener('click', async () => {
		if (navigator.share) {
			try { await navigator.share({ title: item.t, url: item.u }); } catch {}
		} else {
			try { await navigator.clipboard.writeText(item.u); toast('Link copiato'); } catch { toast('Impossibile copiare'); }
		}
	});
	window.scrollTo(0, 0);

	const text = await longText(item);
	const body = $('#body');
	if (body && text) {
		body.innerHTML = paragraphs(text);
	} else if (body) {
		body.insertAdjacentHTML('beforeend', `<p class="note">${item.d ? 'La fonte pubblica solo questo estratto.' : 'La fonte non pubblica un estratto.'} L'articolo completo è sul sito.</p>`);
	}

	if (ai) setupTldr(item, s, text);
}

function progressText(p) {
	const pct = Math.round((p.progress || 0) * 100);
	if (/cache/i.test(p.text || '')) return `Carico il modello… ${pct}%`;
	if (/fetch|download/i.test(p.text || '')) return `Scarico il modello (solo la prima volta)… ${pct}%`;
	return pct ? `Preparo il modello… ${pct}%` : 'Preparo il modello…';
}

function setupTldr(item, src, text) {
	const out = $('#tldr-out');
	if (!out) return;
	const cached = tldrCache.get(item.id);
	if (cached) {
		out.innerHTML = AI.renderMarkdown(cached);
		return;
	}
	const run = async () => {
		state.aiCtrl?.abort();
		const ctrl = state.aiCtrl = new AbortController();
		out.innerHTML = '<p class="cursor"></p>';
		try {
			const res = await AI.complete(settings.ai, AI.SYSTEM, AI.tldrPrompt(item, src.name, settings.ai.provider === 'webllm' ? (text || '').slice(0, 6000) : text), (t) => {
				if (out.isConnected) out.innerHTML = AI.renderMarkdown(t) || '<p class="cursor"></p>';
			}, ctrl.signal, (pr) => {
				if (out.isConnected) out.innerHTML = `<p class="help" style="margin:0">${esc(progressText(pr))}</p>`;
			});
			if (res) tldrCache.set(item.id, res);
			if (out.isConnected) out.innerHTML = AI.renderMarkdown(res);
		} catch (e) {
			if (e.name === 'AbortError' || !out.isConnected) return;
			out.innerHTML = `<p class="ai-err">${esc(e.message)}</p><button class="linkbtn" id="tldr-go">Riprova</button>`;
			$('#tldr-go')?.addEventListener('click', run);
		}
	};
	if (settings.ai.auto) run();
	else {
		out.innerHTML = '<button class="btn small" id="tldr-go">Riassumi in italiano</button>';
		$('#tldr-go').addEventListener('click', run);
	}
}

/* ---------- Daily recap ---------- */

function filterLabel() {
	const parts = [];
	if (state.filter.cat) parts.push(state.cats.get(state.filter.cat)?.name);
	if (state.filter.src) parts.push(state.sources.get(state.filter.src)?.name);
	if (state.filter.q) parts.push(`«${state.filter.q}»`);
	return parts.filter(Boolean).join(', ');
}

function recapItems() {
	const items = filteredItems();
	const today = dayStart(Date.now());
	let pick = items.filter((it) => it.p >= today);
	if (pick.length < 10) pick = items.filter((it) => it.p >= Date.now() - 24 * 3600e3);
	return pick;
}

function renderRecap() {
	const ai = AI.isEnabled(settings.ai);
	const label = filterLabel();
	const items = recapItems();
	const device = settings.ai.provider === 'webllm';
	const max = device ? WebLLM.RECAP_LIMIT.items : Math.max(10, Number(settings.ai.maxItems) || 60);
	const used = items.slice(0, max);
	const key = `${new Date().toDateString()}|${state.filter.cat}|${state.filter.src}|${norm(state.filter.q)}`;
	const cached = recapCache.get(key);

	view.innerHTML = `
		<section class="page recap">
			<h1>Il riassunto <em>di oggi</em></h1>
			<p class="lede">${new Date().toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' })}${label ? ` · ${esc(label)}` : ''} · ${items.length} notizie${items.length > used.length ? `, le ${used.length} più recenti` : ''}.</p>
			${!ai ? `<div class="empty"><strong>Serve un modello AI</strong>Collega un modello locale (Ollama, LM Studio…) o una API nelle impostazioni.<br><br><a class="btn primary" href="#/impostazioni">Configura l'AI</a></div>`
			: !items.length ? `<div class="empty"><strong>Nessuna notizia di oggi</strong>Con i filtri attuali non c'è nulla da riassumere.</div>`
			: `<div class="ai-out" id="recap-out">${cached ? AI.renderMarkdown(cached) : ''}</div>
				<div class="actions">
					<button class="btn ${cached ? '' : 'primary'}" id="go">${cached ? 'Rigenera' : 'Genera il riassunto'}</button>
					<a class="btn" href="#/">Torna alle notizie</a>
				</div>
				<p class="help">${AI.isLocal(settings.ai) ? (device ? 'Il riassunto viene generato sul tuo dispositivo, anche offline: nessuna notizia esce da qui. I modelli piccoli sono più lenti e leggono meno notizie.' : 'Il riassunto viene generato sul tuo computer: nessuna notizia esce dal dispositivo.') : `Titoli e descrizioni vengono inviati a ${esc(settings.ai.base.replace(/^https?:\/\//, '').split('/')[0])}.`} I filtri attivi nella pagina delle notizie decidono cosa riassumere.</p>`}
		</section>`;

	const go = $('#go');
	if (!go) return;
	go.addEventListener('click', async () => {
		const out = $('#recap-out');
		state.aiCtrl?.abort();
		const ctrl = state.aiCtrl = new AbortController();
		go.disabled = true;
		go.textContent = 'Sto scrivendo…';
		out.innerHTML = '<p class="cursor"></p>';
		const lines = used.map((it) => {
			const s = state.sources.get(it.s);
			return `- [${s?.name || it.s}] ${it.t}${it.d ? ' — ' + truncate(it.d, device ? WebLLM.RECAP_LIMIT.desc : 160) : ''}`;
		});
		try {
			const res = await AI.complete(settings.ai, AI.SYSTEM, AI.recapPrompt(lines, label), (t) => {
				if (out.isConnected) out.innerHTML = AI.renderMarkdown(t) + '<span class="cursor"></span>';
			}, ctrl.signal, (pr) => {
				if (out.isConnected) out.innerHTML = `<p class="help">${esc(progressText(pr))}</p>`;
			});
			if (res) recapCache.set(key, res);
			if (out.isConnected) out.innerHTML = AI.renderMarkdown(res);
		} catch (e) {
			if (e.name !== 'AbortError' && out.isConnected) out.innerHTML = `<p class="ai-err">${esc(e.message)}</p>`;
		}
		if (go.isConnected) { go.disabled = false; go.textContent = 'Rigenera'; go.classList.remove('primary'); }
	});
}

/* ---------- Sources ---------- */

let srcLang = 'all';
let srcQuery = '';

function sourceStatus(id) {
	const s = state.sources.get(id);
	if (s?.custom) {
		const st = state.customStatus[id];
		return st && st !== 'ok' ? st : '';
	}
	const st = state.news?.status?.[id];
	if (st === undefined || typeof st === 'number' && st > 0) return '';
	return st === 0 ? 'nessuna notizia recente' : 'non raggiungibile ora';
}

function renderSources() {
	const sel = new Set(settings.sel);
	const q = norm(srcQuery);
	const visible = (s) => (srcLang === 'all' || s.lang === srcLang) && (!q || norm(`${s.name} ${s.url}`).includes(q));
	const groups = state.catalog.categories.map((c) => ({ c, list: state.catalog.sources.filter((s) => s.cat === c.id && visible(s)) }))
		.filter((g) => g.list.length);

	view.innerHTML = `
		<section class="page">
			<h1>Le tue <em>fonti</em></h1>
			<p class="lede">${state.catalog.sources.length} fonti italiane e internazionali divise per argomento. La scelta resta salvata solo su questo dispositivo: Edicola scarica sempre tutte le notizie insieme, quindi nessuno sa cosa leggi.</p>
			<div class="subtools" style="margin-bottom:1rem">
				<div class="seg" role="group" aria-label="Lingua">
					${[['all', 'Tutte'], ['it', 'Italiane'], ['en', 'Inglesi']].map(([k, l]) => `<button data-lang="${k}" aria-pressed="${srcLang === k}">${l}</button>`).join('')}
				</div>
				<span id="selcount">${settings.sel.length} selezionate</span>
			</div>
			<label class="search" style="margin-bottom:0.5rem">
				<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M15.5 15.5 20 20" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
				<input type="search" id="sq" placeholder="Cerca una fonte" value="${esc(srcQuery)}" autocomplete="off" aria-label="Cerca una fonte">
			</label>
			<div id="groups">
			${groups.map(({ c, list }) => {
				const n = list.filter((s) => sel.has(s.id)).length;
				return `<details class="group" ${q || n ? 'open' : ''}>
					<summary><span class="name">${esc(c.name)}</span><span class="count" data-count="${c.id}">${n}/${list.length}</span></summary>
					<div class="rows">
						<label class="row toggle-all"><input type="checkbox" data-all="${c.id}" ${n === list.length ? 'checked' : ''}><span class="grow">Seleziona tutte</span></label>
						${list.map((s) => {
							const st = sourceStatus(s.id);
							return `<label class="row"><input type="checkbox" data-id="${s.id}" ${sel.has(s.id) ? 'checked' : ''}><span class="grow">${esc(s.name)}<small>${s.lang.toUpperCase()}</small>${st ? `<small class="warn">${esc(st)}</small>` : ''}</span></label>`;
						}).join('')}
					</div>
				</details>`;
			}).join('') || '<p class="help">Nessuna fonte trovata.</p>'}
			</div>

			<h2>Fonti personali (RSS o Atom)</h2>
			<p class="help">Aggiungi qualsiasi feed: un blog, una newsletter, una ricerca su Hacker News (<code>https://hnrss.org/newest?q=parola</code>). Questi feed vengono letti direttamente dal tuo browser, quindi funzionano solo se il sito lo permette (CORS). Se non va, puoi impostare un proxy nelle impostazioni.</p>
			<div id="custom-list">
				${settings.custom.map((c) => {
					const st = sourceStatus(c.id);
					return `<div class="row"><input type="checkbox" data-id="${c.id}" ${sel.has(c.id) ? 'checked' : ''} aria-label="Attiva ${esc(c.name)}"><span class="grow">${esc(c.name)}<small>${esc(state.cats.get(c.cat)?.name || '')}</small>${st ? `<small class="warn">${esc(st)}</small>` : ''}</span><button class="x" data-del="${c.id}" aria-label="Rimuovi ${esc(c.name)}">×</button></div>`;
				}).join('')}
			</div>
			<form id="add" style="margin-top:1rem">
				<label class="field"><span>Indirizzo del feed</span><input class="input" name="url" type="url" required placeholder="https://esempio.it/feed/" inputmode="url"></label>
				<div class="grid2">
					<label class="field"><span>Nome (facoltativo)</span><input class="input" name="name" placeholder="Dal feed"></label>
					<label class="field"><span>Categoria</span><select class="input" name="cat">${state.catalog.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>
				</div>
				<button class="btn" type="submit">Aggiungi feed</button>
				<p class="status" id="add-status" role="status"></p>
			</form>

			<div class="sticky-cta"><a class="btn primary" href="#/">Vai alle notizie</a><span class="hint" id="hint"></span></div>
		</section>`;

	const changed = () => {
		save();
		$('#selcount').textContent = `${settings.sel.length} selezionate`;
		for (const g of groups) {
			const n = g.list.filter((s) => settings.sel.includes(s.id)).length;
			const el = $(`[data-count="${g.c.id}"]`);
			if (el) el.textContent = `${n}/${g.list.length}`;
			const all = $(`[data-all="${g.c.id}"]`);
			if (all) all.checked = n === g.list.length;
		}
	};

	$('.page').addEventListener('change', (e) => {
		const t = e.target;
		if (t.dataset.id) {
			const set = new Set(settings.sel);
			t.checked ? set.add(t.dataset.id) : set.delete(t.dataset.id);
			settings.sel = [...set];
			changed();
			if (state.sources.get(t.dataset.id)?.custom) loadCustom();
		} else if (t.dataset.all) {
			const g = groups.find((g) => g.c.id === t.dataset.all);
			const set = new Set(settings.sel);
			for (const s of g.list) t.checked ? set.add(s.id) : set.delete(s.id);
			settings.sel = [...set];
			for (const s of g.list) { const cb = $(`[data-id="${s.id}"]`); if (cb) cb.checked = t.checked; }
			changed();
		}
	});

	for (const b of $$('[data-lang]')) b.addEventListener('click', () => { srcLang = b.dataset.lang; renderSources(); });
	let t;
	$('#sq').addEventListener('input', (e) => {
		clearTimeout(t);
		t = setTimeout(() => {
			srcQuery = e.target.value;
			const pos = e.target.selectionStart;
			renderSources();
			const inp = $('#sq');
			inp.focus();
			inp.setSelectionRange(pos, pos);
		}, 200);
	});

	for (const b of $$('[data-del]')) {
		b.addEventListener('click', () => {
			settings.custom = settings.custom.filter((c) => c.id !== b.dataset.del);
			settings.sel = settings.sel.filter((id) => id !== b.dataset.del);
			save();
			indexSources();
			state.custom = state.custom.filter((it) => it.s !== b.dataset.del);
			renderSources();
		});
	}

	$('#add').addEventListener('submit', async (e) => {
		e.preventDefault();
		const f = new FormData(e.target);
		const url = String(f.get('url')).trim();
		const status = $('#add-status');
		if (settings.custom.some((c) => c.url === url)) { status.className = 'status err'; status.textContent = 'Questo feed è già nella lista.'; return; }
		status.className = 'status';
		status.textContent = 'Provo a leggere il feed…';
		try {
			const feed = parseFeed(await fetchFeedText(url));
			if (!feed.items.length) throw new Error('nessun articolo trovato: è davvero un feed RSS o Atom?');
			const id = 'u-' + hash(url);
			const name = String(f.get('name')).trim() || feed.title || new URL(url).hostname;
			settings.custom.push({ id, name: name.slice(0, 80), url, cat: String(f.get('cat')) });
			settings.sel.push(id);
			save();
			indexSources();
			await loadCustom();
			renderSources();
			toast(`Aggiunto: ${name}`);
		} catch (err) {
			status.className = 'status err';
			status.textContent = `Non riesco a leggerlo: ${err.message}.`;
		}
	});
}

/* ---------- Welcome ---------- */

function renderWelcome() {
	const picked = new Set();
	let lang = 'both';
	view.innerHTML = `
		<section class="page">
			<h1>Benvenuto in <em>Edicola</em></h1>
			<p class="lede">Notizie da oltre 160 fonti, solo testo, dalla più recente. Niente account, niente pubblicità, niente tracciamento: le tue scelte restano su questo dispositivo.</p>
			<h2>Quali argomenti ti interessano?</h2>
			<div class="tiles">
				${state.catalog.categories.map((c) => {
					const n = state.catalog.sources.filter((s) => s.cat === c.id).length;
					return `<button class="tile" data-cat="${c.id}" aria-pressed="false">${esc(c.name)}<small>${n} fonti</small></button>`;
				}).join('')}
			</div>
			<h2>In che lingua?</h2>
			<div class="seg" role="group" aria-label="Lingua delle fonti">
				<button data-lang="both" aria-pressed="true">Italiano e inglese</button>
				<button data-lang="it" aria-pressed="false">Solo italiano</button>
				<button data-lang="en" aria-pressed="false">Solo inglese</button>
			</div>
			<div class="sticky-cta">
				<button class="btn primary" id="start" disabled>Inizia a leggere</button>
				<span class="hint" id="hint">Scegli almeno un argomento</span>
			</div>
			<p class="foot">Potrai cambiare fonti, aggiungere feed RSS e collegare un'intelligenza artificiale (anche locale) quando vuoi.</p>
		</section>`;

	const pickSources = () => {
		const out = [];
		for (const cat of picked) {
			// Prefer sources that are working right now.
			const st = state.news?.status || {};
			const ok = (s) => st[s.id] === undefined || (typeof st[s.id] === 'number' && st[s.id] > 0);
			const list = state.catalog.sources.filter((s) => s.cat === cat && (lang === 'both' || s.lang === lang) && ok(s));
			let chosen = list.filter((s) => s.def);
			if (!chosen.length) chosen = list.slice(0, 2);
			out.push(...chosen.map((s) => s.id));
		}
		return out;
	};
	const update = () => {
		const n = pickSources().length;
		$('#start').disabled = !picked.size;
		$('#hint').textContent = picked.size ? `${n} fonti consigliate, potrai cambiarle` : 'Scegli almeno un argomento';
	};
	for (const t of $$('.tile')) {
		t.addEventListener('click', () => {
			picked.has(t.dataset.cat) ? picked.delete(t.dataset.cat) : picked.add(t.dataset.cat);
			t.setAttribute('aria-pressed', picked.has(t.dataset.cat));
			update();
		});
	}
	for (const b of $$('[data-lang]')) {
		b.addEventListener('click', () => {
			lang = b.dataset.lang;
			for (const o of $$('[data-lang]')) o.setAttribute('aria-pressed', o === b);
			update();
		});
	}
	$('#start').addEventListener('click', () => {
		settings.sel = pickSources();
		settings.onboarded = true;
		save();
		location.hash = '#/';
	});
}

/* ---------- Settings ---------- */

/* ---------- Icons ---------- */

const ICON_PATHS = {
	sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>',
	moon: '<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>',
	auto: '<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>',
	text: '<path d="M3.5 18 8 6l4.5 12M5.2 14h5.6M14 18l3.25-8L20.5 18M15.2 15.3h4.1"/>',
	rss: '<path d="M5 11a8 8 0 0 1 8 8M5 5a14 14 0 0 1 14 14"/><circle cx="6" cy="18" r="1.4" fill="currentColor" stroke="none"/>',
	refresh: '<path d="M19.5 10A7.8 7.8 0 0 0 5.2 7.6L4 9M4 4.5V9h4.5M4.5 14a7.8 7.8 0 0 0 14.3 2.4L20 15M20 19.5V15h-4.5"/>',
	off: '<circle cx="12" cy="12" r="8"/><path d="M6.5 17.5l11-11"/>',
	device: '<rect x="7" y="2.8" width="10" height="18.4" rx="2.6"/><path d="M10.8 18h2.4"/>',
	laptop: '<rect x="4.5" y="5" width="15" height="10.5" rx="1.6"/><path d="M2.5 19h19"/>',
	cloud: '<path d="M7.2 18.5h9.6a4.2 4.2 0 0 0 .6-8.36A6 6 0 0 0 6 10.6a3.95 3.95 0 0 0 1.2 7.9z"/>',
	download: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5M5 20h14"/>',
	upload: '<path d="M12 15.5V4.5M7.5 9 12 4.5 16.5 9M5 20h14"/>',
	globe: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.6 2.4 2.6 14.6 0 17M12 3.5c-2.6 2.4-2.6 14.6 0 17"/>',
	trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5"/>',
	shield: '<path d="M12 3 19 6v5.2c0 4.4-2.9 7.9-7 9.8-4.1-1.9-7-5.4-7-9.8V6z"/><path d="m9 12 2.2 2.2L15.2 10"/>',
	chevron: '<path d="m9.5 6 6 6-6 6"/>',
	sparkle: '<path d="M12 3.5 13.9 9l5.6 1.9-5.6 1.9L12 18.5l-1.9-5.7-5.6-1.9L10.1 9z"/><path d="M18.5 3.5v3M17 5h3"/>',
	key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14 9l2 2"/>',
	info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.8v.2"/>'
};

const icon = (name, size = 20) => `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

/* ---------- Settings ---------- */

const AI_MODES = {
	off: { icon: 'off', name: 'Spenta', desc: 'Solo le notizie' },
	device: { icon: 'device', name: 'Nel dispositivo', desc: 'Gira nel browser, anche offline', badge: ['ok', 'Privato'] },
	computer: { icon: 'laptop', name: 'Sul mio computer', desc: 'Ollama, LM Studio, llama.cpp', badge: ['ok', 'Privato'] },
	online: { icon: 'cloud', name: 'Servizio online', desc: 'OpenAI, Anthropic, OpenRouter…', badge: ['warn', 'Online'] }
};
const COMPUTER_APPS = [['ollama', 'Ollama'], ['lmstudio', 'LM Studio'], ['llamacpp', 'llama.cpp']];
const ONLINE_SERVICES = [['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['openrouter', 'OpenRouter'], ['custom', 'Altro']];

function aiMode(ai) {
	if (ai.provider === 'none') return 'off';
	if (ai.provider === 'webllm') return 'device';
	return COMPUTER_APPS.some(([k]) => k === ai.preset) ? 'computer' : 'online';
}

function renderSettings() {
	const ai = settings.ai;
	const st = state.news?.status || {};
	const okCount = Object.values(st).filter((v) => typeof v === 'number' && v > 0).length;
	const customCount = settings.custom.length;
	const seg = (name, cur, opts) => `<div class="seg" role="group">${opts.map(([v, l, a]) => `<button data-${name}="${v}" aria-pressed="${cur === v}"${a ? ` aria-label="${a}" title="${a}"` : ''}>${l}</button>`).join('')}</div>`;
	const row = (ic, title, sub, right = '', attrs = '', tag = 'div') => `<${tag} class="set-row" ${attrs}><span class="set-ic">${icon(ic)}</span><span class="set-text"><span class="set-title">${title}</span>${sub ? `<span class="set-sub">${sub}</span>` : ''}</span>${right}</${tag}>`;
	const chevron = `<span class="set-chev">${icon('chevron', 18)}</span>`;

	view.innerHTML = `
		<section class="page settings">
			<h1>Impostazioni</h1>
			<p class="lede">${icon('shield', 16)} Niente account: tutto resta su questo dispositivo.</p>

			<h2>Aspetto</h2>
			<div class="card">
				<div class="card-pad">
					<div class="looks">
						${[['quotidiano', 'Quotidiano', 'Carta e inchiostro'], ['moderno', 'Moderno', 'Grigi e blu'], ['notte', 'Notte', 'Blu notte e ambra']].map(([k, l, d]) => `<button class="look" data-look="${k}" aria-pressed="${settings.style === k}"><span class="look-sample look-${k}" aria-hidden="true"><b>Ag</b><i></i><i></i></span><span class="look-name">${l}</span><span class="look-desc">${d}</span></button>`).join('')}
					</div>
				</div>
				${row(settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'auto', 'Chiaro o scuro', '', seg('theme', settings.theme, [['auto', icon('auto', 17), 'Automatico'], ['light', icon('sun', 17), 'Chiaro'], ['dark', icon('moon', 17), 'Scuro']]), 'id="theme-row"')}
				${row('text', 'Dimensione del testo', '', seg('size', settings.size, [['s', '<span style="font-size:0.75rem">A</span>', 'Piccolo'], ['m', '<span style="font-size:0.9rem">A</span>', 'Normale'], ['l', '<span style="font-size:1.05rem">A</span>', 'Grande'], ['xl', '<span style="font-size:1.2rem">A</span>', 'Molto grande']]))}
			</div>

			<h2>Notizie</h2>
			<div class="card">
				${row('rss', 'Fonti', `${settings.sel.length} selezionate${customCount ? ` · ${customCount} personali` : ''}`, chevron, 'href="#/fonti"', 'a')}
				${row('refresh', 'Aggiornamento', state.news?.at ? `${esc(fmtShort(state.news.at))} · ${okCount} fonti attive` : 'Ogni mezz\'ora', '<button class="btn small" id="refresh-now">Aggiorna</button>')}
			</div>

			<h2>Intelligenza artificiale <span class="h2-note">facoltativa</span></h2>
			<div class="card">
				<div class="card-pad">
					<p class="help" style="margin-top:0">Riassunto delle notizie del giorno e TL;DR in italiano di ogni articolo.</p>
					<div class="modes" role="radiogroup" aria-label="Dove gira l'intelligenza artificiale">
						${Object.entries(AI_MODES).map(([k, m]) => `<button class="mode" role="radio" data-mode="${k}" aria-checked="${aiMode(ai) === k}">
							<span class="mode-top"><span class="mode-ic">${icon(m.icon, 22)}</span>${m.badge ? `<span class="badge ${m.badge[0]}">${m.badge[1]}</span>` : ''}</span>
							<span class="mode-name">${m.name}</span><span class="mode-desc">${m.desc}</span></button>`).join('')}
					</div>
					<div id="ai-panel"></div>
				</div>
			</div>

			<h2>Altro</h2>
			<div class="card">
				${row('download', 'Esporta impostazioni', 'Per spostarle su un altro dispositivo', chevron, 'id="export" type="button"', 'button')}
				${row('upload', 'Importa impostazioni', 'Da un file esportato', `${chevron}<input type="file" id="import" accept="application/json,.json" hidden>`, '', 'label')}
				<details class="set-details">
					<summary>${row('globe', 'Proxy per i feed personali', settings.proxy ? 'Attivo' : 'Spento', chevron, '', 'span')}</summary>
					<div class="card-pad">
						<p class="help" style="margin-top:0">Solo per i feed aggiunti a mano che il browser non riesce a leggere. Il proxy vede quali feed leggi: usane uno tuo, se puoi. Usa <code>{url}</code> come segnaposto.</p>
						<input class="input" id="proxy" value="${esc(settings.proxy)}" placeholder="https://mio-proxy.workers.dev/?url={url}" inputmode="url" autocomplete="off" aria-label="Indirizzo del proxy">
					</div>
				</details>
				${row('trash', 'Cancella tutti i dati', 'Fonti, preferenze e chiavi su questo dispositivo', '', 'id="reset" type="button"', 'button').replace('class="set-row"', 'class="set-row danger"')}
			</div>

			<details class="card about">
				<summary>${row('info', 'Come funziona la privacy', 'Perché nessuno sa cosa leggi', chevron, '', 'span')}</summary>
				<div class="card-pad">
					<p class="help" style="margin-top:0">Ogni mezz'ora un'azione automatica su GitHub legge tutte le ${state.catalog.sources.length} fonti del catalogo e pubblica un unico pacchetto di notizie. Il tuo dispositivo scarica sempre il pacchetto intero e sceglie le fonti in locale: né GitHub né i giornali sanno quali segui.</p>
					<p class="help">Si tengono solo le notizie degli ultimi tre giorni e nulla si accumula. Nessun cookie, nessuna statistica, nessun account.</p>
					<p class="help" style="margin-bottom:0">Codice sorgente: <a href="https://github.com/claudioaccolito/news" target="_blank" rel="noopener">github.com/claudioaccolito/news</a></p>
				</div>
			</details>
		</section>`;

	// Appearance
	for (const b of $$('[data-theme]')) {
		b.addEventListener('click', () => {
			settings.theme = b.dataset.theme;
			settings.lookChosen = true;
			save();
			applyLook();
			for (const o of $$('[data-theme]')) o.setAttribute('aria-pressed', o === b);
			$('#theme-row .set-ic').innerHTML = icon(settings.theme === 'dark' ? 'moon' : settings.theme === 'light' ? 'sun' : 'auto');
		});
	}
	for (const b of $$('[data-look]')) {
		b.addEventListener('click', () => {
			settings.style = b.dataset.look;
			settings.lookChosen = true;
			save();
			applyLook();
			for (const o of $$('[data-look]')) o.setAttribute('aria-pressed', o === b);
		});
	}
	for (const b of $$('[data-size]')) {
		b.addEventListener('click', () => {
			settings.size = b.dataset.size;
			save();
			document.documentElement.dataset.size = settings.size;
			for (const o of $$('[data-size]')) o.setAttribute('aria-pressed', o === b);
		});
	}

	// News
	$('#refresh-now').addEventListener('click', async (e) => {
		e.target.disabled = true;
		e.target.textContent = '…';
		await loadNews(true);
		toast(`${selectedItems().length} notizie aggiornate`);
		const y = window.scrollY;
		renderSettings();
		window.scrollTo(0, y);
	});

	// AI
	for (const b of $$('[data-mode]')) {
		b.addEventListener('click', () => {
			const mode = b.dataset.mode;
			if (mode === aiMode(ai)) return;
			if (mode === 'off') { ai.provider = 'none'; ai.preset = ''; }
			else if (mode === 'device') usePreset('device');
			else if (mode === 'computer') usePreset(COMPUTER_APPS.some(([k]) => k === ai.lastComputer) ? ai.lastComputer : 'ollama');
			else usePreset(ONLINE_SERVICES.some(([k]) => k === ai.lastOnline) ? ai.lastOnline : 'openai');
			save();
			for (const o of $$('[data-mode]')) o.setAttribute('aria-checked', o === b);
			setNav('/impostazioni');
			renderAiPanel();
		});
	}

	function usePreset(k) {
		const p = AI.PRESETS[k];
		const changed = ai.preset !== k;
		ai.preset = k;
		ai.provider = p.provider;
		if (changed) {
			ai.base = p.base;
			ai.model = p.model || '';
			ai.key = '';
		}
		if (p.provider === 'webllm' && !WebLLM.MODELS.some((m) => m.id === ai.model)) ai.model = WebLLM.MODELS[0].id;
		if (COMPUTER_APPS.some(([c]) => c === k)) ai.lastComputer = k;
		if (ONLINE_SERVICES.some(([c]) => c === k)) ai.lastOnline = k;
	}

	renderAiPanel();

	function renderAiPanel() {
		const panel = $('#ai-panel');
		const mode = aiMode(ai);
		if (mode === 'off') { panel.innerHTML = ''; return; }
		const p = AI.PRESETS[ai.preset] || AI.PRESETS.custom;
		const autoRow = `<label class="switch-row"><span><span class="set-title">TL;DR automatico</span><span class="set-sub">Appena apri un articolo</span></span><input type="checkbox" class="switch" id="auto" ${ai.auto ? 'checked' : ''}></label>`;
		const status = '<p class="status" id="ai-status" role="status"></p>';

		if (mode === 'device') {
			panel.innerHTML = `
				<div class="panel">
					<p class="status" id="gpu-status" role="status">Controllo il supporto WebGPU…</p>
					<div class="models" role="radiogroup" aria-label="Modello">
						${WebLLM.MODELS.map((m) => `<label class="model"><input type="radio" name="wmodel" value="${m.id}" ${ai.model === m.id ? 'checked' : ''}><span class="model-text"><span class="model-name">${esc(m.label)} <small>${m.size}</small> <small class="ok" data-cached="${m.id}"></small></span><span class="set-sub">${esc(m.note)}</span></span></label>`).join('')}
					</div>
					<progress id="wprog" max="1" value="0" hidden></progress>
					<div class="actions" style="margin-top:0.75rem">
						<button class="btn primary" id="test" type="button">${icon('download', 17)} Scarica e prova</button>
						<button class="btn" id="wdel" type="button">${icon('trash', 17)} Elimina</button>
					</div>
					${status}
					<p class="help">${p.help}</p>
					${autoRow}
				</div>`;
		} else {
			const list = mode === 'computer' ? COMPUTER_APPS : ONLINE_SERVICES;
			const custom = ai.preset === 'custom';
			panel.innerHTML = `
				<div class="panel">
					${seg('svc', ai.preset, list.map(([k, l]) => [k, l]))}
					<p class="help">${p.help}</p>
					${p.key ? `<label class="field"><span>${icon('key', 15)} Chiave API</span><input class="input" id="key" type="password" value="${esc(ai.key)}" autocomplete="off" placeholder="Resta solo su questo dispositivo"></label>` : ''}
					${custom ? `<label class="field"><span>Indirizzo</span><input class="input" id="base" value="${esc(ai.base)}" placeholder="https://api.esempio.com/v1" inputmode="url" autocomplete="off"></label>` : ''}
					<label class="field"><span>Modello</span>
						<span class="inline"><input class="input" id="model" list="models" value="${esc(ai.model)}" placeholder="${mode === 'computer' ? 'es. llama3.2' : 'scegli dall\'elenco'}" autocomplete="off"><button class="btn small" id="list" type="button">Elenca</button></span>
						<datalist id="models"></datalist>
					</label>
					<div class="actions" style="margin-top:0.25rem"><button class="btn primary" id="test" type="button">${icon('sparkle', 17)} Prova</button></div>
					${status}
					${autoRow}
					<details class="adv">
						<summary>Opzioni avanzate</summary>
						${custom ? '' : `<label class="field"><span>Indirizzo</span><input class="input" id="base" value="${esc(ai.base)}" inputmode="url" autocomplete="off"></label>`}
						<label class="field"><span>Notizie nel riassunto del giorno</span><input class="input" id="max" type="number" min="10" max="400" step="10" value="${esc(ai.maxItems)}" style="max-width:8rem"></label>
						<p class="help">I modelli piccoli hanno poca memoria: se il riassunto si interrompe, abbassa questo numero.</p>
					</details>
				</div>`;
		}
		bindAiPanel(mode);
	}

	function bindAiPanel(mode) {
		const status = $('#ai-status');
		const val = (id) => $(`#${id}`)?.value.trim();
		const sync = () => {
			if (mode === 'device') ai.model = $('[name="wmodel"]:checked')?.value || WebLLM.MODELS[0].id;
			else {
				if ($('#base')) ai.base = val('base');
				if ($('#model')) ai.model = val('model');
				if ($('#key')) ai.key = val('key');
				if ($('#max')) ai.maxItems = Math.max(10, Math.min(400, Number(val('max')) || 60));
			}
			ai.auto = $('#auto').checked;
			save();
			setNav('/impostazioni');
		};
		for (const el of $$('#ai-panel input')) el.addEventListener('change', sync);
		$('#key')?.addEventListener('input', sync);

		for (const b of $$('[data-svc]')) {
			b.addEventListener('click', () => {
				usePreset(b.dataset.svc);
				save();
				renderAiPanel();
			});
		}

		$('#list')?.addEventListener('click', async () => {
			sync();
			status.className = 'status';
			status.textContent = 'Chiedo l\'elenco dei modelli…';
			try {
				const models = await AI.listModels(ai);
				$('#models').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
				status.className = 'status ok';
				status.textContent = models.length ? `${models.length} modelli: tocca il campo Modello per sceglierne uno.` : 'Nessun modello trovato.';
				if (!ai.model && models[0]) { $('#model').value = models[0]; sync(); }
			} catch (e) {
				status.className = 'status err';
				status.textContent = e.message;
			}
		});

		$('#test').addEventListener('click', async () => {
			sync();
			const btn = $('#test');
			btn.disabled = true;
			status.className = 'status';
			status.textContent = 'Provo…';
			const prog = $('#wprog');
			try {
				const r = await AI.complete(ai, AI.SYSTEM, 'Rispondi solo con: Funziona!', (t) => { status.textContent = t; }, undefined, (pr) => {
					if (prog) { prog.hidden = false; prog.value = pr.progress || 0; }
					status.textContent = progressText(pr);
				});
				status.className = 'status ok';
				status.textContent = `Funziona. Risposta: «${truncate(r, 100)}»`;
				if (mode === 'device') refreshDevice();
			} catch (e) {
				status.className = 'status err';
				status.textContent = e.message;
			}
			if (prog) prog.hidden = true;
			if (btn.isConnected) btn.disabled = false;
		});

		if (mode !== 'device') return;

		$('#wdel').addEventListener('click', async () => {
			sync();
			try {
				await WebLLM.remove(ai.model);
				toast('Modello eliminato dal dispositivo');
			} catch (e) {
				toast(`Non riesco a eliminarlo: ${e.message}`);
			}
			refreshDevice();
		});
		refreshDevice();
	}

	async function refreshDevice() {
		const gpu = $('#gpu-status');
		if (!gpu) return;
		const sup = await WebLLM.support();
		if (!gpu.isConnected) return;
		gpu.className = `status ${sup.ok ? 'ok' : 'err'}`;
		gpu.textContent = sup.ok ? `Il tuo dispositivo supporta WebGPU${sup.f16 ? '' : ' (userò la versione a 32 bit, più pesante)'}.` : sup.why;
		$('#test').disabled = !sup.ok;
		if (!sup.ok) return;
		for (const m of WebLLM.MODELS) {
			const el = $(`[data-cached="${m.id}"]`);
			if (el) el.textContent = (await WebLLM.isCached(m.id)) ? '· scaricato' : '';
		}
	}

	// Other
	$('#proxy').addEventListener('change', (e) => {
		settings.proxy = e.target.value.trim();
		save();
		toast(settings.proxy ? 'Proxy salvato' : 'Proxy spento');
	});
	$('#export').addEventListener('click', () => {
		const blob = new Blob([JSON.stringify(exportSettings(), null, 2)], { type: 'application/json' });
		const a = document.createElement('a');
		a.href = URL.createObjectURL(blob);
		a.download = 'edicola-impostazioni.json';
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	});
	$('#import').addEventListener('change', async (e) => {
		const file = e.target.files[0];
		if (!file) return;
		try {
			importSettings(JSON.parse(await file.text()));
			applyLook();
			document.documentElement.dataset.size = settings.size;
			indexSources();
			await loadCustom();
			toast('Impostazioni importate');
			location.hash = '#/';
		} catch (err) {
			toast(`Importazione non riuscita: ${err.message}`);
		}
	});
	$('#reset').addEventListener('click', () => {
		if (!confirm('Cancellare fonti, preferenze e chiavi salvate su questo dispositivo?')) return;
		resetAll();
		location.hash = '#/';
		location.reload();
	});
}

/* ---------- Router ---------- */

let prevRoute = '';

function route() {
	const path = location.hash.slice(1) || '/';
	state.aiCtrl?.abort();
	if (prevRoute === '/' && path !== '/') state.listScroll = window.scrollY;
	state.cameFromList = prevRoute === '/' || (prevRoute.startsWith('/a/') && state.cameFromList);

	if (!settings.onboarded && path !== '/impostazioni') {
		setNav('');
		renderWelcome();
		prevRoute = path;
		window.scrollTo(0, 0);
		return;
	}
	setNav(path);
	view.classList.toggle('wide', path === '/');
	if (!state.news && (path === '/' || path.startsWith('/a/') || path === '/riepilogo')) {
		view.innerHTML = '<p class="loading">Caricamento…</p>';
		state.ready.then(route);
		return;
	}
	if (path.startsWith('/a/')) {
		renderArticle(decodeURIComponent(path.slice(3)));
	} else if (path === '/fonti') {
		renderSources();
		window.scrollTo(0, 0);
	} else if (path === '/impostazioni') {
		renderSettings();
		window.scrollTo(0, 0);
	} else if (path === '/riepilogo') {
		renderRecap();
		window.scrollTo(0, 0);
	} else {
		renderList();
		window.scrollTo(0, prevRoute.startsWith('/a/') ? state.listScroll : 0);
	}
	prevRoute = path;
	if (!path.startsWith('/a/')) document.title = 'Edicola';
}

/* ---------- Keyboard (desktop) ---------- */

function onKey(e) {
	if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
	const tag = e.target.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable) {
		if (e.key === 'Escape') e.target.blur();
		return;
	}
	const path = location.hash.slice(1) || '/';
	if (path === '/') {
		if (e.key === '/') {
			e.preventDefault();
			$('#q')?.focus();
		} else if (e.key === 'j' || e.key === 'k') {
			const links = $$('.item a');
			if (!links.length) return;
			const i = links.indexOf(document.activeElement);
			const next = e.key === 'j' ? Math.min(i + 1, links.length - 1) : Math.max(i - 1, 0);
			links[i < 0 ? 0 : next].focus();
			links[i < 0 ? 0 : next].scrollIntoView({ block: 'nearest' });
			e.preventDefault();
		} else if (e.key === 'o') {
			const id = document.activeElement?.closest?.('.item a')?.getAttribute('href')?.slice(4);
			const it = id && allItems().find((x) => x.id === id);
			if (it) window.open(it.u, '_blank', 'noopener,noreferrer');
		}
	} else if (path.startsWith('/a/')) {
		const id = decodeURIComponent(path.slice(3));
		if (e.key === 'Escape') {
			$('#back')?.click();
		} else if (e.key === 'o') {
			const it = allItems().find((x) => x.id === id);
			if (it) window.open(it.u, '_blank', 'noopener,noreferrer');
		} else if (e.key === 'j' || e.key === 'k') {
			const list = filteredItems();
			const i = list.findIndex((x) => x.id === id);
			const next = list[i + (e.key === 'j' ? 1 : -1)];
			if (i >= 0 && next) location.replace(`#/a/${next.id}`);
		}
	} else if (e.key === 'Escape') {
		location.hash = '#/';
	}
}

async function start() {
	try {
		await loadCatalog();
	} catch {
		view.innerHTML = '<div class="empty"><strong>Impossibile avviare Edicola</strong>Controlla la connessione e riprova.</div>';
		return;
	}
	state.ready = loadNews();
	if (settings.onboarded) await state.ready;
	window.addEventListener('hashchange', route);
	document.addEventListener('keydown', onKey);
	route();

	document.addEventListener('visibilitychange', async () => {
		if (document.visibilityState !== 'visible' || Date.now() - state.loadedAt < 10 * 60e3) return;
		await loadNews();
		if ((location.hash.slice(1) || '/') === '/') {
			const y = window.scrollY;
			renderList();
			window.scrollTo(0, y);
		}
	});
}

if ('serviceWorker' in navigator) {
	navigator.serviceWorker.register('sw.js').catch(() => {});
}

start();
