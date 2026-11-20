// Optional on-device AI with WebLLM (WebGPU). Nothing here is downloaded unless the user
// turns it on: the library comes from a pinned CDN build, the model weights from Hugging Face,
// and both are then cached by the browser. Inference runs in a Web Worker, fully offline.

export const LIB = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.87/+esm';

export const MODELS = [
	{ id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1,5 miliardi', size: '≈ 1 GB', note: 'consigliato: il migliore in italiano tra i piccoli' },
	{ id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1 miliardo', size: '≈ 700 MB', note: 'veloce, italiano discreto' },
	{ id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 0,5 miliardi', size: '≈ 400 MB', note: 'leggerissimo, per telefoni con poca memoria' },
	{ id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 · 2 miliardi', size: '≈ 1,4 GB', note: 'più qualità, più lento; per PC o telefoni recenti' }
];

// Recap prompts must fit the model's 4096-token context.
export const RECAP_LIMIT = { items: 35, desc: 90 };

let libPromise = null;
let engine = null;       // { id, promise }
let f16 = null;

const lib = () => (libPromise ??= import(LIB).catch((e) => { libPromise = null; throw e; }));

export async function support() {
	if (!('gpu' in navigator)) return { ok: false, why: 'Questo browser non supporta WebGPU. Usa Chrome o Edge aggiornati (su Android serve Chrome 121 o successivo).' };
	try {
		const adapter = await navigator.gpu.requestAdapter();
		if (!adapter) return { ok: false, why: 'WebGPU è presente ma non trova una GPU utilizzabile su questo dispositivo.' };
		f16 = adapter.features.has('shader-f16');
		return { ok: true, f16 };
	} catch (e) {
		return { ok: false, why: `WebGPU non disponibile: ${e.message}` };
	}
}

// Devices without 16-bit float shaders need the f32 build of the same model.
async function resolveId(id) {
	if (f16 === null) await support();
	return f16 === false ? id.replace('q4f16_1', 'q4f32_1') : id;
}

export async function isCached(id) {
	try {
		const w = await lib();
		return await w.hasModelInCache(await resolveId(id));
	} catch {
		return false;
	}
}

export async function remove(id) {
	const w = await lib();
	const real = await resolveId(id);
	if (engine?.id === real) await unload();
	await w.deleteModelAllInfoInCache(real);
}

export async function unload() {
	const e = engine;
	engine = null;
	if (e) try { (await e.promise).unload(); } catch {}
}

const listeners = new Set();

// Loads (and on first use downloads) the model. onProgress({ progress: 0..1, text }).
export async function load(id, onProgress) {
	const real = await resolveId(id);
	if (onProgress) listeners.add(onProgress);
	try {
		if (engine?.id !== real) {
			await unload();
			const w = await lib();
			const worker = new Worker(new URL('./webllm-worker.js', import.meta.url), { type: 'module' });
			engine = {
				id: real,
				promise: w.CreateWebWorkerMLCEngine(worker, real, {
					initProgressCallback: (r) => { for (const l of listeners) l(r); }
				}).catch((e) => { engine = null; worker.terminate(); throw e; })
			};
		}
		return await engine.promise;
	} finally {
		if (onProgress) listeners.delete(onProgress);
	}
}

export async function complete(id, system, user, onText, signal, onProgress) {
	const eng = await load(id, onProgress);
	if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
	const stop = () => eng.interruptGenerate();
	signal?.addEventListener('abort', stop, { once: true });
	try {
		const chunks = await eng.chat.completions.create({
			messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
			stream: true,
			temperature: 0.3,
			max_tokens: 900
		});
		let text = '';
		for await (const c of chunks) {
			const piece = c.choices?.[0]?.delta?.content;
			if (piece) { text += piece; onText?.(text); }
		}
		if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
		return text.trim();
	} finally {
		signal?.removeEventListener('abort', stop);
	}
}
