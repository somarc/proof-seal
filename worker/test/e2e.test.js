// Core end-to-end over HTTP with the Sandbox and Ziflow adapters (offline).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  call, createWorld, GOOD_TOKEN, makeApp, ORG, PATH, sandboxLink, sendForProof, SITE, SITE_KEY,
  WORKER, ZIFLOW_KEY, ZIFLOW_SECRET, ziflowWebhook,
} from './helpers.js';

const decide = (app, link, decision, comment = '') => call(app, 'POST', `/sandbox/rounds/${link.id}/decision`, {
  body: {
    t: link.t, decision, comment, reviewer: { name: 'Rita Reviewer', email: 'rita@example.com' },
  },
});

const sealQuery = `/api/seals?org=${ORG}&site=${SITE}&path=${encodeURIComponent(PATH)}`;

describe('sandbox end-to-end', () => {
  it('(b) send -> approve -> fingerprint matches -> publish once with the site key', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const sent = await sendForProof(app);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.seal.state, 'in-review');
    assert.equal(sent.body.seal.round, 1);
    assert.equal(sent.body.round.number, 1);
    assert.equal(sent.body.seal.createdBy.email, 'ann@example.com');
    assert.match(sent.body.seal.contentHash, /^[0-9a-f]{64}$/);
    assert.equal(sent.body.seal.previewUrl, `https://main--${SITE}--${ORG}.aem.page${PATH}`);

    const link = sandboxLink(sent.body.reviewerUrl);
    assert.ok(sent.body.reviewerUrl.startsWith('https://main--proof-seal--somarc.aem.live/tools/proof-seal/sandbox-reviewer.html?'));
    assert.equal(link.api, WORKER);

    const view = await call(app, 'GET', `/sandbox/rounds/${link.id}?t=${link.t}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.seal.path, PATH);
    assert.equal(view.body.round.number, 1);
    assert.equal(view.body.round.secret, undefined);

    const res = await decide(app, link, 'approved', 'Ship it');
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.seal.state, 'published');

    const publishes = world.publishCalls();
    assert.equal(publishes.length, 1);
    assert.equal(publishes[0].url, `https://admin.hlx.page/live/${ORG}/${SITE}/main${PATH}`);
    assert.equal(publishes[0].headers.authorization, `token ${SITE_KEY}`);

    const seals = await call(app, 'GET', sealQuery, { token: GOOD_TOKEN });
    assert.equal(seals.body.seal.state, 'published');
    assert.equal(seals.body.rounds[0].decision, 'approved');
    assert.equal(seals.body.latestDecision, 'approved');
    assert.deepEqual(seals.body.audit.map((a) => a.type), ['published', 'sent']);
    seals.body.audit.forEach((a) => ['at', 'type', 'actor', 'detail'].forEach((k) => assert.ok(k in a)));

    const fb = await call(app, 'GET', `/api/rounds/${sent.body.round.roundId}/feedback`, { token: GOOD_TOKEN });
    assert.equal(fb.status, 200);
    assert.equal(fb.body.items[0].body, 'Ship it');
    assert.equal(fb.body.items[0].author.email, 'rita@example.com');
  });

  it('(c) approve after the content changed -> broken, no publish, round cancelled, audited', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const sent = await sendForProof(app);
    const link = sandboxLink(sent.body.reviewerUrl);

    world.page.md += '\nA late edit.\n';
    world.page.lastModified = '2026-11-09T12:00:00Z';

    const res = await decide(app, link, 'approved');
    assert.equal(res.status, 200);
    assert.equal(res.body.seal.state, 'broken');
    assert.equal(world.publishCalls().length, 0);

    const view = await call(app, 'GET', `/sandbox/rounds/${link.id}?t=${link.t}`);
    assert.match(view.body.round.closed, /Content changed/);

    const seals = await call(app, 'GET', sealQuery, { token: GOOD_TOKEN });
    assert.equal(seals.body.seal.state, 'broken');
    const broken = seals.body.audit.find((a) => a.type === 'seal-broken');
    assert.ok(broken);
    assert.notEqual(broken.data.expected.contentHash, broken.data.actual.contentHash);

    // A new round re-seals the changed content.
    const again = await sendForProof(app);
    assert.equal(again.status, 201);
    assert.equal(again.body.seal.round, 2);
    assert.equal(again.body.seal.sealId, sent.body.seal.sealId);
    await decide(app, sandboxLink(again.body.reviewerUrl), 'approved');
    assert.equal(world.publishCalls().length, 1);
  });

  it('(d) changes_required -> seal in changes, no publish', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const sent = await sendForProof(app);
    const res = await decide(app, sandboxLink(sent.body.reviewerUrl), 'changes_required', 'Fix the headline');
    assert.equal(res.body.seal.state, 'changes');
    assert.equal(world.publishCalls().length, 0);
    const seals = await call(app, 'GET', sealQuery, { token: GOOD_TOKEN });
    assert.equal(seals.body.audit[0].type, 'changes-requested');
  });

  it('approved_with_changes is not publishable by default', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const sent = await sendForProof(app);
    const res = await decide(app, sandboxLink(sent.body.reviewerUrl), 'approved_with_changes');
    assert.equal(res.body.seal.state, 'changes');
    assert.equal(world.publishCalls().length, 0);
  });

  it('autoPublish off -> approved, not published', async () => {
    const world = createWorld();
    const app = makeApp(world, { SITE_POLICIES: JSON.stringify({ [`${ORG}/${SITE}`]: { autoPublish: false } }) });
    const sent = await sendForProof(app);
    const res = await decide(app, sandboxLink(sent.body.reviewerUrl), 'approved');
    assert.equal(res.body.seal.state, 'approved');
    assert.equal(world.publishCalls().length, 0);
  });

  it('no publish key for the site -> fail closed (approved, publish-blocked)', async () => {
    const world = createWorld();
    const app = makeApp(world, { SITE_KEYS: '{}' });
    const sent = await sendForProof(app);
    const res = await decide(app, sandboxLink(sent.body.reviewerUrl), 'approved');
    assert.equal(res.body.seal.state, 'approved');
    assert.equal(world.publishCalls().length, 0);
    const seals = await call(app, 'GET', sealQuery, { token: GOOD_TOKEN });
    assert.equal(seals.body.audit[0].type, 'publish-blocked');
  });

  it('AEM down at decision time -> 502, seal untouched, a retry publishes', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const link = sandboxLink((await sendForProof(app)).body.reviewerUrl);
    world.page.statusDown = true;
    const failed = await decide(app, link, 'approved');
    assert.equal(failed.status, 502);
    const seals = await call(app, 'GET', sealQuery, { token: GOOD_TOKEN });
    assert.equal(seals.status, 502); // the panel's own status call fails too while AEM is down
    world.page.statusDown = false;
    const retry = await decide(app, link, 'approved');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.seal.state, 'published');
    assert.equal(world.publishCalls().length, 1);
  });

  it('(f) a duplicate sandbox decision does not publish twice', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const link = sandboxLink((await sendForProof(app)).body.reviewerUrl);
    await decide(app, link, 'approved');
    const dup = await decide(app, link, 'approved');
    assert.equal(dup.status, 200);
    assert.equal(dup.body.seal.state, 'published');
    assert.equal(world.publishCalls().length, 1);
    const conflicting = await decide(app, link, 'changes_required');
    assert.equal(conflicting.status, 409);
  });

  it('sandbox rejects a wrong secret and an unknown round', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const link = sandboxLink((await sendForProof(app)).body.reviewerUrl);
    assert.equal((await call(app, 'GET', `/sandbox/rounds/${link.id}?t=nope`)).status, 403);
    assert.equal((await decide(app, { ...link, t: 'nope' }, 'approved')).status, 403);
    assert.equal((await call(app, 'GET', `/sandbox/rounds/sbx-missing?t=${link.t}`)).status, 404);
    assert.equal(world.publishCalls().length, 0);
  });

  it('withdraw cancels the round and closes the seal', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const sent = await sendForProof(app);
    const res = await call(app, 'POST', `/api/rounds/${sent.body.round.roundId}/withdraw`, { token: GOOD_TOKEN });
    assert.equal(res.status, 200);
    assert.equal(res.body.seal.state, 'withdrawn');
    const link = sandboxLink(sent.body.reviewerUrl);
    assert.equal((await decide(app, link, 'approved')).status, 409);
    assert.equal(world.publishCalls().length, 0);
    // A new send after withdrawal starts a new seal.
    const next = await sendForProof(app);
    assert.notEqual(next.body.seal.sealId, sent.body.seal.sealId);
    assert.equal(next.body.seal.round, 1);
  });

  it('a second send supersedes the open round; a late decision on it is ignored', async () => {
    const world = createWorld();
    const app = makeApp(world);
    const first = await sendForProof(app);
    const second = await sendForProof(app);
    assert.equal(second.body.seal.round, 2);
    const late = await decide(app, sandboxLink(first.body.reviewerUrl), 'approved');
    assert.equal(late.status, 409); // the sandbox closed the superseded round
    assert.equal(world.publishCalls().length, 0);
  });

  it('never sends the IMS token anywhere but admin.hlx.page and IMS', async () => {
    const world = createWorld();
    const app = makeApp(world);
    await decide(app, sandboxLink((await sendForProof(app)).body.reviewerUrl), 'approved');
    const leaked = world.calls.filter((c) => (c.headers.authorization || '').includes(GOOD_TOKEN)
      && !c.url.startsWith('https://admin.hlx.page/') && !c.url.startsWith('https://ims-na1.adobelogin.com/'));
    assert.deepEqual(leaked, []);
    const md = world.calls.find((c) => c.url.endsWith('.md'));
    assert.equal(md.headers.authorization, undefined);
  });
});

