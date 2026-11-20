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
	root.dataset.style = settings.style || 'quotidiano';
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

function renderSettings() {
	const ai = settings.ai;
	const presetKey = ai.provider === 'none' ? '' : ai.preset || 'custom';
	const preset = AI.PRESETS[presetKey];
	const st = state.news?.status || {};
	const okCount = Object.values(st).filter((v) => typeof v === 'number' && v > 0).length;
	const seg = (name, cur, opts) => `<div class="seg" role="group">${opts.map(([v, l]) => `<button data-${name}="${v}" aria-pressed="${cur === v}">${l}</button>`).join('')}</div>`;

	view.innerHTML = `
		<section class="page">
			<h1>Impostazioni</h1>
			<p class="lede">Tutto resta su questo dispositivo.</p>

			<h2>Lettura</h2>
			<div class="field"><span>Stile</span>
				<div class="looks">
					${[['quotidiano', 'Quotidiano', 'Carta, inchiostro e rosso. Newsreader.'], ['moderno', 'Moderno', 'Grigi, blu e schede. Inter.'], ['notte', 'Notte', 'Blu notte e ambra. Literata.']].map(([k, l, d]) => `<button class="look" data-look="${k}" aria-pressed="${settings.style === k}"><span class="look-swatch look-${k}" aria-hidden="true"><i></i><i></i><i></i></span><span class="look-name">${l}</span><span class="look-desc">${d}</span></button>`).join('')}
				</div>
			</div>
			<div class="field"><span>Chiaro o scuro</span>${seg('theme', settings.theme, [['auto', 'Automatico'], ['light', 'Chiaro'], ['dark', 'Scuro']])}</div>
			<div class="field"><span>Dimensione del testo</span>${seg('size', settings.size, [['s', 'Piccolo'], ['m', 'Normale'], ['l', 'Grande'], ['xl', 'Molto grande']])}</div>

			<h2>Intelligenza artificiale (facoltativa)</h2>
			<p class="help">Un modello può scrivere il riassunto delle notizie del giorno e un TL;DR in italiano per ogni articolo. Con un modello locale (Ollama, LM Studio, llama.cpp) nulla esce dal tuo computer; con un servizio esterno le notizie vengono inviate a quel servizio con la tua chiave.</p>
			<label class="field"><span>Motore</span>
				<select class="input" id="preset">
					<option value="">Disattivata</option>
					${Object.entries(AI.PRESETS).map(([k, p]) => `<option value="${k}" ${presetKey === k ? 'selected' : ''}>${esc(p.label)}</option>`).join('')}
				</select>
			</label>
			<div id="ai-fields" ${presetKey ? '' : 'hidden'}>
				<p class="help" id="ai-help">${preset?.help || ''}</p>
				<div id="device-fields" ${ai.provider === 'webllm' ? '' : 'hidden'}>
					<p class="status" id="gpu-status" role="status"></p>
					<div class="field"><span>Modello</span>
						${WebLLM.MODELS.map((m) => `<label class="row model-row"><input type="radio" name="wmodel" value="${m.id}" ${ai.model === m.id ? 'checked' : ''}><span class="grow">${esc(m.label)}<small>${m.size}</small><small class="ok" data-cached="${m.id}"></small><span class="sub">${esc(m.note)}</span></span></label>`).join('')}
					</div>
					<progress id="wprog" max="1" value="0" hidden></progress>
				</div>
				<div id="remote-fields" ${ai.provider === 'webllm' ? 'hidden' : ''}>
				<label class="field"><span>Indirizzo</span><input class="input" id="base" value="${esc(ai.base)}" placeholder="http://localhost:11434/v1" inputmode="url" autocomplete="off"></label>
				<label class="field"><span>Modello</span>
					<div style="display:flex;gap:0.5rem"><input class="input" id="model" list="models" value="${esc(ai.model)}" placeholder="es. llama3.2" autocomplete="off"><button class="btn small" id="list" type="button">Elenca</button></div>
					<datalist id="models"></datalist>
				</label>
				<label class="field" id="key-field" ${preset?.key ? '' : 'hidden'}><span>Chiave API</span><input class="input" id="key" type="password" value="${esc(ai.key)}" autocomplete="off" placeholder="Resta solo su questo dispositivo"></label>
				</div>
				<label class="row"><input type="checkbox" id="auto" ${ai.auto ? 'checked' : ''}><span class="grow">Crea il TL;DR appena apro un articolo</span></label>
				<div id="max-field" ${ai.provider === 'webllm' ? 'hidden' : ''}>
				<label class="field" style="margin-top:0.75rem"><span>Notizie da includere nel riassunto del giorno</span><input class="input" id="max" type="number" min="10" max="400" step="10" value="${esc(ai.maxItems)}" style="max-width:8rem"></label>
				<p class="help">I modelli locali piccoli hanno un contesto limitato: se il riassunto si interrompe, abbassa questo numero o aumenta il contesto del modello.</p>
				</div>
				<div class="actions" style="margin-top:0.75rem">
					<button class="btn" id="test" type="button">${ai.provider === 'webllm' ? 'Scarica e prova' : 'Prova la connessione'}</button>
					<button class="btn" id="wdel" type="button" ${ai.provider === 'webllm' ? '' : 'hidden'}>Elimina il modello</button>
				</div>
				<p class="status" id="ai-status" role="status"></p>
			</div>

			<h2>Proxy per le fonti personali</h2>
			<p class="help">Facoltativo e disattivato. Serve solo per i feed RSS aggiunti a mano che il browser non può leggere direttamente. Attenzione: il proxy vede quali feed leggi. Usa un proxy tuo, se possibile (ad esempio un Cloudflare Worker). Scrivi il prefisso dell'indirizzo oppure usa <code>{url}</code> come segnaposto.</p>
			<label class="field"><span>Indirizzo del proxy</span><input class="input" id="proxy" value="${esc(settings.proxy)}" placeholder="https://mio-proxy.workers.dev/?url={url}" inputmode="url" autocomplete="off"></label>

			<h2>I tuoi dati</h2>
			<p class="help">Fonti e preferenze stanno solo in questo browser. Esportale per spostarle su un altro dispositivo (la chiave API non viene esportata).</p>
			<div class="actions" style="margin-top:0">
				<button class="btn" id="export">Esporta</button>
				<label class="btn">Importa<input type="file" id="import" accept="application/json,.json" hidden></label>
				<button class="btn" id="reset">Cancella tutto</button>
			</div>

			<h2>Come funziona</h2>
			<p class="help">Ogni mezz'ora un'azione automatica su GitHub legge tutte le ${state.catalog.sources.length} fonti del catalogo e pubblica un unico pacchetto di notizie. Il tuo dispositivo scarica sempre il pacchetto intero e filtra le fonti in locale: né GitHub né i giornali sanno quali fonti segui. Si tengono solo le notizie degli ultimi tre giorni, quindi non si accumula nulla. Nessun cookie, nessuna statistica, nessun account.</p>
			<p class="foot">${state.news?.at ? `Ultimo aggiornamento: ${esc(fmtLong(state.news.at))}. ` : ''}${okCount ? `Fonti raggiungibili: ${okCount} su ${state.catalog.sources.length}. ` : ''}<br>Codice sorgente: <a href="https://github.com/claudioaccolito/news" target="_blank" rel="noopener">github.com/claudioaccolito/news</a></p>
		</section>`;

	for (const b of $$('[data-theme]')) {
		b.addEventListener('click', () => {
			settings.theme = b.dataset.theme;
			save();
			applyLook();
			for (const o of $$('[data-theme]')) o.setAttribute('aria-pressed', o === b);
		});
	}
	for (const b of $$('[data-look]')) {
		b.addEventListener('click', () => {
			settings.style = b.dataset.look;
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

	const status = $('#ai-status');
	const isDevice = () => ai.provider === 'webllm';
	const syncAi = () => {
		ai.base = $('#base').value.trim();
		ai.model = isDevice() ? ($('[name="wmodel"]:checked')?.value || WebLLM.MODELS[0].id) : $('#model').value.trim();
		ai.key = $('#key').value.trim();
		ai.auto = $('#auto').checked;
		ai.maxItems = Math.max(10, Math.min(400, Number($('#max').value) || 60));
		save();
		setNav('/impostazioni');
	};
	$('#preset').addEventListener('change', (e) => {
		const k = e.target.value;
		const p = AI.PRESETS[k];
		ai.preset = k;
		ai.provider = p ? p.provider : 'none';
		if (p) {
			$('#base').value = p.base;
			$('#model').value = p.provider === 'webllm' ? '' : p.model;
			$('#ai-help').innerHTML = p.help;
			$('#key-field').hidden = !p.key;
			if (!p.key) $('#key').value = '';
		}
		$('#ai-fields').hidden = !p;
		for (const [id, show] of [['device-fields', isDevice()], ['wdel', isDevice()], ['remote-fields', !isDevice()], ['max-field', !isDevice()]]) $(`#${id}`).hidden = !show;
		$('#test').textContent = isDevice() ? 'Scarica e prova' : 'Prova la connessione';
		status.textContent = '';
		syncAi();
		const radio = $(`[name="wmodel"][value="${ai.model}"]`);
		if (radio) radio.checked = true;
		if (isDevice()) refreshDevice();
	});
	for (const r of $$('[name="wmodel"]')) r.addEventListener('change', syncAi);

	async function refreshDevice() {
		const gpu = $('#gpu-status');
		if (!gpu) return;
		const sup = await WebLLM.support();
		gpu.className = `status ${sup.ok ? 'ok' : 'err'}`;
		gpu.textContent = sup.ok ? `WebGPU disponibile${sup.f16 ? '' : ' (senza 16 bit: userò la versione a 32 bit, più pesante)'}.` : sup.why;
		$('#test').disabled = !sup.ok;
		if (!sup.ok) return;
		for (const m of WebLLM.MODELS) {
			const el = $(`[data-cached="${m.id}"]`);
			if (el) el.textContent = (await WebLLM.isCached(m.id)) ? 'scaricato' : '';
		}
	}
	if (isDevice()) refreshDevice();

	$('#wdel').addEventListener('click', async () => {
		syncAi();
		try {
			await WebLLM.remove(ai.model);
			toast('Modello eliminato dal dispositivo');
		} catch (e) {
			toast(`Non riesco a eliminarlo: ${e.message}`);
		}
		refreshDevice();
	});
	for (const id of ['base', 'model', 'key', 'max']) $(`#${id}`).addEventListener('change', syncAi);
	$('#auto').addEventListener('change', syncAi);

	$('#list').addEventListener('click', async () => {
		syncAi();
		status.className = 'status';
		status.textContent = 'Chiedo l\'elenco dei modelli…';
		try {
			const models = await AI.listModels(ai);
			$('#models').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
			status.className = 'status ok';
			status.textContent = models.length ? `${models.length} modelli disponibili: ${models.slice(0, 6).join(', ')}${models.length > 6 ? '…' : ''}` : 'Nessun modello trovato.';
			if (!ai.model && models[0]) { $('#model').value = models[0]; syncAi(); }
		} catch (e) {
			status.className = 'status err';
			status.textContent = e.message;
		}
	});
	$('#test').addEventListener('click', async () => {
		syncAi();
		status.className = 'status';
		status.textContent = 'Provo…';
		try {
			const prog = $('#wprog');
			const r = await AI.complete(ai, AI.SYSTEM, 'Rispondi solo con: Funziona!', (t) => { status.textContent = t; }, undefined, (pr) => {
				prog.hidden = false;
				prog.value = pr.progress || 0;
				status.textContent = progressText(pr);
			});
			prog.hidden = true;
			if (isDevice()) refreshDevice();
			status.className = 'status ok';
			status.textContent = `Risposta: ${truncate(r, 120)}`;
		} catch (e) {
			$('#wprog').hidden = true;
			status.className = 'status err';
			status.textContent = e.message;
		}
	});

	$('#proxy').addEventListener('change', (e) => { settings.proxy = e.target.value.trim(); save(); });

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
