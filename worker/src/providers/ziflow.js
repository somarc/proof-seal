import HttpError from '../core/errors.js';
import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../core/crypto.js';

/**
 * ZIFLOW_ASSUMPTIONS: every field name, path and header this adapter relies on that has
 * NOT yet been checked against a live Ziflow account. Written from public docs; the Day-1
 * spike fixes them here, in one place, together with test/fixtures/ziflow/*.json.
 */
export const ZIFLOW_ASSUMPTIONS = {
  // VERIFY: base domain from the public API docs.
  baseUrl: 'https://api.ziflow.io/v1',
  // VERIFY: docs recommend "Header API key" auth; header name assumed to be `apikey`.
  authHeader: 'apikey',
  paths: {
    // VERIFY: POST creates a proof from source URLs (Ziflow downloads/captures the URL).
    createProof: '/proofs',
    proof: (id) => `/proofs/${encodeURIComponent(id)}`,
    comments: (id) => `/proofs/${encodeURIComponent(id)}/comments`,
    // VERIFY: endpoint for a new version of an existing proof. Set to null to always create a
    // new proof per round. Assumes each version gets its own proof id (else stale-version
    // webhooks could hit the newest round).
    newVersion: (id) => `/proofs/${encodeURIComponent(id)}/versions`,
    // VERIFY: no documented "cancel"; assumed PATCH status. Could be DELETE or a lock call.
    cancel: (id) => ({ method: 'PATCH', path: `/proofs/${encodeURIComponent(id)}`, body: { status: 'locked' } }),
    // VERIFY: any cheap authenticated GET that fails on a bad key.
    health: '/proofs?limit=1',
  },
  // VERIFY: create-proof body field names (name, source URLs, website mode, stages/members).
  createBody: ({
    name, url, mode, reviewers, note,
  }) => ({
    name,
    source_urls: [url],
    website_mode: mode, // 'live' | 'snapshot'
    message: note || undefined,
    stages: [{
      name: 'Proof Seal review',
      members: reviewers.map((r) => ({ email: r.email, role: r.role === 'approver' ? 'approver' : 'reviewer' })),
    }],
  }),
  // VERIFY: website proofs are "live" (interactive) by default for APS; 'snapshot' also documented.
  websiteMode: 'live',
  // VERIFY: field paths on the proof object (dot paths).
  proof: {
    id: 'id',
    reviewerUrl: 'public_link',
    decision: 'decision',
    updatedAt: 'updated_at',
    reviewers: 'reviewers', // [{ name, email, decision, decision_date }]
  },
  // VERIFY: field paths on a comment (response may be an array or { comments: [] }).
  comment: {
    list: 'comments',
    id: 'id',
    body: 'content',
    authorName: 'author.name',
    authorEmail: 'author.email',
    authorExternal: 'author.is_guest',
    createdAt: 'created_at',
    resolved: 'resolved',
  },
  // VERIFY: the standard decision labels from the docs; "Not relevant" -> cancelled.
  decisions: {
    Approved: 'approved',
    'Approved with changes': 'approved_with_changes',
    'Changes required': 'changes_required',
    'Not relevant': 'cancelled',
  },
  // VERIFY: how "no decision yet" is represented.
  pendingDecisions: ['', 'Pending', 'No decision'],
  webhook: {
    // VERIFY: header name from the docs.
    signatureHeader: 'x-ziflow-signature',
    // VERIFY: public docs describe sha256(key + METHOD + urlEncoded(webhookUri) + rawBody)
    // ('sha256-concat'). 'hmac-body' = HMAC-SHA256(key, rawBody) is the alternative.
    signatureScheme: 'sha256-concat',
    // VERIFY: payload is { events: [ ... ] }; field paths inside one event.
    events: 'events',
    eventId: 'id',
    eventType: 'event_type',
    decisionEventTypes: ['proof_decision_made', 'decision_made'],
    proofId: 'proof.id',
    decision: 'decision',
    actorName: 'user.name',
    actorEmail: 'user.email',
    at: 'created_at',
  },
};

const A = ZIFLOW_ASSUMPTIONS;

const pick = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

/** Ziflow decision label -> shared Decision. Unknown labels throw (keep names in the adapter). */
export function mapDecision(label) {
  if (label == null || A.pendingDecisions.includes(label)) return 'pending';
  const decision = A.decisions[label];
  if (!decision) throw new Error(`Unknown Ziflow decision "${label}"`);
  return decision;
}

