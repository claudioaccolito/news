// Tolerant RSS / Atom / RDF parser with zero dependencies.
// Used both by the GitHub Action (Node) and by the browser for custom feeds.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  laquo: '«', raquo: '»', egrave: 'è', eacute: 'é', agrave: 'à', aacute: 'á',
  igrave: 'ì', iacute: 'í', ograve: 'ò', oacute: 'ó', ugrave: 'ù', uacute: 'ú',
  Egrave: 'È', Eacute: 'É', Agrave: 'À', Igrave: 'Ì', Ograve: 'Ò', Ugrave: 'Ù',
  ccedil: 'ç', ntilde: 'ñ', uuml: 'ü', ouml: 'ö', auml: 'ä', szlig: 'ß',
  euro: '€', copy: '©', reg: '®', trade: '™', deg: '°', middot: '·', bull: '•',
  times: '×', shy: '', zwj: '', zwnj: '', lrm: '', rlm: ''
};

export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s || '';
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : ''; } catch { return ''; }
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e) ? ENTITIES[e] : m;
  });
}

function unwrapCdata(s) {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

// Raw inner XML of the first matching tag (namespace prefix optional).
function tag(xml, names) {
  for (const name of names) {
    const re = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i');
    const m = xml.match(re);
    if (m) return m[1];
  }
  return '';
}

function attr(xmlTag, name) {
  const m = xmlTag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? '') : '';
}

function textOf(raw) {
  // Value of an XML text node: CDATA unwrapped, entities decoded once.
  const hasCdata = raw.includes('<![CDATA[');
  let s = unwrapCdata(raw);
  if (!hasCdata) s = decodeEntities(s);
  return s.trim();
}

