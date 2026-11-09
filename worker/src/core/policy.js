import { DECISIONS } from '../providers/contract.js';

/**
 * The seam's policy table: shared Decision -> what the gate does.
 *   approved               -> publish (re-fingerprint first); 'approve' when autoPublish is off
 *   approved_with_changes  -> changes (content must change, so a new round is needed);
 *                             with minorChangesAllowed the seal records that a fix may be
 *                             published after an approver acknowledgement (flow: TODO)
 *   changes_required, rejected -> changes
 *   cancelled              -> withdraw
 *   pending                -> wait
 * Unknown decisions throw: adapters must only emit shared values.
 */
export function decide(decision, { autoPublish = true, minorChangesAllowed = false } = {}) {
  switch (decision) {
    case 'pending':
      return { action: 'wait' };
    case 'approved':
      return { action: autoPublish ? 'publish' : 'approve' };
    case 'approved_with_changes':
      return { action: 'changes', minorFixAllowed: Boolean(minorChangesAllowed) };
    case 'changes_required':
    case 'rejected':
      return { action: 'changes' };
    case 'cancelled':
      return { action: 'withdraw' };
    default:
      throw new Error(`Unknown decision "${decision}" (expected one of ${DECISIONS.join(', ')})`);
  }
}

export default decide;
