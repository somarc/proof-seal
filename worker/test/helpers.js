// Shared test helpers: an offline fetch stub that plays AEM admin, aem.page, IMS and Ziflow.
import { readFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { createMemoryStore } from '../src/core/store.js';
import { ziflowSignature } from '../src/providers/ziflow.js';

export const ORG = 'somarc';
export const SITE = 'proof-seal';
export const PATH = '/en/launch';
export const GOOD_TOKEN = 'ims-good-token';
export const READER_TOKEN = 'ims-reader-token';
export const SITE_KEY = 'site-publish-key-123';
export const ZIFLOW_KEY = 'zf-api-key';
export const ZIFLOW_SECRET = 'zf-webhook-secret';
export const WORKER = 'https://proof-seal.example.workers.dev';

export async function fixture(name) {
  return readFile(new URL(`./fixtures/ziflow/${name}`, import.meta.url), 'utf8');
}

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json' },
});

/**
 * Offline world. `page` is mutable: change `page.md` / `page.lastModified` to simulate an
 * edit + re-preview. Every request is recorded in `calls` (method, url, headers, body).
 */
export function createWorld() {
  const page = { md: '# Launch\n\nSpring launch copy.\n', lastModified: '2026-11-09T09:00:00Z' };
  const calls = [];
  let proofCount = 0;
  const ziflowFixtures = {};

  async function stub(input, init = {}) {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const headers = Object.fromEntries(request.headers.entries());
    const body = request.method === 'GET' ? null : await request.text();
    calls.push({
      method: request.method, url: request.url, headers, body,
    });
    const auth = headers.authorization || '';

    if (url.origin === 'https://admin.hlx.page') {
      const [, route, org, site, ref, ...rest] = url.pathname.split('/');
      const path = `/${rest.join('/')}`;
      if (org !== ORG || site !== SITE || ref !== 'main') return jsonResponse({}, 404);
      if (route === 'status' && request.method === 'GET') {
        if (page.statusDown) return jsonResponse({}, 503);
        let permissions = ['read'];
        if (auth === `Bearer ${GOOD_TOKEN}`) permissions = ['read', 'write'];
        else if (auth === `token ${SITE_KEY}`) permissions = ['read', 'write'];
        else if (auth.startsWith('Bearer ') && auth !== `Bearer ${READER_TOKEN}`) return jsonResponse({}, 401);
        return jsonResponse({
          webPath: path,
          preview: {
            status: 200, url: `https://main--${SITE}--${ORG}.aem.page${path}`, lastModified: page.lastModified, permissions,
          },
          live: { status: 404, permissions: ['read'] },
        });
      }
      if (route === 'live' && request.method === 'POST') {
        if (auth !== `token ${SITE_KEY}`) return jsonResponse({}, 401);
        return jsonResponse({ webPath: path, live: { status: 200 } });
      }
    }
    if (url.origin === `https://main--${SITE}--${ORG}.aem.page` && url.pathname === `${PATH}.md`) {
      return new Response(page.md, { status: 200 });
    }
    if (url.href === 'https://ims-na1.adobelogin.com/ims/profile/v1') {
      if (auth !== `Bearer ${GOOD_TOKEN}`) return jsonResponse({}, 401);
      return jsonResponse({ displayName: 'Ann Author', email: 'ann@example.com' });
    }
    if (url.origin === 'https://api.ziflow.io') {
      if (headers.apikey !== ZIFLOW_KEY) return jsonResponse({ error: 'unauthorized' }, 401);
      const p = url.pathname.replace('/v1', '');
      if (request.method === 'POST' && (p === '/proofs' || /^\/proofs\/[^/]+\/versions$/.test(p))) {
        proofCount += 1;
        const proof = JSON.parse(ziflowFixtures.create);
        proof.id = `zf-proof-${proofCount}`;
        proof.public_link = `https://app.ziflow.com/proof/${proof.id}`;
        return jsonResponse(proof, 201);
      }
      if (request.method === 'GET' && /^\/proofs\/[^/]+\/comments$/.test(p)) return new Response(ziflowFixtures.comments, { status: 200 });
      if (request.method === 'GET' && p === '/proofs') return jsonResponse([]);
      if (request.method === 'GET' && /^\/proofs\/[^/]+$/.test(p)) return new Response(ziflowFixtures.get, { status: 200 });
      if (request.method === 'PATCH' && /^\/proofs\/[^/]+$/.test(p)) return jsonResponse({ status: 'locked' });
    }
    throw new Error(`Unexpected fetch in test: ${request.method} ${request.url}`);
  }

  return {
    page,
    calls,
    fetch: stub,
    async loadZiflowFixtures() {
      ziflowFixtures.create = await fixture('create-proof.json');
      ziflowFixtures.get = await fixture('get-proof.json');
      ziflowFixtures.comments = await fixture('comments.json');
    },
    callsTo: (prefix, method) => calls
      .filter((c) => c.url.startsWith(prefix) && (!method || c.method === method)),
    publishCalls: () => calls.filter((c) => c.method === 'POST' && c.url.startsWith('https://admin.hlx.page/live/')),
  };
}

export function makeApp(world, env = {}, store = createMemoryStore()) {
  let tick = 0;
  let id = 0;
  return createApp({
    env: { SITE_KEYS: JSON.stringify({ [`${ORG}/${SITE}`]: SITE_KEY }), ...env },
    store,
    fetch: world.fetch,
    now: () => {
      tick += 1;
      return new Date(Date.UTC(2026, 10, 9, 10, 0, tick)).toISOString();
    },
    newId: () => {
      id += 1;
      return `id-${id}`;
    },
  });
}

/** Builds and dispatches a request against the app. */
export async function call(app, method, path, {
  body, token, origin, headers = {},
} = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (origin) h.origin = origin;
  if (body !== undefined) h['content-type'] = 'application/json';
  const res = await app.handle(new Request(`${WORKER}${path}`, {
    method, headers: h, body: body === undefined ? undefined : JSON.stringify(body),
  }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
}

export const sendForProof = (app, extra = {}) => call(app, 'POST', '/api/rounds', {
  token: GOOD_TOKEN,
  body: {
    org: ORG, site: SITE, path: PATH, reviewers: [{ email: 'rita@example.com', role: 'approver' }], ...extra,
  },
});

/** Pulls round id + secret out of a sandbox reviewer URL. */
export function sandboxLink(reviewerUrl) {
  const u = new URL(reviewerUrl);
  return { id: u.searchParams.get('round'), t: u.searchParams.get('t'), api: u.searchParams.get('api') };
}

/** A Ziflow webhook delivery signed the way ZIFLOW_ASSUMPTIONS says Ziflow signs it. */
export async function ziflowWebhook(fixtureName, { proofId = 'zf-proof-1', secret = ZIFLOW_SECRET, signature } = {}) {
  const body = (await fixture(fixtureName)).replaceAll('zf-proof-1', proofId);
  const url = `${WORKER}/webhooks/ziflow`;
  const sig = signature ?? await ziflowSignature(secret, { method: 'POST', uri: url, body });
  return new Request(url, { method: 'POST', headers: { 'x-ziflow-signature': sig, 'content-type': 'application/json' }, body });
}