// HTML fragment -> readable plain text with paragraph breaks.
export function htmlToText(html) {
  if (!html) return '';
  let s = html
    .replace(/<(script|style|iframe|figure|figcaption|noscript|svg|video|audio|picture|form|button)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|blockquote|section|article|tr|ul|ol|pre)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  s = decodeEntities(s)
    .replace(/ /g, ' ')
    .replace(/[ \t\f\v\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return s;
}

// Key that is equal for re-publications of the same story: agencies such as ANSA post
// "++ Title ++" as a flash, then "Title", then "Title (2)" with different links.
export function storyKey(title) {
	return String(title || '')
		.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/\+\+/g, ' ')
		.replace(/\(\s*\d+\s*\)\s*$/, ' ')
		.replace(/\b(ultim'?ora|ultima ora|breaking|live|video|foto|aggiornamento|aggiornato|update[ds]?)\b/g, ' ')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

// Among items about the same story keep one: the most informative text, the latest time.
// Items must be sorted newest first; their order is kept.
export function dedupeStories(items) {
	const byKey = new Map();
	const out = [];
	for (const it of items) {
		const key = storyKey(it.t);
		if (key.length < 12) { out.push(it); continue; }
		const i = byKey.get(key);
		if (i === undefined) { byKey.set(key, out.length); out.push(it); continue; }
		const kept = out[i];
		const better = (it.c && !kept.c) || (it.d || '').length > (kept.d || '').length + 20;
		if (better) out[i] = { ...it, p: Math.max(it.p, kept.p), t: cleanTitleMarks(it.t) };
	}
	return out.map((it) => (/\+\+|\(\s*\d+\s*\)\s*$/.test(it.t) ? { ...it, t: cleanTitleMarks(it.t) } : it));
}

function cleanTitleMarks(t) {
	return t.replace(/\+\+/g, '').replace(/\s*\(\s*\d+\s*\)\s*$/, '').replace(/\s{2,}/g, ' ').trim();
}

export function truncate(s, max) {
  if (!s || s.length <= max) return s || '';
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–—-]+$/, '') + '…';
}

function parseDate(s) {
  if (!s) return 0;
  s = s.trim();
  let t = Date.parse(s);
  if (Number.isNaN(t)) {
    // Common non-RFC variants: Italian month names, missing timezone, etc.
    const it = { gen: 'Jan', feb: 'Feb', mar: 'Mar', apr: 'Apr', mag: 'May', giu: 'Jun', lug: 'Jul', ago: 'Aug', set: 'Sep', ott: 'Oct', nov: 'Nov', dic: 'Dec' };
    const fixed = s.replace(/\b(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)[a-z]*\b/i, (m, k) => it[k.toLowerCase()])
      .replace(/\b(lun|mar|mer|gio|ven|sab|dom)[a-z]*,?\s*/i, '')
      .replace(/\s+(CEST|CET)$/i, (m, z) => (z.toUpperCase() === 'CEST' ? ' +0200' : ' +0100'));
    t = Date.parse(fixed);
  }
  return Number.isNaN(t) ? 0 : t;
}

// Boilerplate many CMSs append to summaries.
const NOISE = [
  /^(Article URL|Comments URL|Points|# Comments):.*$/gim,
  /The post .{1,300}? appeared first on .{1,120}?\.?$/gim,
  /L['’]articolo .{1,300}? (proviene da|sembra essere il primo su) .{1,120}?\.?$/gim,
  /\b(Continua a leggere|Leggi tutto|Read more|Continue reading)\b.{0,80}$/gim,
  /\[(…|\.\.\.)\]\s*$/g
];

export function cleanSummary(s) {
  let out = s || '';
  for (const re of NOISE) out = out.replace(re, '');
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function cleanTitle(s) {
  return htmlToText(s).replace(/\s+/g, ' ').trim();
}

function linkOf(block) {
  // Atom: <link rel="alternate" href="..."/>; RSS: <link>url</link>
  const links = block.match(/<link\b[^>]*\/?>/gi) || [];
  let href = '';
  for (const l of links) {
    const h = attr(l, 'href');
    if (!h) continue;
    const rel = attr(l, 'rel');
    if (!rel || rel === 'alternate') { href = h; break; }
    if (!href) href = h;
  }
  if (href) return href;
  const rss = tag(block, ['link']);
  if (rss) return textOf(rss);
  const guid = block.match(/<guid(?:\s[^>]*)?>([\s\S]*?)<\/guid>/i);
  if (guid && !/isPermaLink\s*=\s*["']false/i.test(guid[0])) {
    const g = textOf(guid[1]);
    if (/^https?:/i.test(g)) return g;
  }
  return '';
}

function authorOf(block) {
  let a = tag(block, ['dc:creator', 'author', 'itunes:author']);
  if (!a) return '';
  const name = tag(a, ['name']);
  if (name) a = name;
  a = cleanTitle(textOf(a));
  // RSS <author> is often "email (Name)"
  const m = a.match(/^\S+@\S+\s*\((.+)\)$/);
  if (m) a = m[1];
  if (/^\S+@\S+$/.test(a)) return '';
  return a.slice(0, 120);
}

/**
 * Parse a feed document.
 * Returns { title, items: [{ title, link, date (ms), author, summary (text), content (text) }] }
 */
export function parseFeed(xml) {
  if (typeof xml !== 'string') xml = String(xml || '');
  // Strip the XML prolog/doctype to keep regexes simple.
  xml = xml.replace(/^﻿/, '');
  const isAtom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const blockRe = isAtom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi;
  const head = xml.split(isAtom ? /<entry[\s>]/i : /<item[\s>]/i)[0] || '';
  const feedTitle = cleanTitle(textOf(tag(head, ['title'])));
  const items = [];
  for (const block of xml.match(blockRe) || []) {
    const title = cleanTitle(textOf(tag(block, ['title'])));
    const link = linkOf(block).trim();
    if (!title || !link) continue;
    const date = parseDate(textOf(tag(block, ['pubDate', 'published', 'dc:date', 'updated', 'a10:updated', 'lastBuildDate'])));
    const rawSummary = textOf(tag(block, ['description', 'summary', 'media:description', 'itunes:summary']));
    const rawContent = textOf(tag(block, ['content:encoded', 'content']));
    const summary = cleanSummary(htmlToText(rawSummary));
    const content = cleanSummary(htmlToText(rawContent));
    items.push({ title, link, date, author: authorOf(block), summary, content });
  }
  return { title: feedTitle, items };
}
