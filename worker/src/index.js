// Cloudflare Worker entry: wires env bindings into the runtime-agnostic core.
import { createApp } from './app.js';
import { createKvStore, createMemoryStore } from './core/store.js';

// Fallback for `wrangler dev` without KV; /api/health reports it as not ready.
let memoryStore;

export default {
  async fetch(request, env) {
    if (!env.APS_STORE && !memoryStore) memoryStore = createMemoryStore();
    const store = env.APS_STORE ? createKvStore(env.APS_STORE) : memoryStore;
    const app = createApp({ env, store, fetch: (...args) => fetch(...args) });
    return app.handle(request);
  },
};
