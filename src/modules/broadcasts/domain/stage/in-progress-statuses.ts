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

/**
 * F119 T166 R-H1 — has the dispatcher already handed an `approved` row over,
 * although its status has not moved yet? The dispatch leg locks the row, then
 * COMMITS and calls the provider with no lock held, persisting what it made as
 * it goes: `resend_broadcast_id` before the send (legacy leg),
 * `audience_import_id` before the import is sent (import leg). Either one set
 * means a send is in flight or done — an exit from `approved` that is not
 * terminal (a withdrawn approval, a cancelled or re-timed schedule, a new
 * working copy) must then answer `sending_started`, or the next round would
 * inherit the id and be recorded as sent without ever going out.
 *
 * `resend_audience_id` alone does NOT count: an audience is reused across a
 * failed tick by design and carries no send.
 */
export function hasDispatchBegun(row: {
  readonly resendBroadcastId: string | null;
  readonly audienceImportId: string | null;
}): boolean {
  return row.resendBroadcastId !== null || row.audienceImportId !== null;
}

/**
 * F119 T132 — the in-progress stages that exist ONLY inside the
 * member-approval round (migration 0305): a row in one of them is in flight
 * whatever `FEATURE_EBLAST_MEMBER_APPROVAL` says. Research R18's "flag ON or
 * rows exist" rule reads this set — with the flag off, a surface that would
 * otherwise stay dark (the nav's waiting count) still shows while any row is
 * here, so an in-flight E-Blast is never invisible to the people who must act
 * on it. `expired_no_member_response` is not in it: it is closed, and nobody
 * acts on a closed row.
 */
export const APPROVAL_ROUND_STATUSES = [
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
] as const satisfies readonly (typeof IN_PROGRESS_BROADCAST_STATUSES)[number][];

const IN_PROGRESS_SET: ReadonlySet<BroadcastStatus> = new Set(IN_PROGRESS_BROADCAST_STATUSES);

/** Is the E-Blast in progress — reserving its allowance place, withdrawable, cascade-cancellable? */
export function isInProgress(status: BroadcastStatus): boolean {
  return IN_PROGRESS_SET.has(status);
}
