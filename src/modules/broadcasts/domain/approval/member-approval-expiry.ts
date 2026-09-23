/**
 * F119 — the member's approval clock (FR-022, FR-022a; data-model § 3).
 *
 * A version sent to the member starts a 30-day clock on the row's
 * `stage_entered_at`: reminders on day 3 and day 7, a warning on day 23,
 * and the automatic closure `expired_no_member_response` on day 30. The
 * send response (T059) and the portal detail (T141a) show `expiresAt`; the
 * daily lifecycle tick (T130) closes the row on the same instant.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */

export const MEMBER_APPROVAL_EXPIRY_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The instant an E-Blast awaiting the member closes unanswered. */
export function memberApprovalExpiresAt(stageEnteredAt: Date): Date {
  return new Date(stageEnteredAt.getTime() + MEMBER_APPROVAL_EXPIRY_DAYS * DAY_MS);
}
