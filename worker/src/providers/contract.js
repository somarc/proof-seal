/**
 * The proofing seam (docs/proofing-seam.md, §3): six methods plus capabilities.
 *
 * @typedef {'pending'|'approved'|'approved_with_changes'|'changes_required'|'rejected'
 *   |'cancelled'} Decision
 *
 * @typedef {object} Capabilities
 * @property {boolean} liveUrl            reviewers see the live preview URL
 * @property {boolean} snapshot           the tool can proof a captured snapshot
 * @property {boolean} stages             multi-stage workflows
 * @property {boolean} externalReviewers  reviewers without a tool account
 * @property {boolean} pinnedFeedback     comments anchored to a region
 * @property {boolean} webhooks           the tool pushes events (false: in-process)
 * @property {boolean} versions           a new round can be a new version of the same proof
 *
 * @typedef {object} CreateRound
 * @property {object} seal                the Seal being reviewed
 * @property {{kind:'url', url:string}|{kind:'snapshot', url:string, file:any}} source
 * @property {{email:string, role:'approver'|'reviewer'}[]} reviewers
 * @property {any[]} [stages]
 * @property {object} [previousRound]     the seal's previous Round (prefer a new version)
 * @property {number} [number]            round number within the seal
 * @property {string} [note]              author note for reviewers
 * @property {string} [apiOrigin]         origin of this backend (Sandbox reviewer page uses it)
 *
 * @typedef {object} FeedbackItem
 * @property {string} id
 * @property {{name:string, email:string, external:boolean}} author
 * @property {string} body
 * @property {string} createdAt
 * @property {boolean} resolved
 * @property {object} [anchor]
 * @property {string} [thumbnailUrl]
 *
 * @typedef {object} ProofEvent
 * @property {'decision'|'feedback'|'status'} type
 * @property {string} providerRef
 * @property {Decision} [decision]
 * @property {{name?:string, email?:string}} [actor]
 * @property {string} at
 * @property {string} [id]                provider event id, used to drop duplicate deliveries
 * @property {any} raw
 *
 * @typedef {object} ProofProvider
 * @property {string} id
 * @property {Capabilities} capabilities
 * @property {(req: CreateRound) =>
 *   Promise<{providerRef:string, reviewerUrl:string, decision:Decision}>} createRound
 * @property {(providerRef:string) =>
 *   Promise<{decision:Decision, reviewers:any[], updatedAt:string}>} getRound
 * @property {(providerRef:string, opts?:{since?:string}) =>
 *   Promise<FeedbackItem[]>} listFeedback
 * @property {(request: Request) => Promise<ProofEvent|null>} parseWebhook
 *   verifies first; null when invalid
 * @property {(providerRef:string, reason:string) => Promise<void>} cancelRound
 * @property {() => Promise<{ok:boolean, detail:string}>} health
 *
 * Adapter rules: never publish or touch site content; keep tool decision names inside the
 * adapter; parseWebhook is safe to run twice and rejects what it cannot verify; prefer a
 * new version of an existing proof; report capabilities honestly.
 */

export const DECISIONS = Object.freeze([
  'pending',
  'approved',
  'approved_with_changes',
  'changes_required',
  'rejected',
  'cancelled',
]);

export const CAPABILITIES = Object.freeze([
  'liveUrl', 'snapshot', 'stages', 'externalReviewers', 'pinnedFeedback', 'webhooks', 'versions',
]);

const METHODS = ['createRound', 'getRound', 'listFeedback', 'parseWebhook', 'cancelRound', 'health'];

export const isDecision = (value) => DECISIONS.includes(value);

/** Throws when `p` does not have the ProofProvider shape; returns it otherwise. */
export function assertProvider(p) {
  const problems = [];
  if (!p || typeof p !== 'object') throw new TypeError('provider must be an object');
  if (typeof p.id !== 'string' || !p.id) problems.push('id must be a non-empty string');
  METHODS.filter((m) => typeof p[m] !== 'function').forEach((m) => problems.push(`missing method ${m}()`));
  const caps = p.capabilities || {};
  CAPABILITIES.filter((c) => typeof caps[c] !== 'boolean').forEach((c) => problems.push(`capabilities.${c} must be boolean`));
  if (problems.length) throw new TypeError(`Invalid provider "${p.id}": ${problems.join('; ')}`);
  return p;
}
