/**
 * pruneExpiredInvitations use case — Staff Invitation Lifecycle, Task 6.
 *
 * Bulk-deletes long-dead `pending` invited users so their email frees up
 * for a fresh invite and the `users` table doesn't accumulate permanently
 * unredeemed rows. Cron-driven (Task 7, separate, wires the actual
 * `/api/internal/cron/...` route) — `now` + `requestId` are threaded in
 * by the caller rather than read from `Date.now()` / generated here, so
 * this use case stays deterministic and testable.
 *
 * RA-4 (design review, 2026-07-18) — Resend (`reissueInvitation`, Task 1)
 * mints a NEW `invitations` row WITHOUT deleting the old one, so a single
 * pending user can carry BOTH a long-expired original token and a fresh
 * one. Pruning on "the user's oldest/latest invitation is past cutoff"
 * would risk deleting a just-resent user and permanently breaking their
 * activation link. The actual SQL guard (a two-part NOT EXISTS / EXISTS
 * correlated subquery — "no invitation is still live relative to the
 * grace cutoff") lives in `deletePendingInvitesExpiredBeforeInTx` — see
 * its JSDoc in `user-repo.ts` for the full reasoning; this use case only
 * consumes the already-filtered result.
 *
 * Outbox cleanup is cross-tenant by construction: a pruned user is gone
 * system-wide (the row backing their identity no longer exists), so
 * unlike `revokeInvitation` (a single admin action with one tenant in the
 * request context) there is no one tenant to scope the by-email
 * `notifications_outbox` cleanup to — the same email could have a queued
 * `member_invitation` row in several tenants (one person invited to
 * multiple chambers), and ALL of them are now for an account that can
 * never activate. `deleteInviteOutboxByEmailAllTenantsInTx` drops every
 * still-`pending` `member_invitation` row for the email regardless of
 * `tenant_id`.
 *
 * Ordering inside the tx is deliberately TWO-PHASE, not a single
 * interleaved loop (outbox-delete, audit, outbox-delete, audit, ...):
 * `audit.appendInTx` never throws across its own boundary, but per
 * `audit-repo.ts`'s documented contract, an internal DB failure inside it
 * still poisons the surrounding transaction — every statement AFTER that
 * point (including a REAL, non-swallowed statement like the next user's
 * outbox delete) would then fail for real and abort the whole batch. All
 * outbox deletes therefore run FIRST (phase 1, real mutations only), and
 * all audit emits run LAST (phase 2, back-to-back at the tail) — this
 * generalises the accepted "two back-to-back appendInTx calls at the
 * tail" precedent in reset-password.ts from N=2 to N=however many rows
 * were pruned in this run.
 *
 * No error variant: this is a best-effort maintenance sweep, not a
 * user-triggered action with failure modes to report — hence
 * `Result<Success, never>`.
 */
import { Result, ok } from '@/lib/result';
import { db } from '@/lib/db';
import { asUserId } from '@/modules/auth/domain/branded';
import type { UserRepo } from '@/modules/auth/infrastructure/db/user-repo';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultPruneExpiredInvitationsDeps } from '@/lib/auth-deps';

const DEFAULT_GRACE_DAYS = 30;
const MS_PER_DAY = 86_400_000;

// --- Public types -------------------------------------------------------------

export interface PruneExpiredInvitationsInput {
  readonly now: Date;
  /**
   * Days past an invitation's `expires_at` before its pending user
   * becomes prune-eligible. Defaults to 30.
   */
  readonly graceDays?: number;
  readonly requestId: string;
}

export interface PruneExpiredInvitationsSuccess {
  readonly prunedCount: number;
}

// --- Dependencies --------------------------------------------------------------

export interface PruneExpiredInvitationsDeps {
  readonly users: Pick<
    UserRepo,
    'deletePendingInvitesExpiredBeforeInTx' | 'deleteInviteOutboxByEmailAllTenantsInTx'
  >;
  readonly audit: Pick<AuditRepo, 'appendInTx'>;
}

export { defaultPruneExpiredInvitationsDeps };

// --- Use case ----------------------------------------------------------------

export async function pruneExpiredInvitations(
  input: PruneExpiredInvitationsInput,
  deps: PruneExpiredInvitationsDeps = defaultPruneExpiredInvitationsDeps,
): Promise<Result<PruneExpiredInvitationsSuccess, never>> {
  const graceDays = input.graceDays ?? DEFAULT_GRACE_DAYS;
  const cutoff = new Date(input.now.getTime() - graceDays * MS_PER_DAY);

  const prunedCount = await db.transaction(async (tx) => {
    const pruned = await deps.users.deletePendingInvitesExpiredBeforeInTx(tx, cutoff);

    // Phase 1 — real mutations only. See header comment for why this is
    // NOT interleaved with the audit loop below.
    for (const p of pruned) {
      await deps.users.deleteInviteOutboxByEmailAllTenantsInTx(tx, p.email);
    }

    // Phase 2 — audit emits, back-to-back, at the tail of the tx.
    for (const p of pruned) {
      await deps.audit.appendInTx(tx, {
        eventType: 'invitation_expired',
        actorUserId: 'system:cron',
        targetUserId: asUserId(p.userId),
        requestId: input.requestId,
        summary: `pending invite pruned (expired > ${graceDays}d) for ${p.email}`,
      });
    }

    return pruned.length;
  });

  return ok({ prunedCount });
}
