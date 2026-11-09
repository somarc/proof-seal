// Conformance kit (docs/proofing-seam.md §7), run against every adapter with no network.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertProvider, DECISIONS } from '../src/providers/contract.js';
import { createSandboxProvider } from '../src/providers/sandbox.js';
import {
  createZiflowProvider, mapDecision, ziflowSignature, ZIFLOW_ASSUMPTIONS,
} from '../src/providers/ziflow.js';
import { createMemoryStore } from '../src/core/store.js';
import {
  createWorld, fixture, sandboxLink, WORKER, ZIFLOW_KEY, ZIFLOW_SECRET, ziflowWebhook,
} from './helpers.js';

const seal = {
  sealId: 'seal-1',
  org: 'somarc',
  site: 'proof-seal',
  path: '/en/launch',
  previewUrl: 'https://main--proof-seal--somarc.aem.page/en/launch',
  contentHash: 'abc',
};
const createReq = () => ({
  seal,
  source: { kind: 'url', url: seal.previewUrl },
  reviewers: [{ email: 'rita@example.com', role: 'approver' }],
  number: 1,
  apiOrigin: WORKER,
});

const ids = () => {
  let n = 0;
  return () => {
    n += 1;
    return `n${n}`;
  };
};
const now = () => '2026-11-09T10:00:00.000Z';

/** Per-adapter harness: how to drive it and what its native decisions are. */
const harnesses = {
  sandbox: async () => {
    const store = createMemoryStore();
    const provider = createSandboxProvider({ store, now, newId: ids() });
    const secrets = new Map();
    return {
      provider,
      async create() {
        const r = await provider.createRound(createReq());
        secrets.set(r.providerRef, sandboxLink(r.reviewerUrl).t);
        return r;
      },
      // The sandbox reviewer page emits shared values directly.
      nativeDecisions: {
        approved: 'approved',
        approved_with_changes: 'approved_with_changes',
        changes_required: 'changes_required',
        rejected: 'rejected',
        cancelled: 'cancelled',
      },
      unknownDecision: 'looks-good',
      webhook: (ref, decision, { forge = false } = {}) => new Request(`${WORKER}/webhooks/sandbox`, {
        method: 'POST',
        body: JSON.stringify({
          round: ref, t: forge ? 'forged' : secrets.get(ref), decision, comment: 'Looks fine', reviewer: { name: 'Rita', email: 'rita@example.com' },
        }),
      }),
      unconfigured: null, // no credentials to miss
    };
  },
  ziflow: async () => {
    const world = createWorld();
    await world.loadZiflowFixtures();
    const provider = createZiflowProvider({
      fetch: world.fetch, apiKey: ZIFLOW_KEY, webhookSecret: ZIFLOW_SECRET,
    });
    const slug = {
      Approved: 'approved',
      'Approved with changes': 'approved_with_changes',
      'Changes required': 'changes_required',
      'Not relevant': 'not_relevant',
    };
    return {
      provider,
      create: () => provider.createRound(createReq()),
      nativeDecisions: ZIFLOW_ASSUMPTIONS.decisions,
      unknownDecision: 'Looks good to me',
      async webhook(ref, label, { forge = false } = {}) {
        if (!slug[label]) {
          const body = (await fixture('webhook-approved.json')).replace('"Approved"', JSON.stringify(label)).replaceAll('zf-proof-1', ref);
          const url = `${WORKER}/webhooks/ziflow`;
          return new Request(url, { method: 'POST', headers: { 'x-ziflow-signature': await ziflowSignature(ZIFLOW_SECRET, { method: 'POST', uri: url, body }) }, body });
        }
        return ziflowWebhook(`webhook-${slug[label]}.json`, { proofId: ref, ...(forge ? { secret: 'wrong-secret' } : {}) });
      },
      unconfigured: () => createZiflowProvider({ fetch: world.fetch }),
    };
  },
};