/** VERIFY: "URL-encoded webhook URI": origin + path kept, query keys/values percent-encoded. */
export function encodeWebhookUri(uri) {
  const url = new URL(uri);
  const query = [...url.searchParams.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
}

/** Computes the expected signature for a delivery (exported for tests and the spike). */
export async function ziflowSignature(secret, { method, uri, body }) {
  if (A.webhook.signatureScheme === 'hmac-body') return hmacSha256Hex(secret, body);
  return sha256Hex(`${secret}${method.toUpperCase()}${encodeWebhookUri(uri)}${body}`);
}

export function createZiflowProvider({
  fetch, apiKey, webhookSecret, webhookUrl,
}) {
  async function call(method, path, body) {
    if (!apiKey) throw new HttpError(503, 'provider_not_configured', 'ZIFLOW_API_KEY is not set');
    const res = await fetch(`${A.baseUrl}${path}`, {
      method,
      headers: {
        [A.authHeader]: apiKey,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new HttpError(502, 'provider_error', `Ziflow ${method} ${path.split('?')[0]} returned ${res.status}`);
    return res.status === 204 ? {} : res.json().catch(() => ({}));
  }

  const mapReviewers = (list) => (Array.isArray(list) ? list : []).map((r) => ({
    name: r.name || '',
    email: r.email || '',
    external: Boolean(r.is_guest ?? true),
    decision: mapDecision(r.decision),
    at: r.decision_date || null,
  }));

  const mapEvent = (e) => {
    const isDecision = A.webhook.decisionEventTypes.includes(pick(e, A.webhook.eventType));
    const providerRef = String(pick(e, A.webhook.proofId) ?? '');
    const at = pick(e, A.webhook.at) || new Date().toISOString();
    const decision = isDecision ? mapDecision(pick(e, A.webhook.decision)) : undefined;
    return {
      type: isDecision ? 'decision' : 'status',
      id: String(pick(e, A.webhook.eventId) ?? `${providerRef}:${decision}:${at}`),
      providerRef,
      ...(isDecision ? { decision } : {}),
      actor: { name: pick(e, A.webhook.actorName) || '', email: pick(e, A.webhook.actorEmail) || '' },
      at,
      raw: e,
    };
  };

  return {
    id: 'ziflow',
    capabilities: Object.freeze({
      liveUrl: true, // VERIFY: live website proofs
      snapshot: true,
      stages: true,
      externalReviewers: true,
      pinnedFeedback: true,
      webhooks: true,
      versions: Boolean(A.paths.newVersion),
    }),

    async createRound(req) {
      const payload = A.createBody({
        name: `${req.seal.site}${req.seal.path} (round ${req.number || 1})`,
        url: req.source.url,
        mode: req.source.kind === 'snapshot' ? 'snapshot' : A.websiteMode,
        reviewers: req.reviewers || [],
        note: req.note,
      });
      const prev = req.previousRound?.provider === 'ziflow' ? req.previousRound.providerRef : null;
      const proof = prev && A.paths.newVersion
        ? await call('POST', A.paths.newVersion(prev), payload)
        : await call('POST', A.paths.createProof, payload);
      const providerRef = pick(proof, A.proof.id);
      if (!providerRef) throw new HttpError(502, 'provider_error', 'Ziflow did not return a proof id');
      return {
        providerRef: String(providerRef),
        reviewerUrl: pick(proof, A.proof.reviewerUrl) || '',
        decision: mapDecision(pick(proof, A.proof.decision)),
      };
    },

    async getRound(providerRef) {
      const proof = await call('GET', A.paths.proof(providerRef));
      return {
        decision: mapDecision(pick(proof, A.proof.decision)),
        reviewers: mapReviewers(pick(proof, A.proof.reviewers)),
        updatedAt: pick(proof, A.proof.updatedAt) || null,
      };
    },

    async listFeedback(providerRef, { since } = {}) {
      const res = await call('GET', A.paths.comments(providerRef));
      const list = Array.isArray(res) ? res : (pick(res, A.comment.list) || []);
      const c = A.comment;
      return list.map((item) => ({
        id: String(pick(item, c.id)),
        author: {
          name: pick(item, c.authorName) || '',
          email: pick(item, c.authorEmail) || '',
          external: Boolean(pick(item, c.authorExternal)),
        },
        body: pick(item, c.body) || '',
        createdAt: pick(item, c.createdAt) || null,
        resolved: Boolean(pick(item, c.resolved)),
      })).filter((f) => !since || (f.createdAt && f.createdAt > since));
    },

    /**
     * Verifies the signature over the raw body (fails closed without a secret), then returns
     * the first decision event in the delivery (else the first event as a status event).
     * Throws only for a verified payload with an unknown decision label.
     */
    async parseWebhook(request) {
      if (!webhookSecret) return null;
      const signature = request.headers.get(A.webhook.signatureHeader);
      if (!signature) return null;
      const body = await request.text();
      const expected = await ziflowSignature(webhookSecret, {
        method: request.method, uri: webhookUrl || request.url, body,
      });
      if (!await timingSafeEqual(signature.trim().toLowerCase(), expected)) return null;
      let payload;
      try {
        payload = JSON.parse(body);
      } catch {
        return null;
      }
      const events = pick(payload, A.webhook.events);
      const list = Array.isArray(events) ? events : [payload];
      const isDecision = (e) => A.webhook.decisionEventTypes.includes(pick(e, A.webhook.eventType));
      const chosen = list.find(isDecision) || list[0];
      return chosen ? mapEvent(chosen) : null;
    },

    async cancelRound(providerRef) {
      const { method, path, body } = A.paths.cancel(providerRef);
      await call(method, path, body);
    },

    async health() {
      if (!apiKey) return { ok: false, detail: 'ZIFLOW_API_KEY is not set.' };
      if (!webhookSecret) return { ok: false, detail: 'ZIFLOW_WEBHOOK_SECRET is not set; Ziflow webhooks would be rejected.' };
      try {
        await call('GET', A.paths.health);
        return { ok: true, detail: 'Ziflow API key accepted.' };
      } catch (e) {
        return { ok: false, detail: e.message };
      }
    },
  };
}

export default createZiflowProvider;
