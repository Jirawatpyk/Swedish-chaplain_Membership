/**
 * Spec 139 (review round 1 CR#5) — the fixed tokens a send-time standing
 * refusal writes into `broadcasts.failure_reason` (`_dispatch-standing-gate.ts`:
 * a halted member → `member_halted`; a member whose membership ended, or who
 * is erased or gone → `member_not_in_good_standing`).
 *
 * A Domain value object because the erasure content scrub
 * (`scrubContentForMemberInTx`) KEEPS a `failure_reason` that is exactly one
 * of these: a system token, not text anyone typed or a gateway echoed, so it
 * carries no PII and still says why the row ended. Any other value is NULLed.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const STANDING_REFUSAL_FAILURE_REASONS = ['member_halted', 'member_not_in_good_standing'] as const;

export type StandingRefusalFailureReason = (typeof STANDING_REFUSAL_FAILURE_REASONS)[number];
