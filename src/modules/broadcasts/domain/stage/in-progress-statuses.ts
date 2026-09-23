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
