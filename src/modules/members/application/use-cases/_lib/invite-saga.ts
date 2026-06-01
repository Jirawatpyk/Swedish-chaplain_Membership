/**
 * Shared invite-orphan SAGA contract + compensation (go-live #12-13 + follow-up).
 *
 * The three member-invite use-cases — `invitePortal`, `inviteColleague`,
 * `inviteUserForMember` — all share the same shape: F1 `createUser` commits a
 * pending user + invitation + queued invite email in its OWN owner-role tx, then
 * a SEPARATE chamber_app tx links/adds the contact (the role split forbids one
 * atomic tx — chamber_app has no INSERT grant on `invitations`). If the second
 * tx fails AFTER createUser committed, the pending user is orphaned (an active
 * account whose contact stays unlinked → broken member-portal resolution via
 * findByLinkedUserId; redeem-invite never links a contact, so the orphan is
 * permanent).
 *
 * This module is the single home for that shared contract:
 *   - `CreateUserPort` / `DeleteInvitedUserPort` — the narrowed F1 surfaces the
 *     use-cases depend on (typed here, not imported from `@/modules/auth`, to
 *     keep the Application layer free of Infrastructure composition roots; the
 *     route handler wires the real F1 functions at the boundary).
 *   - `compensateInviteOrphan` — rolls the orphan back by deleting the
 *     just-created pending user (by exact id + pending guard) and standardises
 *     the compensation-failure log (PII-safe: the user id is hashed). Callers
 *     keep their own use-case-specific "rolling back" diagnostic log line, then
 *     invoke this; it owns the delete-call args + the failure log so a future
 *     change to the compensation contract lands in ONE place.
 *
 * `invite-portal.ts` re-exports the two port types for backward compatibility
 * with existing consumers (adapters, members-deps, the module barrel).
 */
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';

/**
 * Narrowed F1 `createUser` surface. `role` is constrained to `'member'` so the
 * member-invite endpoints cannot mint staff accounts.
 */
export type CreateUserPort = (input: {
  readonly email: string;
  readonly role: 'member';
  readonly displayName?: string | null;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
  /**
   * Tenant slug carried to F1 `createUser` so the `notifications_outbox` row
   * created inside the F1 tx satisfies the post-0098 NOT NULL + RLS constraints.
   * The members layer always runs inside a known `TenantContext`, so the route
   * handler / use-case threads `deps.tenant.slug` here.
   */
  readonly tenantId: TenantSlug;
}) => Promise<
  | {
      readonly ok: true;
      readonly value: {
        readonly user: { readonly id: string };
        /** Outbox row id for the queued invite email — needed by the SAGA
         *  compensation (go-live #12-13) to drop a dead invite on link failure. */
        readonly outboxRowId: string;
      };
    }
  | { readonly ok: false; readonly error: { readonly code: 'invalid-input' | 'email-taken' | 'invitation-create-failed' } }
>;

/**
 * Narrowed F1 `deleteInvitedUser` surface — the SAGA compensation invoked when
 * the contact step fails after `createUser` committed (go-live #12-13). The port
 * deletes the just-created PENDING user by exact id (+ its queued email), never
 * by email, so it can never touch the wrong / a redeemed account.
 */
export type DeleteInvitedUserPort = (input: {
  readonly userId: string;
  readonly outboxRowId: string;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly targetEmail?: string | undefined;
}) => Promise<{ readonly ok: boolean }>;

export interface CompensateInviteOrphanParams {
  readonly userId: string;
  readonly outboxRowId: string;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  /** For the audit summary only (never used to find the user). */
  readonly targetEmail: string;
  /** Use-case prefix for the compensation-failure log tag (e.g. `invite-portal`). */
  readonly opLabel: string;
}

/**
 * Roll back an orphaned portal invite: delete the just-created pending user
 * (+ FK-cascaded invitation + queued outbox row) via `deleteInvitedUser`.
 *
 * Returns the port's `{ ok }`. On a compensation failure it emits the
 * standardised `<opLabel>.compensation_failed` log (the orphan persists — a
 * rare-of-rare residual the `account_created` audit row still records) so the
 * caller does not duplicate that branch. `deleteInvitedUser` returns a Result
 * and never throws, so this cannot mask the caller's original error.
 *
 * The caller should emit its own use-case-specific "rolling back" diagnostic
 * (contact id, cause, mode, …) BEFORE invoking this.
 */
export async function compensateInviteOrphan(
  deleteInvitedUser: DeleteInvitedUserPort,
  params: CompensateInviteOrphanParams,
): Promise<{ readonly ok: boolean }> {
  const result = await deleteInvitedUser({
    userId: params.userId,
    outboxRowId: params.outboxRowId,
    actorUserId: params.actorUserId,
    sourceIp: params.sourceIp,
    requestId: params.requestId,
    targetEmail: params.targetEmail,
  });
  if (!result.ok) {
    logger.error(
      // PII-safe: hash the user id (consistent across all three use-cases).
      { userIdHash: hashId(params.userId), requestId: params.requestId },
      `${params.opLabel}.compensation_failed: orphan persists — manual reconciliation needed`,
    );
  }
  return result;
}
