/**
 * Resend-invite use case — F3 spec § Edge Cases + Cluster 3 re-invite fix.
 *
 * Re-sends a portal invitation that has reached a dead-end. Two triggers:
 *   - BOUNCED: the invitation email bounced (`contacts.invite_bounced_at`
 *     is set), the original F3 § Edge Cases path.
 *   - LAPSED (Cluster 3, 2026-07-12): the invite expired unaccepted
 *     (`invitations.consumed_at` still NULL, `expires_at < now`) so the
 *     linked user is still `pending`. No bounce flag is required — the
 *     `invite_bounced_at` guard was removed so an expired-but-pending
 *     contact can also be re-invited.
 *
 * In both cases the admin clicks "Re-send invitation" and this mints a
 * fresh token for the still-`pending` linked user.
 *
 * Two-phase design (mirrors the reviewed `invitePortal` precedent):
 *
 *   Phase 1 — OWNER ROLE (F1 `reissueInvitation` via the port):
 *     mint a fresh invitation row + enqueue the outbox email atomically
 *     in F1's own `db.transaction`. The `invitations` table is owner-role
 *     only for INSERT (migrations 0016/0017 — chamber_app must NOT be able
 *     to forge invitation rows; 0183 transiently GRANTed INSERT, 0184
 *     REVOKEd it — net grant is still none), so this CANNOT run inside
 *     `runInTenant`.
 *
 *   Phase 2 — chamber_app (`runInTenant`): clear `invite_bounced_at` +
 *     emit the `member_portal_invite_queued` audit event in one short tx.
 *
 * Fail-safe ordering: Phase 1 runs FIRST. If it fails, nothing changed —
 * the bounced flag is still set and the admin can retry. If Phase 1
 * succeeds but Phase 2 fails, the email is already in flight; we log a
 * breadcrumb and still return ok. The badge persists until the admin
 * refreshes; a retry sends a harmless second email (the first redeemed
 * token wins). This is the exact orphan-tolerance pattern `invitePortal`
 * uses for its post-createUser contact link.
 *
 * Two-live-tokens: the old (bounced, undelivered) invitation is NOT
 * invalidated — it expires within ≤7 days. See `reissue-invitation.ts`.
 *
 * Authorisation: admin-only (enforced at the API layer). `actorUserId` is
 * taken verbatim for the audit payload.
 *
 * Audit event: `member_portal_invite_queued` (existing F3 + DB enum
 * value) — adding a new event type would need a DB enum migration for no
 * extra forensic value; the payload carries `new_invitation_id`.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { ContactId } from '../../domain/contact';
import type { AuditPort } from '../ports/audit-port';
import type { ContactRepo } from '../ports/contact-repo';
import type { ClockPort } from '../ports/clock-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { ReissueInvitationPort } from '../ports/reissue-invitation-port';

export type ResendBouncedInviteDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly userEmails: UserEmailPort;
  readonly reissueInvitation: ReissueInvitationPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
};

export type ResendBouncedInviteInput = {
  readonly contactId: ContactId;
  /**
   * The member the contact is expected to belong to (from the URL path).
   * Asserted against the loaded contact so a mismatched-but-same-tenant
   * `{memberId, contactId}` pair in the URL cannot trigger a resend.
   */
  readonly memberId: string;
  readonly actorUserId: string;
  readonly requestId: string;
  /**
   * Optional locale override. When omitted, the re-sent invitation email
   * uses the recipient's `contact.preferredLanguage` — so a Thai/Swedish
   * invitee whose first invite bounced gets the re-invite in their own
   * language (mirrors `invitePortal`'s `input.locale ?? preferredLanguage`).
   */
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
};

export type ResendBouncedInviteError =
  | { readonly code: 'not_found' }
  | {
      readonly code: 'not_eligible';
      // Cluster 3 (2026-07-12): `not_bounced` was dropped — the bounce-state
      // guard is gone (a lapsed-but-pending invite is re-sendable without a
      // bounce), so this use-case never produces that reason. Only the two
      // reachable reasons remain.
      readonly reason: 'no_linked_user' | 'already_active';
    }
  | { readonly code: 'server_error'; readonly cause?: unknown };

export type ResendBouncedInviteOutput = {
  readonly contactId: ContactId;
  readonly invitationId: string;
};

