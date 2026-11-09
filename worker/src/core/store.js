/**
 * Store interface used by the core and the Sandbox provider:
 *   get(key) -> value | null, put(key, value), list(prefix) -> keys[],
 *   append(key, entry, { max }) -> appends to a JSON array (capped, oldest dropped).
 * Values are plain JSON. `append` is read-modify-write: fine for the in-memory store and
 * acceptable for KV at proofing volumes (KV is eventually consistent; see worker/README.md).
 */

const DEFAULT_MAX = 500;

async function appendTo(store, key, entry, { max = DEFAULT_MAX } = {}) {
  const list = (await store.get(key)) || [];
  list.push(entry);
  await store.put(key, list.slice(-max));
  return list.length;
}

export function createMemoryStore() {
  const map = new Map();
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const store = {
    kind: 'memory',
    async get(key) {
      return map.has(key) ? copy(map.get(key)) : null;
    },
    async put(key, value) {
      map.set(key, copy(value));
    },
    async list(prefix = '') {
      return [...map.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    append: (key, entry, opts) => appendTo(store, key, entry, opts),
  };
  return store;
}

/** Cloudflare KV namespace binding (env.APS_STORE). */
export function createKvStore(kv) {
  const listPage = async (prefix, cursor, acc) => {
    const page = await kv.list({ prefix, cursor });
    const keys = acc.concat(page.keys.map((k) => k.name));
    return page.list_complete ? keys : listPage(prefix, page.cursor, keys);
  };
  const store = {
    kind: 'kv',
    async get(key) {
      return kv.get(key, 'json');
    },
    async put(key, value) {
      await kv.put(key, JSON.stringify(value));
    },
    async list(prefix = '') {
      return listPage(prefix, undefined, []);
    },
    append: (key, entry, opts) => appendTo(store, key, entry, opts),
  };
  return store;
}
