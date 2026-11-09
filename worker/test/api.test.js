// HTTP surface: auth, CORS, health, validation and unit checks of the core pieces.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  call, createWorld, GOOD_TOKEN, makeApp, ORG, PATH, READER_TOKEN, SITE, SITE_KEY, ZIFLOW_KEY,
} from './helpers.js';
import { compileOrigins, isAllowedOrigin } from '../src/router.js';
import { decide } from '../src/core/policy.js';
import { canTransition } from '../src/core/seals.js';
import { timingSafeEqual } from '../src/core/crypto.js';
import { createKvStore } from '../src/core/store.js';
import worker from '../src/index.js';

describe('auth', () => {
  it('(g) unauthenticated POST /api/rounds -> 401 without any outbound call', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const res = await call(app, 'POST', '/api/rounds', { body: { org: ORG, site: SITE, path: PATH } });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
    assert.equal(world.calls.length, 0);
  });

  it('a token AEM rejects -> 401; a reader without preview write -> 403', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const body = { org: ORG, site: SITE, path: PATH };
    assert.equal((await call(app, 'POST', '/api/rounds', { token: 'bogus', body })).status, 401);
    const reader = await call(app, 'POST', '/api/rounds', { token: READER_TOKEN, body });
    assert.equal(reader.status, 403);
    assert.equal(reader.body.error.code, 'forbidden');
  });

  it('read and withdraw routes require auth', async () => {
    const app = makeApp(createWorld());
    assert.equal((await call(app, 'GET', `/api/seals?org=${ORG}&site=${SITE}&path=${PATH}`)).status, 401);
    assert.equal((await call(app, 'GET', '/api/rounds/x/feedback')).status, 401);
    assert.equal((await call(app, 'POST', '/api/rounds/x/withdraw')).status, 401);
  });

  it('validates input', async () => {
    const app = makeApp(createWorld());
    const bad = await call(app, 'POST', '/api/rounds', { token: GOOD_TOKEN, body: { org: ORG, site: SITE, path: '/a/../b' } });
    assert.equal(bad.status, 400);
    const badReviewer = await call(app, 'POST', '/api/rounds', {
      token: GOOD_TOKEN,
      body: {
        org: ORG, site: SITE, path: PATH, reviewers: [{ email: 'nope' }],
      },
    });
    assert.equal(badReviewer.status, 400);
    assert.equal((await call(app, 'GET', '/nope')).status, 404);
    assert.equal((await call(app, 'DELETE', '/api/rounds')).status, 405);
  });

  it('GET /api/seals for a page never sent -> seal null', async () => {
    const app = makeApp(createWorld());
    const res = await call(app, 'GET', `/api/seals?org=${ORG}&site=${SITE}&path=${PATH}`, { token: GOOD_TOKEN });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, {
      seal: null, rounds: [], latestDecision: null, audit: [],
    });
  });
});

