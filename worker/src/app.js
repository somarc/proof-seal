import HttpError from './core/errors.js';
import { loadConfig } from './config.js';
import {
  compileOrigins, createRouter, isAllowedOrigin, json, serve,
} from './router.js';
import { createAemClient, parseLocation, siteId } from './core/aem.js';
import { bearerToken, verifyCaller } from './core/auth.js';
import { fingerprint } from './core/fingerprint.js';
import { createSealRepo, openSeal, transition } from './core/seals.js';
import { createGate } from './core/gate.js';
import { createProviderRegistry } from './providers/index.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function normalizeReviewers(list) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 50) throw new HttpError(400, 'bad_request', 'reviewers must be an array of up to 50 entries');
  return list.map((r) => {
    if (!r || !EMAIL.test(r.email || '')) throw new HttpError(400, 'bad_request', 'each reviewer needs a valid email');
    return { email: r.email.trim().toLowerCase(), role: r.role === 'reviewer' ? 'reviewer' : 'approver' };
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'bad_request', 'Body must be JSON');
  }
}

/**
 * Wires config, store, AEM client, providers and the gate into HTTP routes.
 * deps: { env, store, fetch, now?, newId? } (fetch and time are injectable for tests).
 */
export function createApp({
  env = {}, store, fetch, now = () => new Date().toISOString(), newId = () => crypto.randomUUID(),
}) {
  const config = loadConfig(env);
  const origins = compileOrigins(config.allowedOrigins);
  const aem = createAemClient({ fetch });
  const repo = createSealRepo(store);
  const providers = createProviderRegistry({
    env, store, fetch, now, newId,
  });
  const gate = createGate({
    repo,
    aem,
    fetch,
    providers,
    siteKeys: config.siteKeys,
    policyFor: (seal) => config.policyFor(siteId(seal)),
    now,
  });

  const providerForSite = (site) => {
    const id = config.providerFor(site);
    if (!providers.has(id)) throw new HttpError(503, 'provider_not_configured', `Unknown proofing provider "${id}"`);
    return providers.get(id);
  };

  /** Loads a round + seal and verifies the caller against the seal's page. */
  async function authorizedRound(request, roundId) {
    if (!bearerToken(request)) throw new HttpError(401, 'unauthenticated', 'Sign in: an IMS bearer token is required');
    const round = await repo.getRound(roundId);
    const seal = round && await repo.getSeal(round.sealId);
    if (!seal) throw new HttpError(404, 'not_found', 'Unknown round');
    const caller = await verifyCaller(request, seal, { aem, fetch });
    return { round, seal, caller };
  }

  async function health({ request, url }) {
    const org = url.searchParams.get('org');
    const site = url.searchParams.get('site');
    const sid = org && site ? `${org}/${site}`.toLowerCase() : null;
    const providerId = sid ? config.providerFor(sid) : config.defaultProvider;
    let provider = {
      id: providerId, ok: false, detail: `Unknown proofing provider "${providerId}"`, capabilities: null,
    };
    if (providers.has(providerId)) {
      const p = providers.get(providerId);
      const h = await p.health().catch((e) => ({ ok: false, detail: e.message }));
      provider = {
        id: p.id, ok: h.ok, detail: h.detail, capabilities: p.capabilities,
      };
    }
    let storeHint = 'Reachable.';
    try {
      await store.get('health:ping');
      if (store.kind === 'memory') storeHint = 'In-memory store: seals are lost on restart. Bind the APS_STORE KV namespace.';
    } catch {
      storeHint = 'Store read failed.';
    }
    const origin = request.headers.get('origin');
    const checks = [
      {
        id: 'site', ok: Boolean(sid), label: 'Site identified', hint: sid || 'Pass ?org=&site=',
      },
      {
        id: 'provider', ok: provider.ok, label: `Proofing provider: ${provider.id}`, hint: provider.detail,
      },
      {
        id: 'publish-key',
        ok: Boolean(sid && config.siteKeys[sid]),
        label: 'Publish key for this site',
        hint: sid && config.siteKeys[sid]
          ? 'Configured (value hidden).'
          : 'Add "org/site" to the SITE_KEYS secret: an admin API key with role publish.',
      },
      {
        id: 'store',
        ok: storeHint === 'Reachable.',
        label: `Store (${store.kind})`,
        hint: storeHint,
      },
      {
        id: 'origins',
        ok: !origin || isAllowedOrigin(origin, origins),
        label: 'Allowed origins',
        hint: config.allowedOrigins.join(', '),
      },
      {
        id: 'config', ok: config.errors.length === 0, label: 'Configuration parses', hint: config.errors.join('; ') || 'OK',
      },
    ];
    return json({ ok: checks.every((c) => c.ok), provider, checks });
  }

  async function createRound({ request, url }) {
    if (!bearerToken(request)) throw new HttpError(401, 'unauthenticated', 'Sign in: an IMS bearer token is required');
    const body = await readJson(request);
    const loc = parseLocation(body);
    const reviewers = normalizeReviewers(body.reviewers);
    const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : '';
    const { user, status } = await verifyCaller(request, loc, { aem, fetch });
    const provider = providerForSite(siteId(loc));
    const fp = await fingerprint(loc, { fetch, status });
    const at = now();
    const { seal: draft, previousRound } = await openSeal(repo, {
      loc, fp, user, provider: provider.id, at, newId,
    });
    const source = provider.capabilities.liveUrl
      ? { kind: 'url', url: fp.previewUrl }
      : { kind: 'snapshot', url: fp.previewUrl, file: null }; // TODO: capture a snapshot file

    const created = await provider.createRound({
      seal: draft,
      source,
      reviewers,
      previousRound,
      number: draft.round,
      note,
      apiOrigin: url.origin,
    });

    const round = {
      roundId: newId(),
      sealId: draft.sealId,
      number: draft.round,
      provider: provider.id,
      providerRef: created.providerRef,
      reviewerUrl: created.reviewerUrl,
      source: source.kind,
      decision: created.decision || 'pending',
      reviewers: reviewers.map((r) => ({
        name: '', email: r.email, role: r.role, external: true, decision: 'pending', at: null,
      })),
      contentHash: fp.contentHash,
      previewLastModified: fp.previewLastModified,
      note,
      createdBy: { name: user.name, email: user.email },
      createdAt: at,
      updatedAt: at,
      closed: null,
    };
    const seal = {
      ...draft,
      currentRoundId: round.roundId,
      roundIds: [...draft.roundIds, round.roundId],
      updatedAt: at,
    };
    await repo.putRound(round);
    await repo.putSealForPage(seal);

    if (previousRound && !previousRound.closed) {
      await repo.putRound({ ...previousRound, closed: 'superseded', updatedAt: at });
      if (previousRound.provider !== provider.id || !provider.capabilities.versions) {
        await providers.get(previousRound.provider)
          .cancelRound(previousRound.providerRef, `Superseded by round ${round.number}`)
          .catch(() => {});
      }
    }
    await repo.audit(seal, {
      at, type: 'sent', actor: user.email || user.name || 'author', detail: `Round ${round.number} sent to ${provider.id}.`,
    });
    return json({ seal, round, reviewerUrl: round.reviewerUrl }, 201);
  }

  async function getSeal({ request, url }) {
    if (!bearerToken(request)) throw new HttpError(401, 'unauthenticated', 'Sign in: an IMS bearer token is required');
    const q = url.searchParams;
    const loc = parseLocation({
      org: q.get('org'), site: q.get('site'), ref: q.get('ref') || 'main', path: q.get('path'),
    });
    await verifyCaller(request, loc, { aem, fetch });
    const seal = await repo.getSealForPage(loc);
    const rounds = seal ? await repo.roundsOf(seal) : [];
    return json({
      seal,
      rounds,
      latestDecision: rounds[0]?.decision || null,
      audit: await repo.auditTail(loc),
    });
  }

  async function feedback({ request, url, params }) {
    const { round } = await authorizedRound(request, params.id);
    const items = await providers.get(round.provider)
      .listFeedback(round.providerRef, { since: url.searchParams.get('since') || undefined });
    return json({ items });
  }

  async function withdraw({ request, params }) {
    const { round, seal, caller } = await authorizedRound(request, params.id);
    if (round.roundId !== seal.currentRoundId) throw new HttpError(409, 'invalid_state', 'Only the current round can be withdrawn');
    const at = now();
    const next = transition(seal, 'withdrawn', at);
    let cancelError = null;
    await providers.get(round.provider).cancelRound(round.providerRef, 'Withdrawn by the author')
      .catch((e) => { cancelError = e.message; });
    const closed = {
      ...round, decision: 'cancelled', closed: 'withdrawn', updatedAt: at,
    };
    await repo.putRound(closed);
    await repo.putSeal(next);
    await repo.audit(next, {
      at,
      type: 'withdrawn',
      actor: caller.user.email || caller.user.name || 'author',
      detail: `Round ${round.number} withdrawn by the author.`,
      ...(cancelError ? { data: { cancelError } } : {}),
    });
    return json({ seal: next, round: closed });
  }

  async function webhook({ request, params }) {
    if (!providers.has(params.provider)) throw new HttpError(404, 'not_found', 'Unknown provider');
    let event;
    try {
      event = await providers.get(params.provider).parseWebhook(request);
    } catch (e) {
      throw new HttpError(422, 'unprocessable', e.message);
    }
    if (!event) throw new HttpError(401, 'invalid_signature', 'Webhook could not be verified');
    const result = await gate.onEvent(params.provider, event);
    if (result.error) throw new HttpError(502, 'publish_failed', result.error.message);
    return json({ ok: true, outcome: result.outcome, reason: result.reason || null });
  }

  const reviewerSeal = (seal) => seal && ({
    sealId: seal.sealId,
    path: seal.path,
    previewUrl: seal.previewUrl,
    state: seal.state,
    round: seal.round,
  });

  async function sandboxRound({ url, params }) {
    return json(await providers.get('sandbox').reviewerView(params.id, url.searchParams.get('t')));
  }

  async function sandboxDecision({ request, params }) {
    const event = await providers.get('sandbox').submitDecision(params.id, await readJson(request));
    const result = await gate.onEvent('sandbox', event);
    if (result.error) throw new HttpError(502, 'publish_failed', result.error.message);
    let { seal } = result;
    if (!seal) {
      const round = await repo.findRoundByRef('sandbox', params.id);
      seal = round && await repo.getSeal(round.sealId);
    }
    return json({ ok: true, outcome: result.outcome, seal: reviewerSeal(seal) });
  }

  const router = createRouter()
    .add('GET', '/', async () => json({ name: 'proof-seal', ok: true }))
    .add('GET', '/api/health', health)
    .add('POST', '/api/rounds', createRound)
    .add('GET', '/api/seals', getSeal)
    .add('GET', '/api/rounds/:id/feedback', feedback)
    .add('POST', '/api/rounds/:id/withdraw', withdraw)
    .add('POST', '/webhooks/:provider', webhook)
    .add('GET', '/sandbox/rounds/:id', sandboxRound)
    .add('POST', '/sandbox/rounds/:id/decision', sandboxDecision);

  return {
    config,
    gate,
    providers,
    repo,
    handle: (request) => serve(request, { router, origins }),
  };
}

export default createApp;
