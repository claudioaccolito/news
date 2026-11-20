// Optional AI: local models (Ollama, LM Studio, llama.cpp) through the OpenAI-compatible API,
// or a cloud API with the user's own key. Calls go straight from the browser to the endpoint.

import * as WebLLM from './webllm.js';

export const PRESETS = {
	device: {
		label: 'Nel dispositivo (WebLLM, sperimentale)', provider: 'webllm', base: '', model: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', key: false,
		help: 'Il modello gira dentro il browser con la GPU del dispositivo (WebGPU), anche offline: nulla esce dal telefono o dal PC. Si scarica una volta e resta salvato; dopo un minuto e mezzo di inattività viene tolto dalla memoria.'

	},
	ollama: {
		label: 'Ollama (locale)', provider: 'openai', base: 'http://localhost:11434/v1', model: 'llama3.2', key: false,
		help: 'Avvia Ollama permettendo a questa pagina di contattarlo: <code>OLLAMA_ORIGINS="https://claudioaccolito.github.io" ollama serve</code>. Poi scarica un modello, ad esempio <code>ollama pull llama3.2</code> o <code>ollama pull qwen2.5:7b</code>.'
	},
	lmstudio: {
		label: 'LM Studio (locale)', provider: 'openai', base: 'http://localhost:1234/v1', model: '', key: false,
		help: 'In LM Studio apri «Developer», avvia il server e attiva «Enable CORS».'
	},
	llamacpp: {
		label: 'llama.cpp server (locale)', provider: 'openai', base: 'http://localhost:8080/v1', model: '', key: false,
		help: 'Avvia <code>llama-server -m modello.gguf --port 8080</code>. Il server accetta richieste dal browser.'
	},
	openai: {
		label: 'OpenAI', provider: 'openai', base: 'https://api.openai.com/v1', model: '', key: true,
		help: 'Serve una chiave API. Le notizie vengono inviate a OpenAI.'
	},
	anthropic: {
		label: 'Anthropic (Claude)', provider: 'anthropic', base: 'https://api.anthropic.com', model: 'claude-haiku-5-5', key: true,
		help: 'Serve una chiave API. Le notizie vengono inviate ad Anthropic.'
	},
	openrouter: {
		label: 'OpenRouter', provider: 'openai', base: 'https://openrouter.ai/api/v1', model: '', key: true,
		help: 'Una chiave per centinaia di modelli, anche gratuiti. Le notizie vengono inviate a OpenRouter.'
	},
	custom: {
		label: 'Altro endpoint compatibile OpenAI', provider: 'openai', base: '', model: '', key: true,
		help: 'Qualsiasi servizio che espone <code>/chat/completions</code> (Groq, Mistral, Together, un server tuo…).'
	}
};

// Hard limits on what goes in and out of the model, so a 90-page article or a day with
// 500 news never overloads the device. Characters ≈ 3.5 per token in Italian.
export const LIMITS = {
	webllm: { articleChars: 4500, topics: 5, perTopic: 6, descChars: 90, tldrTokens: 220, topicTokens: 260, recapItems: 30, recapTokens: 600 },
	local: { articleChars: 12000, topics: 8, perTopic: 8, descChars: 160, tldrTokens: 400, topicTokens: 400, recapItems: 64, recapTokens: 1200 },
	online: { articleChars: 30000, topics: 0, perTopic: 0, descChars: 160, tldrTokens: 500, topicTokens: 500, recapItems: 150, recapTokens: 1500 }
};
export const limitsFor = (ai) => LIMITS[ai.provider === 'webllm' ? 'webllm' : isLocal(ai) ? 'local' : 'online'];

export const isEnabled = (ai) => ai.provider === 'webllm' ? !!ai.model : ai.provider !== 'none' && !!ai.base;
export const isLocal = (ai) => ai.provider === 'webllm' || /localhost|127\.0\.0\.1|\[::1\]/.test(ai.base);

const trimSlash = (s) => (s || '').replace(/\/+$/, '');

function headersFor(ai) {
	if (ai.provider === 'anthropic') {
		return {
			'content-type': 'application/json',
			'x-api-key': ai.key,
			'anthropic-version': '2023-06-01',
			'anthropic-dangerous-direct-browser-access': 'true'
		};
	}
	const h = { 'content-type': 'application/json' };
	if (ai.key) h.authorization = `Bearer ${ai.key}`;
	return h;
}