describe('CORS', () => {
  it('(h) preflight from an allowed origin', async () => {
    const app = makeApp(createWorld());
    const res = await call(app, 'OPTIONS', '/api/rounds', { origin: 'https://main--proof-seal--somarc.aem.live' });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://main--proof-seal--somarc.aem.live');
    assert.match(res.headers.get('access-control-allow-headers'), /authorization/);
  });

  it('(h) preflight from a disallowed origin', async () => {
    const app = makeApp(createWorld());
    const res = await call(app, 'OPTIONS', '/api/rounds', { origin: 'https://evil.example.com' });
    assert.equal(res.status, 403);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('actual responses echo only allowed origins', async () => {
    const app = makeApp(createWorld());
    const ok = await call(app, 'GET', '/api/health', { origin: 'https://da.live' });
    assert.equal(ok.headers.get('access-control-allow-origin'), 'https://da.live');
    const no = await call(app, 'GET', '/api/health', { origin: 'https://da.live.evil.com' });
    assert.equal(no.headers.get('access-control-allow-origin'), null);
  });

  it('wildcards match subdomains only', () => {
    const re = compileOrigins(['https://*.aem.live', 'http://localhost:3000']);
    assert.ok(isAllowedOrigin('https://main--site--org.aem.live', re));
    assert.ok(isAllowedOrigin('https://a.b.aem.live', re));
    assert.ok(isAllowedOrigin('http://localhost:3000', re));
    assert.ok(!isAllowedOrigin('https://aem.live', re));
    assert.ok(!isAllowedOrigin('https://evil.com/x.aem.live', re));
    assert.ok(!isAllowedOrigin('https://x.aem.live.evil.com', re));
    assert.ok(!isAllowedOrigin('http://x.aem.live', re));
    assert.ok(!isAllowedOrigin(null, re));
  });
});

describe('health', () => {
  it('reports readiness without revealing secrets', async () => {
    const app = makeApp(createWorld(), { PROOF_PROVIDER: 'ziflow', ZIFLOW_API_KEY: ZIFLOW_KEY });
    const res = await call(app, 'GET', `/api/health?org=${ORG}&site=${SITE}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, false);
    assert.equal(res.body.provider.id, 'ziflow');
    assert.equal(res.body.provider.ok, false);
    assert.match(res.body.provider.detail, /ZIFLOW_WEBHOOK_SECRET/);
    assert.equal(res.body.provider.capabilities.liveUrl, true);
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    assert.equal(byId['publish-key'].ok, true);
    assert.equal(byId.store.ok, false); // in-memory store in tests
    res.body.checks.forEach((c) => ['id', 'ok', 'label', 'hint'].forEach((k) => assert.ok(k in c)));
    const raw = JSON.stringify(res.body);
    assert.ok(!raw.includes(SITE_KEY));
    assert.ok(!raw.includes(ZIFLOW_KEY));
  });

  it('flags a missing site key, an unknown provider and bad JSON config', async () => {
    const app = makeApp(createWorld(), { SITE_KEYS: 'not json', SITE_PROVIDERS: JSON.stringify({ [`${ORG}/${SITE}`]: 'pageproof' }) });
    const res = await call(app, 'GET', `/api/health?org=${ORG}&site=${SITE}`);
    const byId = Object.fromEntries(res.body.checks.map((c) => [c.id, c]));
    assert.equal(byId['publish-key'].ok, false);
    assert.equal(byId.provider.ok, false);
    assert.equal(byId.config.ok, false);
    assert.ok(!byId.config.hint.includes('not json'));
  });
});

describe('core units', () => {
  it('policy follows the seam table', () => {
    assert.equal(decide('approved').action, 'publish');
    assert.equal(decide('approved', { autoPublish: false }).action, 'approve');
    assert.equal(decide('approved_with_changes').action, 'changes');
    assert.equal(decide('approved_with_changes', { minorChangesAllowed: true }).minorFixAllowed, true);
    assert.equal(decide('changes_required').action, 'changes');
    assert.equal(decide('rejected').action, 'changes');
    assert.equal(decide('cancelled').action, 'withdraw');
    assert.equal(decide('pending').action, 'wait');
    assert.throws(() => decide('Approved'));
  });

  it('seal state machine', () => {
    assert.ok(canTransition('in-review', 'approved'));
    assert.ok(canTransition('approved', 'published'));
    assert.ok(!canTransition('in-review', 'published'));
    assert.ok(!canTransition('published', 'in-review'));
    assert.ok(!canTransition('withdrawn', 'approved'));
  });

  it('timingSafeEqual', async () => {
    assert.equal(await timingSafeEqual('abc', 'abc'), true);
    assert.equal(await timingSafeEqual('abc', 'abd'), false);
    assert.equal(await timingSafeEqual('abc', 'abcd'), false);
    assert.equal(await timingSafeEqual(undefined, 'abc'), false);
  });

  it('KV store adapter pages through list()', async () => {
    const data = new Map();
    const kv = {
      get: async (k) => (data.has(k) ? JSON.parse(data.get(k)) : null),
      put: async (k, v) => { data.set(k, v); },
      list: async ({ prefix, cursor }) => {
        const keys = [...data.keys()].filter((k) => k.startsWith(prefix)).sort();
        const start = cursor ? Number(cursor) : 0;
        const page = keys.slice(start, start + 2);
        const done = start + 2 >= keys.length;
        return {
          keys: page.map((name) => ({ name })),
          list_complete: done,
          cursor: done ? undefined : String(start + 2),
        };
      },
    };
    const store = createKvStore(kv);
    await Promise.all(['a:1', 'a:2', 'a:3', 'b:1'].map((k) => store.put(k, { k })));
    assert.deepEqual(await store.list('a:'), ['a:1', 'a:2', 'a:3']);
    await store.append('log', { n: 1 });
    await store.append('log', { n: 2 });
    assert.deepEqual(await store.get('log'), [{ n: 1 }, { n: 2 }]);
  });

  it('the Worker entry serves health with the in-memory fallback', async () => {
    const res = await worker.fetch(new Request('https://w.example/api/health'), {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.provider.id, 'sandbox');
  });
});
