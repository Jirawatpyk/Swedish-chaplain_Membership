/**
 * resendStaffInvitation use case — Staff Invitation Lifecycle, Task 1.
 *
 * Thin Application wrapper around the shared F1 `reissueInvitation`
 * primitive (see reissue-invitation.ts for the owner-role tx that mints
 * the fresh token + enqueues the outbox email). This use case exists
 * purely to add the STAFF-facing audit trail: `reissueInvitation` itself
 * emits NO audit event (by design — see its header comment) because it is
 * shared by two callers with different audit needs:
 *
 *   - F3 `resendBouncedInvite` (member-portal contact resend) emits its
 *     OWN event, `member_portal_invite_queued`, from inside its Phase 2
 *     `runInTenant` tx.
 *   - This use case (staff-directory "resend invitation" action) emits
 *     `invitation_reissued` instead.
 *
 * Emitting `invitation_reissued` INSIDE `reissueInvitation` would
 * double-audit the F3 caller (both `member_portal_invite_queued` AND
 * `invitation_reissued` for the same mint) — so the audit stays at this
 * use-case level, one layer up.
 *
 * RA-8 (accepted non-atomic edge): `reissueInvitation` owns its own
 * `db.transaction(...)` and does not expose the tx handle to callers, so
 * the audit append here uses the non-tx `AuditRepo.append` AFTER
 * `reissueInvitation` returns `ok`. If the process dies between the
 * commit and the audit insert, the invitation is reissued but unaudited —
 * an accepted gap that mirrors the exact same non-atomic pattern F3's
 * `resendBouncedInvite` already accepts for `member_portal_invite_queued`
 * (see its Phase 2 fail-safe tests). On any `reissueInvitation` error the
 * mapped error is returned WITHOUT auditing — nothing happened, so there
 * is nothing to record.
 */
import { Result, err, ok } from '@/lib/result';
import type { UserId } from '@/modules/auth/domain/branded';
import type { EmailLocale } from '@/modules/auth/infrastructure/email/reset-password-email';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';
// Type-only — `reissue` is injected via deps so this file never imports
// the Infrastructure-touching `reissueInvitation` implementation as a
// runtime value (Clean Architecture — see sign-in.ts for the pattern).
import type { reissueInvitation } from '@/modules/auth/application/reissue-invitation';
import type { AuditRepo } from '@/modules/auth/infrastructure/db/audit-repo';
import { defaultResendStaffInvitationDeps } from '@/lib/auth-deps';

// --- Public types -------------------------------------------------------------

export interface ResendStaffInvitationInput {
  readonly userId: UserId;
  readonly actorUserId: UserId;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: EmailLocale | undefined;
  readonly tenantId: TenantSlug;
}

export interface ResendStaffInvitationSuccess {
  readonly email: string;
}

export type ResendStaffInvitationError =
  /** No user row for `userId` (mapped straight through from reissueInvitation). */
  | { readonly code: 'user-not-found' }
  /** User is no longer `pending` — not eligible for a re-send. */
  | { readonly code: 'not-pending' }
  /** reissueInvitation's own tx failed (mint or outbox enqueue). */
  | { readonly code: 'reissue-failed' };

// --- Dependencies ------------------------------------------------------------

export interface ResendStaffInvitationDeps {
  readonly reissue: typeof reissueInvitation;
  readonly audit: Pick<AuditRepo, 'append'>;
}

export { defaultResendStaffInvitationDeps };

// --- Use case ----------------------------------------------------------------

export async function resendStaffInvitation(
  input: ResendStaffInvitationInput,
  deps: ResendStaffInvitationDeps = defaultResendStaffInvitationDeps,
): Promise<Result<ResendStaffInvitationSuccess, ResendStaffInvitationError>> {
  const result = await deps.reissue({
    userId: input.userId,
    invitedByUserId: input.actorUserId,
    locale: input.locale,
    tenantId: input.tenantId,
    requestId: input.requestId,
  });

  if (!result.ok) {
    const { code } = result.error;
    if (code === 'user-not-found' || code === 'not-pending') {
      return err({ code });
    }
    // `reissue-failed` and any future reissueInvitation error code both
    // collapse to `reissue-failed` here — no state changed, nothing to audit.
    return err({ code: 'reissue-failed' });
  }

  await deps.audit.append({
    eventType: 'invitation_reissued',
    actorUserId: input.actorUserId,
    targetUserId: input.userId,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    summary: `invitation reissued for ${result.value.email}`,
  });

  return ok({ email: result.value.email });
}