async function explain(res) {
	let msg = `HTTP ${res.status}`;
	try {
		const j = await res.json();
		msg += ': ' + (j.error?.message || j.message || JSON.stringify(j)).slice(0, 200);
	} catch {}
	return new Error(msg);
}

function networkError(e, ai) {
	if (e.name === 'AbortError') return e;
	const local = /localhost|127\.0\.0\.1|\[::1\]/.test(ai.base);
	return new Error(local
		? 'Impossibile contattare il modello locale. È avviato? Ha il CORS abilitato per questa pagina?'
		: `Impossibile contattare ${ai.base}. Controlla indirizzo e connessione.`);
}

export async function listModels(ai) {
	let res;
	try {
		res = await fetch(`${trimSlash(ai.base)}${ai.provider === 'anthropic' ? '/v1/models' : '/models'}`, { headers: headersFor(ai) });
	} catch (e) {
		throw networkError(e, ai);
	}
	if (!res.ok) throw await explain(res);
	const j = await res.json();
	return (j.data || j.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
}

// Streams the answer, calling onText(fullTextSoFar) as tokens arrive. Resolves with the final text.
// Repainting on every token keeps the main thread (and a phone's GPU) busy: at most ~8 updates/s.
function throttle(fn, ms = 120) {
	if (!fn) return null;
	let last = 0, timer = null, pending;
	const out = (v) => {
		pending = v;
		const now = Date.now();
		if (now - last >= ms) { last = now; fn(v); return; }
		clearTimeout(timer);
		timer = setTimeout(() => { last = Date.now(); fn(pending); }, ms - (now - last));
	};
	out.flush = () => { clearTimeout(timer); };
	return out;
}

export async function complete(ai, system, user, onText, signal, onProgress, maxTokens) {
	const paint = throttle(onText);
	try {
		return await completeRaw(ai, system, user, paint, signal, onProgress, maxTokens);
	} finally {
		paint?.flush();
	}
}

async function completeRaw(ai, system, user, onText, signal, onProgress, maxTokens) {
	if (ai.provider === 'webllm') {
		const text = await WebLLM.complete(ai.model, system, user, (t) => onText?.(stripThinking(t)), signal, onProgress, maxTokens);
		return stripThinking(text).trim();
	}
	const anthropic = ai.provider === 'anthropic';
	const url = anthropic ? `${trimSlash(ai.base)}/v1/messages` : `${trimSlash(ai.base)}/chat/completions`;
	const body = anthropic
		? { model: ai.model, max_tokens: maxTokens || 1500, system, messages: [{ role: 'user', content: user }], stream: true }
		: { model: ai.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], stream: true, temperature: 0.3, max_tokens: maxTokens || 1500 };

	let res;
	try {
		res = await fetch(url, { method: 'POST', headers: headersFor(ai), body: JSON.stringify(body), signal });
	} catch (e) {
		throw networkError(e, ai);
	}
	if (!res.ok) throw await explain(res);

	const reader = res.body.getReader();
	const dec = new TextDecoder();
	let buf = '';
	let text = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		let nl;
		while ((nl = buf.indexOf('\n')) >= 0) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (!line.startsWith('data:')) continue;
			const data = line.slice(5).trim();
			if (!data || data === '[DONE]') continue;
			let j;
			try { j = JSON.parse(data); } catch { continue; }
			if (j.error) throw new Error(j.error.message || 'Errore del modello');
			const piece = anthropic
				? (j.type === 'content_block_delta' ? j.delta?.text : '')
				: (j.choices?.[0]?.delta?.content ?? j.choices?.[0]?.text ?? '');
			if (piece) {
				text += piece;
				onText?.(stripThinking(text));
			}
		}
	}
	return stripThinking(text).trim();
}

// Reasoning models (deepseek-r1, qwq…) emit <think>…</think> before the answer.
function stripThinking(s) {
	return s.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trimStart();
}

export const SYSTEM = 'Sei un giornalista italiano esperto e preciso. Scrivi sempre in italiano chiaro e scorrevole. Non inventare fatti: usa solo le informazioni fornite. Rispondi direttamente, senza preamboli.';

