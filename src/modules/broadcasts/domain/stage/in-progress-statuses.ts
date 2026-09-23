/**
 * F119 T053 — the ONE Domain constant for "in progress" (research R7,
 * data-model § 9).
 *
 * An E-Blast in one of these statuses holds the member's allowance
 * (reserved), can still be withdrawn or rejected (FR-015), and is swept by
 * the erasure/cancel cascade. Rounds do not multiply the cost: the allowance
 * belongs to the broadcast row, and there is one row however many versions it
 * carries.
 *
 * Neither in progress nor terminal: `draft` (nothing reserved until submit)
 * and `sending` (past the withdrawal cut-off — the delivery provider has it).
 * `expired_no_member_response` is terminal and frees the allowance.
 *
 * Infrastructure that needs this set in a raw SQL `IN (...)` MUST derive it
 * from here (the Finding-G pattern of `TERMINAL_BROADCAST_STATUSES`), so the
 * quota count, the cancel cascade and the UI cannot disagree about it.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import type { BroadcastStatus } from '../value-objects/broadcast-status';

export const IN_PROGRESS_BROADCAST_STATUSES = [
  'submitted',
  'approved',
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
] as const satisfies readonly BroadcastStatus[];


/**
 * F119 T081 — the statuses from which "sending has begun" (FR-015: the
 * hand-over to the delivery provider, i.e. entry into `sending`, and every
 * status only reachable THROUGH `sending`). A withdrawal, a rejection or a
 * withdrawn approval is answered `sending_started` here, and the send
 * completes.
 *
 * `failed_to_dispatch` is deliberately NOT in the set: it is also reached
 * from `approved` directly (a dispatch that never handed anything over), so
 * "the send is under way" would be false there. It keeps the refusal of a
 * closed E-Blast. Disjoint from `IN_PROGRESS_BROADCAST_STATUSES` by
 * construction (pinned by `cancel-cutoff-policy.test.ts`).
 */
export const SENDING_STARTED_BROADCAST_STATUSES = [
  'sending',
  'sent',
  'partially_sent',
  'partial_delivery_accepted',
] as const satisfies readonly BroadcastStatus[];

const SENDING_STARTED_SET: ReadonlySet<BroadcastStatus> = new Set(SENDING_STARTED_BROADCAST_STATUSES);

export function hasSendingStarted(status: BroadcastStatus): boolean {
  return SENDING_STARTED_SET.has(status);
}

const IN_PROGRESS_SET: ReadonlySet<BroadcastStatus> = new Set(IN_PROGRESS_BROADCAST_STATUSES);

/** Is the E-Blast in progress — reserving its allowance place, withdrawable, cascade-cancellable? */
export function isInProgress(status: BroadcastStatus): boolean {
  return IN_PROGRESS_SET.has(status);
}
