/**
 * Application port — Invitation cascade for member lifecycle events.
 *
 * Soft-consumes pending/unredeemed F1 invitations for a set of user ids
 * inside an existing transaction. Used by the archive-member cascade
 * (US7) so that invite links become dead atomically with the status
 * flip — defense-in-depth per spec Edge Cases.
 *
 * Scoped deliberately narrow: this port does NOT expose raw invitation
 * rows (R001 — `invitations.id` is the raw invite token and migration
 * 0017 revokes SELECT on that column from `chamber_app`). The adapter
 * uses `.returning({ userId })` only.
 *
 * Cross-module note: invitations live in F1 (`auth/infrastructure`).
 * The adapter is the single allowed crossing point for F3 use cases;
 * Application-layer callers depend only on this port.
 */
import type { TenantTx } from '@/lib/db';

export interface InvitationCascadePort {
  /**
   * Soft-consume every pending unredeemed invitation whose `user_id`
   * is in `userIds`. "Pending" = `consumed_at IS NULL AND expires_at > NOW()`.
   * Sets `consumed_at = now` — no new schema column required.
   *
   * Returns only the count of revoked rows. Raw invitation token ids
   * are deliberately not returned (R001 column-grant constraint).
   *
   * Safe to call with an empty `userIds` array — returns `{revokedCount: 0}`
   * without issuing a query.
   */
  softConsumePendingForUsersInTx(
    tx: TenantTx,
    userIds: readonly string[],
    now: Date,
  ): Promise<{ revokedCount: number }>;
}