export function tldrPrompt(item, sourceName, text) {
	return `Scrivi un TL;DR in italiano (2-4 frasi, massimo 80 parole) dell'articolo seguente. Se è in un'altra lingua, riassumilo comunque in italiano.

Titolo: ${item.t}
Fonte: ${sourceName}
Data: ${new Date(item.p).toLocaleString('it-IT')}

Testo:
${text || item.d || ''}`;
}

// One prompt for capable models (online services).
export function recapPrompt(lines, label) {
	return `Queste sono le notizie di oggi${label ? ` (${label})` : ''}. Ogni riga: titolo (fonte) e, se c'è, una breve descrizione.

${lines.join('\n')}

Scrivi in italiano un resoconto della giornata.
- Raggruppa le notizie per tema. Ogni tema ha un titolo breve preceduto da "### " (per esempio "### Politica").
- Sotto ogni tema scrivi da 2 a 5 punti elenco che iniziano con "- ". Ogni punto è una frase sola, riformulata con parole tue, senza copiare il titolo.
- Metti in **grassetto** solo le 2-4 parole chiave di ogni punto.
- Unisci in un solo punto le notizie sullo stesso fatto. Non scrivere i nomi delle fonti.
- Ordina i temi per importanza.
- Chiudi con una riga che inizia con "**In breve:**" e una o due frasi sul quadro generale.`;
}

// Small local models do much better with one short task at a time: one topic per request,
// a concrete example of the format, and nothing to copy.
export function topicPrompt(topic, lines) {
	return `Notizie di oggi su ${topic}:

${lines.join('\n')}

Scrivi da 2 a 4 punti elenco in italiano che riassumono queste notizie.
Regole:
- ogni punto inizia con "- " ed è una sola frase di massimo 25 parole;
- se più notizie parlano dello stesso fatto, uniscile in un solo punto;
- riformula con parole tue: non copiare i titoli, non scrivere numeri, titoli o nomi delle fonti;
- scrivi solo i punti elenco, nient'altro.

Esempio di risposta:
- Il governo ha approvato la manovra, che ora passa al Parlamento.
- La Banca centrale europea lascia fermi i tassi ma apre a un taglio a gennaio.`;
}

// Keeps only the bullet lines of a small model's answer, without leftover labels or numbering.
export function cleanBullets(text, max = 4) {
	return text.split('\n')
		.map((l) => l.trim())
		.filter((l) => /^[-*•]\s+\S/.test(l))
		.map((l) => l
			.replace(/^[-*•]\s+/, '')
			.replace(/^\d+[.)]\s*/, '')
			.replace(/^\*\*[^*]{1,40}:\*\*\s*/, '')
			.replace(/^(fatto principale|notizia|titolo|fonte|preceduto|riassunto|sintesi)\s*:\s*/i, '')
			.replace(/#+/g, '')
			.trim())
		.filter((l) => l.length > 12)
		.map((l) => '- ' + l)
		.slice(0, max);
}

// Minimal, safe Markdown for model output.
// A typing cursor placed at the end of the last line (not on a line of its own).
export const CURSOR = '\u2063';
export function streamMarkdown(md) {
	return renderMarkdown(md + CURSOR).replace(CURSOR, '<span class="cursor"></span>');
}

export function renderMarkdown(md) {
	const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
	// While streaming, a bold marker may still be open: hide it until it closes.
	const balance = (s) => ((s.match(/\*\*/g) || []).length % 2 ? s.replace(/\*\*(?!.*\*\*)/, '') : s);
	const inline = (s) => esc(balance(s))
		.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
		.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, '$1<em>$2</em>')
		.replace(/`([^`]+)`/g, '<code>$1</code>');
	const out = [];
	let list = null;
	const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
	for (const raw of md.split('\n')) {
		const line = raw.trimEnd();
		let m;
		if (!line.trim()) { close(); continue; }
		if ((m = line.match(/^\s*#{1,6}\s+(.*)$/))) { close(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
		if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) {
			if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; }
			out.push(`<li>${inline(m[1])}</li>`); continue;
		}
		if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
			if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; }
			out.push(`<li>${inline(m[1])}</li>`); continue;
		}
		close();
		out.push(`<p>${inline(line)}</p>`);
	}
	close();
	return out.join('');
}