export async function resendBouncedInvite(
  deps: ResendBouncedInviteDeps,
  input: ResendBouncedInviteInput,
): Promise<Result<ResendBouncedInviteOutput, ResendBouncedInviteError>> {
  // --- Pre-flight guards (read-only) ---

  // 1. Load contact.
  const contactResult = await deps.contactRepo.findById(
    deps.tenant,
    input.contactId,
  );
  if (!contactResult.ok) {
    if (contactResult.error.code === 'repo.not_found') {
      return err({ code: 'not_found' });
    }
    return err({ code: 'server_error', cause: contactResult.error });
  }
  const contact = contactResult.value;

  // 1b. Path-param consistency: the contact must belong to the member in
  //     the URL. Mismatch → 404 (don't reveal it exists under another
  //     member). Same-tenant only (RLS), but keeps the two path params
  //     honest and the audit's member_id trustworthy.
  if (contact.memberId !== input.memberId) {
    return err({ code: 'not_found' });
  }

  // 2. Must have a linked F1 user (invitation was previously sent).
  if (!contact.linkedUserId) {
    return err({ code: 'not_eligible', reason: 'no_linked_user' });
  }
  const userId = contact.linkedUserId;

  // Cluster 3 (2026-07-12): NO `invite_bounced_at` requirement. This
  // use-case now re-sends a BOUNCED *or* an EXPIRED-BUT-STILL-PENDING
  // invitation — both are dead-ends the admin must be able to recover
  // from. Eligibility is gated purely by "linked + still pending" below.
  // Phase 2's `clearInviteBouncedInTx` is a harmless no-op when the flag
  // is already null (the lapsed-but-not-bounced case).

  // 3. Linked user must still be pending. Fast pre-check that avoids
  //    opening an owner-role tx for an obviously-ineligible user; the
  //    F1 reissue use-case re-checks this authoritatively in-tx (TOCTOU
  //    lock) and returns `not_pending` on a redeem race.
  const pendingCheck = await deps.userEmails.isUserPending(userId);
  if (!pendingCheck.ok) {
    return err({ code: 'server_error', cause: pendingCheck.error });
  }
  if (!pendingCheck.value) {
    return err({ code: 'not_eligible', reason: 'already_active' });
  }

  // --- Phase 1 (OWNER ROLE): mint + enqueue the new invitation email ---
  // Deliver in the recipient's own language unless an explicit override
  // is supplied (mirrors invitePortal). The admin's UI locale is not the
  // right choice for a member-facing invitation email.
  const locale = input.locale ?? contact.preferredLanguage;
  const reissued = await deps.reissueInvitation.reissue({
    userId,
    invitedByUserId: input.actorUserId,
    locale,
    tenantId: deps.tenant.slug,
    requestId: input.requestId,
  });
  if (!reissued.ok) {
    switch (reissued.error.code) {
      case 'user_not_found':
        // Row vanished between the contact link and now — treat as 404.
        return err({ code: 'not_found' });
      case 'not_pending':
        // Lost the redeem race after our pre-check passed.
        return err({ code: 'not_eligible', reason: 'already_active' });
      case 'reissue_failed':
        return err({ code: 'server_error', cause: reissued.error.cause });
    }
  }
  const { invitationId } = reissued.value;

  // --- Phase 2 (chamber_app): clear the bounced flag + audit ---
  // Email is already in flight. A failure here leaves the badge visible
  // (admin retries → harmless second email); we log + still return ok,
  // mirroring invitePortal's orphan tolerance.
  const now = deps.clock.now();
  try {
    const finalised = await runInTenant(deps.tenant, async (tx) => {
      const cleared = await deps.contactRepo.clearInviteBouncedInTx(
        tx,
        input.contactId,
      );
      if (!cleared.ok) {
        return cleared;
      }
      return deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_portal_invite_queued',
        actorUserId: input.actorUserId,
        targetUserId: userId,
        requestId: input.requestId,
        summary: `bounced invitation re-sent for contact ${input.contactId}`,
        payload: {
          member_id: contact.memberId,
          contact_id: input.contactId,
          user_id: userId,
          new_invitation_id: invitationId,
          resend: true,
          ts: now.toISOString(),
        },
      });
    });
    if (!finalised.ok) {
      logger.error(
        {
          contactId: input.contactId,
          userId,
          invitationId,
          cause: finalised.error,
          requestId: input.requestId,
        },
        'resend-bounced-invite.finalise_failed: invitation re-sent but bounce-flag clear / audit did not commit',
      );
    }
  } catch (e) {
    // A throw here (e.g. runInTenant could not acquire a connection)
    // rolls back Phase 2, but Phase 1 already committed — the email is in
    // flight. Surface a breadcrumb and still return ok: the bounced badge
    // persists until refresh, and a retry sends a harmless second email.
    logger.error(
      {
        contactId: input.contactId,
        userId,
        invitationId,
        errMessage: e instanceof Error ? e.message : String(e),
        requestId: input.requestId,
      },
      'resend-bounced-invite.finalise_threw: invitation re-sent but bounce-flag clear / audit threw',
    );
  }

  return ok({ contactId: input.contactId, invitationId });
}
