// Runs the on-device model off the main thread so scrolling stays smooth.
import { WebWorkerMLCEngineHandler } from '../vendor/web-llm/web-llm.js';

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
