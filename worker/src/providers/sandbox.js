import HttpError from '../core/errors.js';
import { randomToken, timingSafeEqual } from '../core/crypto.js';
import { DECISIONS, isDecision } from './contract.js';

/**
 * Sandbox provider: a fake reviewer for "Try it" and tests. Rounds live in the APS store
 * under `sandbox:round:*`. Reviewers open an EDS-hosted page that calls back into
 * GET/POST /sandbox/rounds/:id with a per-round secret `t`.
 */
export const DEFAULT_SANDBOX_REVIEWER_URL = 'https://main--proof-seal--somarc.aem.live/tools/proof-seal/sandbox-reviewer.html';

const CAPABILITIES = Object.freeze({
  liveUrl: true,
  snapshot: false,
  stages: false,
  externalReviewers: true,
  pinnedFeedback: false,
  webhooks: false, // decisions arrive in-process via /sandbox/rounds/:id/decision
  versions: false, // each round is a new reviewer link; it records `previous` for history
});

const text = (value, max) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

export function createSandboxProvider({
  store, now, newId, reviewerUrl = DEFAULT_SANDBOX_REVIEWER_URL,
}) {
  const key = (ref) => `sandbox:round:${ref}`;

  /** Loads a round and checks its secret. Throws 404/403 HttpErrors. */
  async function load(ref, t) {
    const rec = typeof ref === 'string' && ref.startsWith('sbx-') ? await store.get(key(ref)) : null;
    if (!rec) throw new HttpError(404, 'not_found', 'Unknown sandbox round');
    if (!await timingSafeEqual(String(t || ''), rec.secret)) {
      throw new HttpError(403, 'forbidden', 'Invalid reviewer link');
    }
    return rec;
  }

  /** Verifies and records a reviewer decision; returns a shared ProofEvent. */
  async function accept(ref, body = {}) {
    const rec = await load(ref, body.t);
    const { decision } = body;
    if (!isDecision(decision) || decision === 'pending') {
      throw new HttpError(400, 'bad_request', `decision must be one of ${DECISIONS.filter((d) => d !== 'pending').join(', ')}`);
    }
    if (rec.cancelled) throw new HttpError(409, 'round_closed', `This round was closed: ${rec.cancelled}`);
    if (rec.decision !== 'pending' && rec.decision !== decision) {
      throw new HttpError(409, 'round_decided', `This round was already decided: ${rec.decision}`);
    }
    const actor = {
      name: text(body.reviewer?.name, 200),
      email: text(body.reviewer?.email, 200),
      external: true,
    };
    const at = now();
    if (rec.decision === 'pending') { // replays of the same decision record nothing new
      const comment = text(body.comment, 5000);
      rec.decision = decision;
      rec.updatedAt = at;
      rec.reviewers = [...rec.reviewers, { ...actor, decision, at }];
      if (comment) {
        rec.feedback.push({
          id: newId(), author: actor, body: comment, createdAt: at, resolved: false, decision,
        });
      }
      await store.put(key(ref), rec);
    }
    return {
      type: 'decision',
      id: `${ref}:${rec.decision}`,
      providerRef: ref,
      decision: rec.decision,
      actor,
      at: rec.updatedAt,
      raw: { decision, comment: text(body.comment, 5000) },
    };
  }

  const publicRound = (rec) => ({
    id: rec.providerRef,
    number: rec.number,
    decision: rec.decision,
    reviewers: rec.reviewers,
    note: rec.note,
    previous: rec.previous,
    closed: rec.cancelled || null,
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  });

  return {
    id: 'sandbox',
    capabilities: CAPABILITIES,

    async createRound(req) {
      const providerRef = `sbx-${newId()}`;
      const secret = randomToken();
      const url = new URL(reviewerUrl);
      url.searchParams.set('round', providerRef);
      url.searchParams.set('t', secret);
      if (req.apiOrigin) url.searchParams.set('api', req.apiOrigin);
      const at = now();
      await store.put(key(providerRef), {
        providerRef,
        secret,
        number: req.number || 1,
        seal: {
          path: req.seal.path, previewUrl: req.seal.previewUrl, contentHash: req.seal.contentHash,
        },
        sourceUrl: req.source.url,
        note: text(req.note, 2000),
        previous: req.previousRound?.providerRef || null,
        decision: 'pending',
        reviewers: (req.reviewers || []).map((r) => ({
          name: '', email: r.email, role: r.role, external: true, decision: 'pending', at: null,
        })),
        feedback: [],
        cancelled: null,
        createdAt: at,
        updatedAt: at,
      });
      return { providerRef, reviewerUrl: url.toString(), decision: 'pending' };
    },

    async getRound(providerRef) {
      const rec = await store.get(key(providerRef));
      if (!rec) throw new HttpError(404, 'not_found', 'Unknown sandbox round');
      return { decision: rec.decision, reviewers: rec.reviewers, updatedAt: rec.updatedAt };
    },

    async listFeedback(providerRef, { since } = {}) {
      const rec = await store.get(key(providerRef));
      if (!rec) return [];
      return rec.feedback.filter((f) => !since || f.createdAt > since);
    },

    /** Body: { round, t, decision, comment?, reviewer? }. Returns null when it cannot verify. */
    async parseWebhook(request) {
      try {
        const body = await request.json();
        return await accept(body.round, body);
      } catch {
        return null;
      }
    },

    async cancelRound(providerRef, reason) {
      const rec = await store.get(key(providerRef));
      if (!rec || rec.cancelled) return;
      rec.cancelled = text(reason, 500) || 'cancelled';
      rec.updatedAt = now();
      await store.put(key(providerRef), rec);
    },

    async health() {
      return { ok: true, detail: 'Built-in sandbox reviewer; no credentials needed.' };
    },

    // Sandbox-only helpers for the reviewer page routes.

    /** GET /sandbox/rounds/:id?t= */
    async reviewerView(providerRef, t) {
      const rec = await load(providerRef, t);
      return { round: publicRound(rec), seal: rec.seal, feedback: rec.feedback };
    },

    /** POST /sandbox/rounds/:id/decision; throws HttpError with a precise status. */
    submitDecision: (providerRef, body) => accept(providerRef, body),
  };
}

export default createSandboxProvider;
