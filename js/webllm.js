// Optional on-device AI with WebLLM (WebGPU). Nothing here is downloaded unless the user
// turns it on. The WebLLM library and the compiled GPU kernels ship with Edicola
// (vendor/web-llm, see its README); only the model weights come from huggingface.co/mlc-ai.
// Everything is cached by the browser; inference runs in a Web Worker, fully offline,
// and nothing about the news is ever sent anywhere.

export const LIB = new URL('../vendor/web-llm/web-llm.js', import.meta.url).href;
const LIBS = new URL('../vendor/web-llm/libs/', import.meta.url).href;

export const MODELS = [
	{ id: 'Qwen3-1.7B-q4f16_1-MLC', label: 'Qwen3 · 1,7 miliardi', size: '≈ 1 GB', note: 'il migliore in italiano tra i piccoli; un po\' più lento', thinking: true },
	{ id: 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 1,5 miliardi', size: '≈ 1 GB', note: 'buono in italiano, più leggero di Qwen3' },
	{ id: 'Llama-3.2-1B-Instruct-q4f16_1-MLC', label: 'Llama 3.2 · 1 miliardo', size: '≈ 700 MB', note: 'consigliato su telefono: buon equilibrio tra velocità e qualità' },
	{ id: 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', label: 'Qwen 2.5 · 0,5 miliardi', size: '≈ 400 MB', note: 'il più leggero, per telefoni con poca memoria' },
	{ id: 'gemma-2-2b-it-q4f16_1-MLC', label: 'Gemma 2 · 2 miliardi', size: '≈ 1,4 GB', note: 'più qualità, più lento; per PC o telefoni recenti' }
];

// Input and output limits for each kind of model: see LIMITS in ai.js.

// Free the GPU memory (1-2 GB) shortly after the last use, so the phone stays responsive.
const IDLE_UNLOAD_MS = 90 * 1000;
let idleTimer = null;
let busy = 0;
function scheduleUnload() {
	clearTimeout(idleTimer);
	idleTimer = setTimeout(() => { if (!busy) unload(); }, IDLE_UNLOAD_MS);
}

let libPromise = null;
let engine = null;       // { id, promise }
let f16 = null;

const lib = () => (libPromise ??= import(LIB).catch((e) => { libPromise = null; throw e; }));

// WebLLM's model list, pointed at our own copy of the GPU kernels for the models we offer.
let appConfigCache = null;
async function appConfig() {
	if (appConfigCache) return appConfigCache;
	const w = await lib();
	const ours = new Set(MODELS.flatMap((m) => [m.id, m.id.replace('q4f16_1', 'q4f32_1')]));
	appConfigCache = {
		...w.prebuiltAppConfig,
		model_list: w.prebuiltAppConfig.model_list.map((m) => ours.has(m.model_id)
			? { ...m, model_lib: LIBS + m.model_lib.split('/').pop() }
			: m)
	};
	return appConfigCache;
}

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
		return await w.hasModelInCache(await resolveId(id), await appConfig());
	} catch {
		return false;
	}
}

export async function remove(id) {
	const w = await lib();
	const real = await resolveId(id);
	if (engine?.id === real) await unload();
	await w.deleteModelAllInfoInCache(real, await appConfig());
}

export async function unload() {
	const e = engine;
	engine = null;
	clearTimeout(idleTimer);
	if (!e) return;
	try { await (await e.promise).unload(); } catch {}
	e.worker?.terminate();
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
				worker,
				promise: w.CreateWebWorkerMLCEngine(worker, real, {
					appConfig: await appConfig(),
					initProgressCallback: (r) => { for (const l of listeners) l(r); }
				}).catch((e) => { engine = null; worker.terminate(); throw e; })
			};
		}
		return await engine.promise;
	} finally {
		if (onProgress) listeners.delete(onProgress);
	}
}

export async function complete(id, system, user, onText, signal, onProgress, maxTokens = 600) {
	busy++;
	clearTimeout(idleTimer);
	let stop = null;
	try {
		const eng = await load(id, onProgress);
		onProgress?.({ progress: 1, text: 'ready' });
		if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
		stop = () => eng.interruptGenerate();
		signal?.addEventListener('abort', stop, { once: true });
		const chunks = await eng.chat.completions.create({
			messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
			stream: true,
			temperature: 0.3,
			max_tokens: maxTokens,
			// Qwen3 «thinks» before answering by default: much slower, no better for summaries.
			...(/^Qwen3-/.test(id) ? { extra_body: { enable_thinking: false } } : {})
		});
		let text = '';
		for await (const c of chunks) {
			const piece = c.choices?.[0]?.delta?.content;
			if (piece) { text += piece; onText?.(text); }
		}
		if (signal?.aborted) throw new DOMException('Annullato', 'AbortError');
		return text.trim();
	} finally {
		if (stop) signal?.removeEventListener('abort', stop);
		busy--;
		scheduleUnload();
	}
}
