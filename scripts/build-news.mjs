#!/usr/bin/env node
// Fetches every feed in data/catalog.json and writes a compact, privacy-friendly bundle:
//   <out>/news.json            list of recent items (title, short description, date, source)
//   <out>/content/<0-f>.json   longer text of each item, sharded by id so that opening an
//                              article does not reveal which source you read.
// Zero dependencies, Node >= 20.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseFeed, truncate, dedupeStories } from '../js/feed-parser.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = process.argv[2] || join(ROOT, '_site', 'data');

const MAX_AGE_MS = 72 * 3600e3;   // keep three days of news
const MAX_PER_SOURCE = 30;
const DESC_LEN = 280;
const CONTENT_LEN = 20000;
const TIMEOUT_MS = 20000;
const CONCURRENCY = 16;
const MIN_ITEMS = 3;                 // slow blogs: keep their latest posts…
const MIN_ITEMS_AGE_MS = 21 * 864e5; // …if published in the last three weeks
// First an honest feed-reader identity, then a browser-like one for sites that block unknown agents.
const ATTEMPTS = [
  { ua: 'Edicola/1.0 (RSS reader; +https://github.com/claudioaccolito/news)', accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5' },
  { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', accept: '*/*' }
];

export const idOf = (link) => createHash('sha1').update(link).digest('hex').slice(0, 12);

function decode(buf, contentType) {
  const bytes = new Uint8Array(buf);
  let charset = (contentType || '').match(/charset=([\w-]+)/i)?.[1];
  if (!charset) {
    const head = new TextDecoder('latin1').decode(bytes.slice(0, 200));
    charset = head.match(/encoding=["']([\w-]+)["']/i)?.[1];
  }
  try { return new TextDecoder((charset || 'utf-8').toLowerCase()).decode(bytes); }
  catch { return new TextDecoder('utf-8').decode(bytes); }
}

async function fetchOnce(url, { ua, accept }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': ua, accept } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = decode(await res.arrayBuffer(), res.headers.get('content-type'));
    if (!/<(rss|feed|rdf:RDF)[\s>]/i.test(text)) throw new Error('not a feed');
    return text;
  } catch (e) {
    throw e.name === 'AbortError' ? new Error('timeout') : e;
  } finally {
    clearTimeout(timer);
  }
}

// Tries every URL of the source with every identity; returns the first parsable feed.
async function fetchFeed(src) {
  let last;
  for (const url of [src.url, ...(src.alt || [])]) {
    for (const a of ATTEMPTS) {
      try { return await fetchOnce(url, a); } catch (e) { last = e; }
    }
  }
  throw last;
}

async function pool(list, n, fn) {
  const out = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k], k); }
  }));
  return out;
}

async function main() {
  const catalog = JSON.parse(await readFile(join(ROOT, 'data', 'catalog.json'), 'utf8'));
  const now = Date.now();
  const status = {};
  const stale = [];
  const items = [];
  const shards = Array.from({ length: 16 }, () => ({}));

  await pool(catalog.sources, CONCURRENCY, async (src) => {
    let xml;
    try {
      xml = await fetchFeed(src);
    } catch (e) {
      status[src.id] = String(e.message || e).slice(0, 80);
      return;
    }
    let parsed;
    try { parsed = parseFeed(xml); } catch (e) { status[src.id] = 'parse error'; return; }
    if (!parsed.items.length) { status[src.id] = 'no items'; return; }

    const dated = parsed.items
      .filter((it) => it.date > 0)
      .map((it) => ({ ...it, date: Math.min(it.date, now) }))
      .sort((a, b) => b.date - a.date);
    let fresh = dated.filter((it) => now - it.date <= MAX_AGE_MS).slice(0, MAX_PER_SOURCE);
    if (fresh.length < MIN_ITEMS) fresh = dated.filter((it) => now - it.date <= MIN_ITEMS_AGE_MS).slice(0, MIN_ITEMS);

    const undated = parsed.items.length - dated.length;
    status[src.id] = fresh.length || (dated.length ? 0 : undated ? 'no dates' : 0);
    if (!fresh.length) {
      const newest = dated[0] ? new Date(dated[0].date).toISOString().slice(0, 10) : '-';
      stale.push(`${src.id}: newest ${newest} (${parsed.items.length} items)`);
    }

    for (const it of fresh) {
      const id = idOf(it.link);
      let summary = it.summary && it.summary !== it.title ? it.summary : '';
      const long = it.content.length > summary.length ? it.content : summary;
      if (!summary) summary = it.content;
      const item = { id, s: src.id, t: it.title, p: it.date, u: it.link };
      const d = truncate(summary.replace(/\s*\n+\s*/g, ' '), DESC_LEN);
      if (d) item.d = d;
      if (it.author) item.a = it.author;
      if (long.length > d.length + 40) {
        shards[parseInt(id[0], 16)][id] = truncate(long, CONTENT_LEN);
        item.c = 1;
      }
      items.push(item);
    }
  });

  items.sort((a, b) => b.p - a.p);
  // Same story published several times by one source (flash, update, "(2)"): keep one.
  const bySource = new Map();
  for (const it of items) (bySource.get(it.s) || bySource.set(it.s, []).get(it.s)).push(it);
  const before = items.length;
  items.length = 0;
  for (const list of bySource.values()) items.push(...dedupeStories(list));
  items.sort((a, b) => b.p - a.p);
  console.log(`Duplicates removed: ${before - items.length}`);
  await mkdir(join(OUT, 'content'), { recursive: true });
  await writeFile(join(OUT, 'news.json'), JSON.stringify({ v: 1, at: now, status, items }));
  await Promise.all(shards.map((s, i) => writeFile(join(OUT, 'content', `${i.toString(16)}.json`), JSON.stringify(s))));

  const failed = Object.entries(status).filter(([, v]) => typeof v !== 'number' || v === 0);
  const size = Buffer.byteLength(JSON.stringify({ items }));
  console.log(`Sources: ${catalog.sources.length}, ok: ${catalog.sources.length - failed.length}, items: ${items.length}, news.json ≈ ${(size / 1024).toFixed(0)} KB`);
  if (failed.length) {
    console.log('Sources without fresh items:');
    for (const [id, why] of failed) console.log(`  - ${id}: ${why}`);
  }
  if (stale.length) console.log('Stale feeds:\n  ' + stale.join('\n  '));
}

main().catch((e) => { console.error(e); process.exit(1); });