Object.entries(harnesses).forEach(([name, makeHarness]) => {
  describe(`conformance: ${name}`, () => {
    it('has the ProofProvider shape and honest boolean capabilities', async () => {
      const { provider } = await makeHarness();
      assert.equal(assertProvider(provider), provider);
      assert.equal(provider.id, name);
    });

    it('1. createRound returns a providerRef and a reviewer URL', async () => {
      const h = await makeHarness();
      const r = await h.create();
      assert.equal(typeof r.providerRef, 'string');
      assert.ok(r.providerRef.length > 0);
      assert.ok(new URL(r.reviewerUrl).protocol.startsWith('http'));
      assert.equal(r.decision, 'pending');
      const status = await h.provider.getRound(r.providerRef);
      assert.ok(DECISIONS.includes(status.decision));
      assert.ok(Array.isArray(status.reviewers));
    });

    it('2. every native decision maps to a shared Decision; unknown values never pass', async () => {
      const h = await makeHarness();
      await Object.entries(h.nativeDecisions).reduce(async (prev, [native, shared]) => {
        await prev;
        const { providerRef } = await h.create();
        const event = await h.provider.parseWebhook(await h.webhook(providerRef, native));
        assert.equal(event.decision, shared, `${native} -> ${shared}`);
        assert.ok(DECISIONS.includes(event.decision));
      }, Promise.resolve());
      const { providerRef } = await h.create();
      const unknown = await h.webhook(providerRef, h.unknownDecision);
      await assert.rejects(async () => {
        const event = await h.provider.parseWebhook(unknown);
        if (!event) throw new Error('rejected');
      });
    });

    it('3. parseWebhook rejects a bad signature, tolerates a replay, returns the shared event', async () => {
      const h = await makeHarness();
      const [native] = Object.keys(h.nativeDecisions);
      const { providerRef } = await h.create();
      const forged = await h.webhook(providerRef, native, { forge: true });
      assert.equal(await h.provider.parseWebhook(forged), null);
      const first = await h.provider.parseWebhook(await h.webhook(providerRef, native));
      const replay = await h.provider.parseWebhook(await h.webhook(providerRef, native));
      assert.ok(['decision', 'feedback', 'status'].includes(first.type));
      assert.equal(first.providerRef, providerRef);
      assert.equal(typeof first.at, 'string');
      assert.ok('raw' in first);
      assert.equal(replay.id, first.id, 'a replay carries the same event id');
      assert.equal(replay.decision, first.decision);
    });

    it('listFeedback returns shared feedback items', async () => {
      const h = await makeHarness();
      const { providerRef } = await h.create();
      const [native] = Object.keys(h.nativeDecisions);
      await h.provider.parseWebhook(await h.webhook(providerRef, native));
      const items = await h.provider.listFeedback(providerRef, {});
      assert.ok(items.length > 0);
      items.forEach((f) => {
        assert.equal(typeof f.id, 'string');
        assert.equal(typeof f.body, 'string');
        assert.equal(typeof f.author.external, 'boolean');
        assert.equal(typeof f.resolved, 'boolean');
      });
    });

    it('4. health reports clearly, and fails when credentials are missing', async () => {
      const h = await makeHarness();
      const ok = await h.provider.health();
      assert.equal(ok.ok, true);
      assert.equal(typeof ok.detail, 'string');
      if (h.unconfigured) {
        const bad = await h.unconfigured().health();
        assert.equal(bad.ok, false);
        assert.match(bad.detail, /ZIFLOW_API_KEY/);
      }
    });

    it('cancelRound does not throw for a live round', async () => {
      const h = await makeHarness();
      const { providerRef } = await h.create();
      await h.provider.cancelRound(providerRef, 'test');
    });
  });
});

describe('ziflow specifics', () => {
  it('mapDecision throws on unknown labels and treats empty as pending', () => {
    assert.throws(() => mapDecision('Bogus'), /Unknown Ziflow decision/);
    assert.equal(mapDecision(null), 'pending');
    assert.equal(mapDecision('Not relevant'), 'cancelled');
  });

  it('fails closed without a webhook secret', async () => {
    const world = createWorld();
    const provider = createZiflowProvider({ fetch: world.fetch, apiKey: ZIFLOW_KEY });
    assert.equal(await provider.parseWebhook(await ziflowWebhook('webhook-approved.json')), null);
    assert.match((await provider.health()).detail, /ZIFLOW_WEBHOOK_SECRET/);
  });

  it('a non-decision event becomes a status event', async () => {
    const world = createWorld();
    const provider = createZiflowProvider({
      fetch: world.fetch, apiKey: ZIFLOW_KEY, webhookSecret: ZIFLOW_SECRET,
    });
    const event = await provider.parseWebhook(await ziflowWebhook('webhook-comment.json'));
    assert.equal(event.type, 'status');
    assert.equal(event.decision, undefined);
  });

  it('sends the API key only to api.ziflow.io and a new version for a follow-up round', async () => {
    const world = createWorld();
    await world.loadZiflowFixtures();
    const provider = createZiflowProvider({
      fetch: world.fetch, apiKey: ZIFLOW_KEY, webhookSecret: ZIFLOW_SECRET,
    });
    const first = await provider.createRound(createReq());
    await provider.createRound({ ...createReq(), previousRound: { provider: 'ziflow', providerRef: first.providerRef } });
    const posts = world.callsTo('https://api.ziflow.io', 'POST').map((c) => new URL(c.url).pathname);
    assert.deepEqual(posts, ['/v1/proofs', `/v1/proofs/${first.providerRef}/versions`]);
    assert.ok(world.calls.every((c) => c.url.startsWith('https://api.ziflow.io') || !c.headers.apikey));
  });
});
