import { assertProvider } from './contract.js';
import { createSandboxProvider } from './sandbox.js';
import { createZiflowProvider } from './ziflow.js';

export const PROVIDER_IDS = ['sandbox', 'ziflow'];

/**
 * Lazily builds and caches one provider instance per id for this request.
 * deps: { env, store, fetch, now, newId }
 */
export function createProviderRegistry({
  env, store, fetch, now, newId,
}) {
  const cache = new Map();
  const factories = {
    sandbox: () => createSandboxProvider({
      store, now, newId, reviewerUrl: env.SANDBOX_REVIEWER_URL || undefined,
    }),
    ziflow: () => createZiflowProvider({
      fetch,
      apiKey: env.ZIFLOW_API_KEY,
      webhookSecret: env.ZIFLOW_WEBHOOK_SECRET,
      webhookUrl: env.ZIFLOW_WEBHOOK_URL,
    }),
  };
  return {
    has: (id) => Object.hasOwn(factories, id),
    get(id) {
      if (!Object.hasOwn(factories, id)) throw new Error(`Unknown provider "${id}"`);
      if (!cache.has(id)) cache.set(id, assertProvider(factories[id]()));
      return cache.get(id);
    },
  };
}

export default createProviderRegistry;
