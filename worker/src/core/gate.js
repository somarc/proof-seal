import { decide } from './policy.js';
import { fingerprint, sameFingerprint } from './fingerprint.js';
import { siteKeyHeaders, siteId } from './aem.js';
import { transition } from './seals.js';
import HttpError from './errors.js';

const actorName = (actor, fallback) => actor?.email || actor?.name || fallback;

/**
 * The gate: provider event -> policy -> re-fingerprint -> publish or break -> audit.
 * Only this module publishes. Safe to run twice for the same event: events with an id are
 * remembered, and a decision already applied to the current round is a no-op.
 *
 * Known limit: there is a short window between the re-fingerprint and POST /live in which
 * an author could re-preview; the next status read would show it, but the publish has gone.
 */
export function createGate({
  repo, aem, fetch, providers, siteKeys, policyFor, now,
}) {
  const audit = (seal, type, actor, detail, data) => repo.audit(seal, {
    at: now(), type, actor, detail, ...(data ? { data } : {}),
  });

  async function currentFingerprint(seal) {
    const key = siteKeys[siteId(seal)];
    // Admin /status is readable anonymously on public sites; use the site key when we have one.
    const { status, body } = await aem.status(seal, key ? siteKeyHeaders(key) : {});
    // Transient: throw so the seal is untouched and the provider can redeliver.
    if (status !== 200) throw new HttpError(502, 'aem_unavailable', `AEM status returned ${status}`);
    try {
      return await fingerprint(seal, { fetch, status: body });
    } catch (e) {
      if (e.code === 'not_previewed') return null; // preview removed: the reviewed version is gone
      throw e;
    }
  }

  async function breakSeal(seal, round, current, actor) {
    const at = now();
    const broken = { ...transition(seal, 'broken', at), brokenAt: at };
    const closed = { ...round, closed: 'broken', updatedAt: at };
    let cancelError = null;
    try {
      await providers.get(round.provider).cancelRound(round.providerRef, 'Content changed after it was sent for proof');
    } catch (e) {
      cancelError = e.message;
    }
    await repo.putRound(closed);
    await repo.putSeal(broken);
    await audit(broken, 'seal-broken', actor, 'Content changed after it was sent for proof; not published. Send a new round.', {
      expected: { contentHash: seal.contentHash, previewLastModified: seal.previewLastModified },
      actual: current && {
        contentHash: current.contentHash, previewLastModified: current.previewLastModified,
      },
      ...(cancelError ? { cancelError } : {}),
    });
    return { outcome: 'broken', seal: broken, round: closed };
  }

  async function approveAndMaybePublish(seal, round, publish, actor) {
    const current = await currentFingerprint(seal);
    if (!sameFingerprint(seal, current)) return breakSeal(seal, round, current, actor);

    await repo.putRound(round);
    let next = seal.state === 'approved' ? seal : transition(seal, 'approved', now());
    if (!publish) {
      await repo.putSeal(next);
      await audit(next, 'approved', actor, 'Approved; fingerprint matches. Auto-publish is off.');
      return { outcome: 'approved', seal: next, round };
    }
    const key = siteKeys[siteId(seal)];
    if (!key) {
      await repo.putSeal(next);
      await audit(next, 'publish-blocked', actor, `Approved, but no publish key is configured for ${siteId(seal)}.`);
      return { outcome: 'publish-blocked', seal: next, round };
    }
    try {
      await aem.publish(seal, key);
    } catch (e) {
      await repo.putSeal(next);
      await audit(next, 'publish-failed', actor, e.message);
      return {
        outcome: 'publish-failed', seal: next, round, error: e,
      };
    }
    const at = now();
    next = { ...transition(next, 'published', at), publishedAt: at };
    await repo.putSeal(next);
    await audit(next, 'published', actor, `Published round ${round.number} to live.`);
    return { outcome: 'published', seal: next, round };
  }

  async function apply(providerId, event) {
    const round = await repo.findRoundByRef(providerId, event.providerRef);
    if (!round) return { outcome: 'ignored', reason: 'unknown_round' };
    const seal = await repo.getSeal(round.sealId);
    const actor = actorName(event.actor, providerId);

    if (event.type !== 'decision') {
      await repo.putRound({ ...round, updatedAt: now() });
      return {
        outcome: 'ignored', reason: `${event.type}_event`, seal, round,
      };
    }
    if (round.roundId !== seal.currentRoundId || round.closed) {
      return {
        outcome: 'ignored', reason: 'stale_round', seal, round,
      };
    }
    const retryingPublish = seal.state === 'approved' && event.decision === 'approved';
    if (!['in-review', 'changes'].includes(seal.state) && !retryingPublish) {
      return {
        outcome: 'ignored', reason: `seal_${seal.state}`, seal, round,
      };
    }
    if (round.decision === event.decision && seal.state !== 'approved') {
      return {
        outcome: 'ignored', reason: 'duplicate', seal, round,
      };
    }

    const policy = decide(event.decision, policyFor(seal));
    const at = now();
    const decided = {
      ...round,
      decision: event.decision,
      updatedAt: at,
      reviewers: [
        ...(round.reviewers || []),
        ...(event.actor ? [{
          name: event.actor.name || '',
          email: event.actor.email || '',
          external: event.actor.external !== false,
          decision: event.decision,
          at: event.at || at,
        }] : []),
      ],
    };
    // The round is saved together with its outcome, so a failed step can be redelivered.
    switch (policy.action) {
      case 'wait':
        await repo.putRound(decided);
        return { outcome: 'pending', seal, round: decided };
      case 'changes': {
        await repo.putRound(decided);
        const next = {
          ...(seal.state === 'changes' ? seal : transition(seal, 'changes', at)),
          minorFixAllowed: Boolean(policy.minorFixAllowed),
        };
        await repo.putSeal(next);
        await audit(next, 'changes-requested', actor, `Round ${round.number}: ${event.decision.replace(/_/g, ' ')}.`);
        return { outcome: 'changes', seal: next, round: decided };
      }
      case 'withdraw': {
        const next = transition(seal, 'withdrawn', at);
        await repo.putRound({ ...decided, closed: 'cancelled' });
        await repo.putSeal(next);
        await audit(next, 'withdrawn', actor, `Round ${round.number} was cancelled in ${providerId}.`);
        return { outcome: 'withdrawn', seal: next, round: decided };
      }
      default:
        return approveAndMaybePublish(seal, decided, policy.action === 'publish', actor);
    }
  }

  return {
    /** Feed one normalized event from provider `providerId` through the gate. */
    async onEvent(providerId, event) {
      if (!event) return { outcome: 'ignored', reason: 'invalid_event' };
      if (event.id && await repo.seenEvent(providerId, event.id)) {
        return { outcome: 'ignored', reason: 'duplicate_event' };
      }
      const result = await apply(providerId, event);
      if (event.id && !result.error) await repo.markEvent(providerId, event.id, now());
      return result;
    },
  };
}

export default createGate;
