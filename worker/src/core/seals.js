import HttpError from './errors.js';
import { pageId } from './aem.js';

/**
 * Seal state machine (docs/proofing-seam.md §2):
 *   in-review -> changes | approved | broken | withdrawn | in-review (a newer round)
 *   changes   -> in-review (new round) | approved (decision revised) | broken | withdrawn
 *   approved  -> published | broken | withdrawn | in-review (new round)
 *   broken    -> in-review (new round) | withdrawn
 *   published, withdrawn: terminal (the next send starts a new seal)
 */
export const TRANSITIONS = Object.freeze({
  'in-review': ['in-review', 'changes', 'approved', 'broken', 'withdrawn'],
  changes: ['in-review', 'approved', 'broken', 'withdrawn'],
  approved: ['in-review', 'published', 'broken', 'withdrawn'],
  broken: ['in-review', 'withdrawn'],
  published: [],
  withdrawn: [],
});

export const OPEN_STATES = ['in-review', 'changes', 'approved', 'broken'];

export const canTransition = (from, to) => (TRANSITIONS[from] || []).includes(to);

export function transition(seal, to, at) {
  if (!canTransition(seal.state, to)) {
    throw new HttpError(409, 'invalid_state', `Seal cannot go from ${seal.state} to ${to}`);
  }
  return { ...seal, state: to, updatedAt: at };
}

const AUDIT_MAX = 200;

/** Store layout for seals, rounds, the provider-ref index, audit and seen events. */
export function createSealRepo(store) {
  const repo = {
    getSeal: (sealId) => store.get(`seal:${sealId}`),
    putSeal: (seal) => store.put(`seal:${seal.sealId}`, seal),
    async getSealForPage(loc) {
      const sealId = await store.get(`page:${pageId(loc)}`);
      return sealId ? repo.getSeal(sealId) : null;
    },
    async putSealForPage(seal) {
      await repo.putSeal(seal);
      await store.put(`page:${pageId(seal)}`, seal.sealId);
    },
    getRound: (roundId) => store.get(`round:${roundId}`),
    async putRound(round) {
      await store.put(`round:${round.roundId}`, round);
      await store.put(`ref:${round.provider}:${round.providerRef}`, round.roundId);
    },
    async findRoundByRef(provider, providerRef) {
      const roundId = await store.get(`ref:${provider}:${providerRef}`);
      return roundId ? repo.getRound(roundId) : null;
    },
    /** Rounds of a seal, newest first. */
    async roundsOf(seal) {
      const rounds = await Promise.all((seal.roundIds || []).map((id) => repo.getRound(id)));
      return rounds.filter(Boolean).sort((a, b) => b.number - a.number);
    },
    audit: (loc, entry) => store.append(`audit:${pageId(loc)}`, entry, { max: AUDIT_MAX }),
    async auditTail(loc, n = 50) {
      const list = (await store.get(`audit:${pageId(loc)}`)) || [];
      return list.slice(-n).reverse();
    },
    seenEvent: (provider, id) => store.get(`event:${provider}:${id}`),
    markEvent: (provider, id, at) => store.put(`event:${provider}:${id}`, at),
  };
  return repo;
}

/**
 * Continue the page's open seal with a new round, or start a new seal when there is none
 * or the last one is published/withdrawn. Returns { seal, previousRound } (not yet saved).
 */
export async function openSeal(repo, {
  loc, fp, user, provider, at, newId,
}) {
  const existing = await repo.getSealForPage(loc);
  if (existing && OPEN_STATES.includes(existing.state)) {
    const previousRound = existing.currentRoundId
      ? await repo.getRound(existing.currentRoundId)
      : null;
    const seal = {
      ...transition(existing, 'in-review', at),
      ...fp,
      provider,
      round: existing.round + 1,
    };
    return { seal, previousRound };
  }
  const seal = {
    sealId: newId(),
    org: loc.org,
    site: loc.site,
    ref: loc.ref,
    path: loc.path,
    ...fp,
    provider,
    round: 1,
    state: 'in-review',
    createdBy: { name: user.name || '', email: user.email || '' },
    createdAt: at,
    updatedAt: at,
    roundIds: [],
    currentRoundId: null,
  };
  return { seal, previousRound: null };
}
