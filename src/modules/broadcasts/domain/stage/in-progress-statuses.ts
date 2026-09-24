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
 * F119 T081 follow-up — the statuses of an E-Blast that was CLOSED WITHOUT
 * EVER BEING SENT. Its own content no longer holds the images it embeds: the
 * image sweep's last-reference rule (`isBlobReferencedByContent`) skips it.
 *
 * T081 stamps a rejected / withdrawn E-Blast's `broadcast_images` rows so "the
 * bytes go on the next sweep" (spec § Personal data, FR-015). The row keeps
 * its body — the immutability trigger forbids redacting it — so while its own
 * body counted as a reference the sweep restored every such image to live and
 * the `broadcast_image_removed` audit row was false.
 *
 * Decided for every status (an EXCLUSION list, so a new status counts as a
 * reference until someone says otherwise — the fail-safe direction):
 *   - holds: `draft`, every in-progress status (still editable / sendable);
 *     `sending`, `sent`, `partially_sent`, `partial_delivery_accepted` (a
 *     delivered email still loads its images); `failed_to_dispatch` (also
 *     reachable through `sending`, so something may have gone out);
 *   - lets go: the three below.
 *
 * Infrastructure that needs the set as SQL literals derives it from here.
 */
export const CLOSED_NEVER_SENT_BROADCAST_STATUSES = [
  'rejected',
  'cancelled',
  'expired_no_member_response',
] as const satisfies readonly BroadcastStatus[];

const CLOSED_NEVER_SENT_SET: ReadonlySet<BroadcastStatus> = new Set(CLOSED_NEVER_SENT_BROADCAST_STATUSES);

/**
 * Does this E-Blast's content (its body, and its versions' bodies) still hold
 * the images it embeds? False only for a closed-never-sent status with NO
 * hand-over evidence: a row that entered `sending`, or that the dispatcher had
 * already handed over (`hasDispatchBegun` — a historical batch cancel, or a
 * cancel that raced the dispatcher), may have delivered email that still loads
 * those images, so it keeps them.
 */
export function holdsImageReferences(row: {
  readonly status: BroadcastStatus;
  readonly sendingStartedAt: Date | null;
  readonly resendBroadcastId: string | null;
  readonly audienceImportId: string | null;
}): boolean {
  return !CLOSED_NEVER_SENT_SET.has(row.status) || row.sendingStartedAt !== null || hasDispatchBegun(row);
}

/**
 * F119 T132 — the in-progress stages that exist ONLY inside the
 * member-approval round (migration 0308): a row in one of them is in flight
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