describe('ziflow end-to-end', () => {
  const env = { PROOF_PROVIDER: 'ziflow', ZIFLOW_API_KEY: ZIFLOW_KEY, ZIFLOW_WEBHOOK_SECRET: ZIFLOW_SECRET };

  async function setup() {
    const world = createWorld();
    await world.loadZiflowFixtures();
    const app = makeApp(world, env);
    const sent = await sendForProof(app);
    assert.equal(sent.status, 201);
    assert.equal(sent.body.round.provider, 'ziflow');
    assert.equal(sent.body.reviewerUrl, 'https://app.ziflow.com/proof/zf-proof-1');
    const deliver = async (name, opts) => app.handle(await ziflowWebhook(name, opts));
    return {
      world, app, sent, deliver,
    };
  }

  it('approved webhook publishes', async () => {
    const { world, deliver } = await setup();
    const res = await deliver('webhook-approved.json');
    assert.equal(res.status, 200);
    assert.equal((await res.json()).outcome, 'published');
    assert.equal(world.publishCalls().length, 1);
  });

  it('(e) a bad webhook signature is rejected and nothing happens', async () => {
    const { world, deliver } = await setup();
    const res = await deliver('webhook-approved.json', { signature: 'deadbeef' });
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error.code, 'invalid_signature');
    const wrongKey = await deliver('webhook-approved.json', { secret: 'not-the-secret' });
    assert.equal(wrongKey.status, 401);
    assert.equal(world.publishCalls().length, 0);
  });

  it('(e) webhooks fail closed when no secret is configured', async () => {
    const world = createWorld();
    await world.loadZiflowFixtures();
    const app = makeApp(world, { ...env, ZIFLOW_WEBHOOK_SECRET: '' });
    await sendForProof(app);
    const res = await app.handle(await ziflowWebhook('webhook-approved.json'));
    assert.equal(res.status, 401);
    assert.equal(world.publishCalls().length, 0);
  });

  it('(f) a duplicate webhook delivery does not publish twice', async () => {
    const { world, deliver } = await setup();
    assert.equal((await deliver('webhook-approved.json')).status, 200);
    const dup = await deliver('webhook-approved.json');
    assert.equal(dup.status, 200);
    assert.equal((await dup.json()).reason, 'duplicate_event');
    assert.equal(world.publishCalls().length, 1);
  });

  it('Not relevant -> withdrawn; Changes required -> changes', async () => {
    const a = await setup();
    await a.deliver('webhook-not_relevant.json');
    const seals = await call(a.app, 'GET', `/api/seals?org=${ORG}&site=${SITE}&path=${PATH}`, { token: GOOD_TOKEN });
    assert.equal(seals.body.seal.state, 'withdrawn');
    const b = await setup();
    await b.deliver('webhook-changes_required.json');
    const s2 = await call(b.app, 'GET', `/api/seals?org=${ORG}&site=${SITE}&path=${PATH}`, { token: GOOD_TOKEN });
    assert.equal(s2.body.seal.state, 'changes');
    assert.equal(b.world.publishCalls().length + a.world.publishCalls().length, 0);
  });

  it('feedback comes from Ziflow comments', async () => {
    const { app, sent } = await setup();
    const fb = await call(app, 'GET', `/api/rounds/${sent.body.round.roundId}/feedback`, { token: GOOD_TOKEN });
    assert.equal(fb.status, 200);
    assert.equal(fb.body.items.length, 2);
    assert.deepEqual(fb.body.items[0].author, { name: 'Rita Reviewer', email: 'rita@example.com', external: true });
  });

  it('a webhook for an unknown proof is acknowledged and ignored', async () => {
    const { world, deliver } = await setup();
    const res = await deliver('webhook-approved.json', { proofId: 'zf-proof-999' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).reason, 'unknown_round');
    assert.equal(world.publishCalls().length, 0);
  });
});
