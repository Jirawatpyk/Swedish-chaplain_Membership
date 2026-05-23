/**
 * Application port — re-issue a fresh invitation for an existing pending
 * user (backs F3 `resendBouncedInvite`).
 *
 * Self-contained OWNER-ROLE operation: the adapter delegates to the F1
 * `reissueInvitation` use-case, which mints the invitation row + enqueues
 * the outbox email inside its OWN `db.transaction(...)` (owner role,
 * BYPASSRLS). It does NOT accept the caller's `runInTenant` tx handle —
 * the `invitations` table is owner-role-only for INSERT (migrations
 * 0016/0017 least-privilege; chamber_app must not be able to forge
 * invitation rows — 0183 transiently GRANTed INSERT, 0184 REVOKEd it, net
 * grant is still none). This mirrors the existing `CreateUserPort`
 * precedent used by `invitePortal`.
 *
 * Cross-module note: keeps the F3 Application layer free of direct
 * `@/modules/auth` infrastructure imports (Constitution Principle III).
 * The route handler wires the concrete adapter at the boundary.
 *
 * Two-live-tokens note: the old (bounced) invitation is NOT invalidated.
 * The bounce means Resend never delivered the old plaintext token, so it
 * was never in a user's hands; it expires naturally within ≤7 days. The
 * first redeemed token wins; the other is a no-op (consumed_at set). This
 * matches the reset-password "single-live-token" rule, which invalidates
 * prior tokens only for RESET (FR-005), not for invitations.
 */
import type { Result } from '@/lib/result';
import type { TenantSlug } from '@/modules/tenants/domain/tenant-slug';

export type ReissueInvitationInput = {
  /** Existing pending user (contact.linkedUserId) to re-invite. */
  readonly userId: string;
  /** Admin triggering the re-send (invitation-row correlation). */
  readonly invitedByUserId: string;
  readonly locale: 'en' | 'th' | 'sv';
  /** Chamber slug stamped on the outbox row. */
  readonly tenantId: TenantSlug;
  readonly requestId: string;
};

export type ReissueInvitationResult = {
  /** Hashed invitation-row id (sha256). Safe for audit correlation. */
  readonly invitationId: string;
};

/**
 * Mirrors the F1 `ReissueInvitationError` codes so the F3 use-case can
 * map them to caller-facing `not_eligible` reasons.
 */
export type ReissueInvitationPortError =
  | { readonly code: 'user_not_found' }
  | { readonly code: 'not_pending' }
  | { readonly code: 'reissue_failed'; readonly cause?: unknown };

export interface ReissueInvitationPort {
  reissue(
    input: ReissueInvitationInput,
  ): Promise<Result<ReissueInvitationResult, ReissueInvitationPortError>>;
}
