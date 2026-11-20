# Vendored WebLLM

Copied here so that the on-device AI does not depend on third-party CDNs: only the model weights are downloaded from Hugging Face (huggingface.co/mlc-ai).

- `web-llm.js`: `@mlc-ai/web-llm@0.2.87` (`lib/index.js` from npm), Apache License 2.0, see `LICENSE`. Source: https://github.com/mlc-ai/web-llm
- `libs/*.wasm`: compiled WebGPU kernels for the four models offered in Edicola (16- and 32-bit variants), from https://github.com/mlc-ai/binary-mlc-llm-libs/tree/main/web-llm-models/v0_2_87/base (Apache License 2.0).

To update: bump the version in `js/webllm.js`, replace `web-llm.js` and download the matching `libs/`.

SHA-256:

```
3bff4c55cd2f0200711517341babcebe7a91a8ef85b983420439fcf26835a674  web-llm.js
8dbd7e81d39291f2666176b846f36d924a603e9480bac739ee5fc0d22f74b1fd  libs/Llama-3.2-1B-Instruct-q4f16_1_cs1k-webgpu.wasm
d42643deeb496d4a3486ddf066fe34efec32a4a51b14443301f8212a5f015642  libs/Llama-3.2-1B-Instruct-q4f32_1_cs1k-webgpu.wasm
2a203aa9280044fd4b6d279c2c8bf3ef11e9e450435b973ef494e5d461e4f2dd  libs/Qwen2-0.5B-Instruct-q4f16_1_cs1k-webgpu.wasm
6ba8b8f85be2e86f7ca16454d199bfc83e672ec010f4f6e265240c22505f5829  libs/Qwen2-0.5B-Instruct-q4f32_1_cs1k-webgpu.wasm
155ef7359c859f7d646f4c5adc548d779475da3e3196701c7a9d4b82827559a8  libs/Qwen2-1.5B-Instruct-q4f16_1_cs1k-webgpu.wasm
8e8e617bb765757ab86555705469679880e9636db10c2198d26aa0f3d1ee8e90  libs/Qwen2-1.5B-Instruct-q4f32_1_cs1k-webgpu.wasm
7e97bd3ae603ccf45791bd75e9d1fd40a3696ebdf87f75556eee62507279b8f1  libs/gemma-2-2b-it-q4f16_1_cs1k-webgpu.wasm
bede1fa2f1f4f434f5c7844dd579bd989a8d362253c2d8d12fd25ddf3bc06d14  libs/gemma-2-2b-it-q4f32_1_cs1k-webgpu.wasm
```
