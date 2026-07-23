/**
 * `bulk-send-portal-invite` use case (go-live P1-17 / FR-018).
 *
 * Real bulk portal-invite dispatch (replaces the audit-only stub that used to
 * live in `bulkAction`'s `send_portal_invite` switch arm). For each member it
 * reuses the EXACT single-invite path — `invitePortal` — which delegates to F1
 * `createUser` (pending user + 7-day invitation token + a `notifications_outbox`
 * row enqueued INSIDE the F1 owner-role tx). The existing `/api/cron/outbox-
 * dispatch` cron is the sole email sender + throttle; this use case writes NO
 * email and adds NO throttling code.
 *
 * Why a separate use case (not a `bulkAction` switch arm): `chamber_app` has no
 * INSERT grant on `invitations`, so the per-member `createUser` owner-role tx
 * CANNOT join `bulkAction`'s all-or-nothing `runInTenant(tx)`. Invites are also
 * BEST-EFFORT per member (a queued invite cannot be un-queued), the opposite of
 * archive/change_plan's atomic semantics — so they must not share a transaction.
 *
 * Per-member outcomes (4 buckets, no abort-on-error):
 *   - invited — F1 user + invitation queued; the contact is linked.
 *   - resent  — the contact was already linked to a `pending` F1 user whose
 *       invitation expired unaccepted: `resendBouncedInvite` minted a FRESH
 *       token (Phase D / Task 13). Separate from `invited` because no user
 *       was created.
 *   - skipped — an EXPECTED precondition the admin can resolve:
 *       already_linked · no_email · no_invitable_contact · member_archived ·
 *       member_not_found.
 *   - failed  — bad contact data or a transient fault:
 *       invalid_email · email_taken · link_failed · server_error.
 *       (link_failed = the contact link faulted AFTER createUser committed; the
 *        invite was rolled back by SAGA compensation so no orphan persists.)
 *
 * Idempotent: re-running on an already-invited member with an ACTIVE portal
 * user returns `already_linked` → skipped (no duplicate user / outbox row).
 * A member whose invitation expired while still `pending` falls through to
 * `resendBouncedInvite` instead of being skipped — the needs-invite chip
 * counts exactly these members, so skipping them all would promise work the
 * bulk action refuses to do. Tenant-scoped: every repo read is RLS-bound via
 * `deps.tenant`; a cross-tenant member id misses → member_not_found.
 *
 * Pure Application — orchestrates ports + the `invitePortal` /
 * `resendBouncedInvite` use cases; zero drizzle/next/react imports.
 */
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { asMemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { UserEmailPort } from '../ports/user-email-port';
import type { ReissueInvitationPort } from '../ports/reissue-invitation-port';
import { invitePortal, type CreateUserPort, type DeleteInvitedUserPort } from './invite-portal';
import { resendBouncedInvite } from './resend-bounced-invite';
import { BULK_CAP } from './bulk-action';

export const bulkSendPortalInviteSchema = z
  .object({
    action: z.literal('send_portal_invite'),
    member_ids: z
      .array(z.string().uuid())
      .min(1, 'At least one member_id is required')
      .max(BULK_CAP, `Cannot exceed ${BULK_CAP} members per batch`),
  })
  .strict()
  .superRefine((data, ctx) => {
    // Same duplicate guard as bulkAction: a repeated id would double-invite.
    const unique = new Set(data.member_ids);
    if (unique.size !== data.member_ids.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['member_ids'],
        message: 'member_ids must be unique',
      });
    }
  });

export type BulkSendPortalInviteInput = z.infer<typeof bulkSendPortalInviteSchema>;

export type InviteSkipReason =
  | 'already_linked'
  | 'no_email'
  | 'no_invitable_contact'
  | 'member_archived'
  | 'member_not_found';

export type InviteFailCode = 'invalid_email' | 'email_taken' | 'link_failed' | 'server_error';

export type BulkSendPortalInviteOutput = {
  readonly invited: ReadonlyArray<{
    readonly memberId: string;
    readonly contactId: string;
    readonly userId: string;
    readonly email: string;
  }>;
  /**
   * Members whose primary contact already had a pending user with a dead
   * (expired) invitation: a FRESH token was minted via resendBouncedInvite.
   * Separate from `invited` because no user was created — the API response
   * gains a field and removes none, so existing consumers keep working.
   */
  readonly resent: ReadonlyArray<{ readonly memberId: string; readonly contactId: string }>;
  readonly skipped: ReadonlyArray<{ readonly memberId: string; readonly reason: InviteSkipReason }>;
  readonly failed: ReadonlyArray<{ readonly memberId: string; readonly code: InviteFailCode }>;
  readonly counts: {
    readonly invited: number;
    readonly resent: number;
    readonly skipped: number;
    readonly failed: number;
  };
};

/** Use-case-level failures (input validation only — member outcomes are buckets). */
export type BulkSendPortalInviteError =
  | { readonly type: 'invalid_body'; readonly issues: ReadonlyArray<{ path: string; message: string }> }
  | { readonly type: 'bulk_cap_exceeded'; readonly count: number };

export type BulkSendPortalInviteDeps = {
  readonly tenant: TenantContext;
  readonly memberRepo: Pick<MemberRepo, 'findById'>;
  readonly contactRepo: ContactRepo;
  readonly createUser: CreateUserPort;
  /** SAGA compensation for the invite orphan window (go-live #12-13). */
  readonly deleteInvitedUser: DeleteInvitedUserPort;
  /**
   * Phase D / Task 13 — deps `resendBouncedInvite` needs when the
   * `already_linked` arm falls through to it for an expired-but-pending
   * invitation. All already provided by `buildMembersDeps`.
   */
  readonly reissueInvitation: ReissueInvitationPort;
  readonly userEmails: UserEmailPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
};

export type BulkSendPortalInviteMeta = {
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string;
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
};

export async function bulkSendPortalInvite(
  input: unknown,
  meta: BulkSendPortalInviteMeta,
  deps: BulkSendPortalInviteDeps,
): Promise<Result<BulkSendPortalInviteOutput, BulkSendPortalInviteError>> {
  const parsed = bulkSendPortalInviteSchema.safeParse(input);
  if (!parsed.success) {
    return err({
      type: 'invalid_body',
      issues: parsed.error.issues.map((i) => ({
        path: i.path.join('.'),
        message: i.message,
      })),
    });
  }
  const data = parsed.data;
  // Defense-in-depth — zod already caps.
  if (data.member_ids.length > BULK_CAP) {
    return err({ type: 'bulk_cap_exceeded', count: data.member_ids.length });
  }

  const invited: Array<{ memberId: string; contactId: string; userId: string; email: string }> = [];
  const resent: Array<{ memberId: string; contactId: string }> = [];
  const skipped: Array<{ memberId: string; reason: InviteSkipReason }> = [];
  const failed: Array<{ memberId: string; code: InviteFailCode }> = [];

  for (const rawId of data.member_ids) {
    const memberId = asMemberId(rawId);
    // BEST-EFFORT: F1 `createUser` re-RAISES unexpected DB/network faults
    // (create-user.ts: "re-raise so the route handler maps it to 500"), and
    // invitePortal's `runInTenant(linkUserInTx)` can also throw. A thrown error
    // must NOT abort the batch — bucket THIS member as failed + continue, so the
    // members already queued (unrecallable) keep their result and the rest are
    // still attempted. (bulkAction gets this via one top-level catch around its
    // single tx; the per-member dispatch here needs a per-member catch.)
    try {
      // 1. Resolve the member (RLS-scoped). A cross-tenant / missing id → skip.
      const memberRes = await deps.memberRepo.findById(deps.tenant, memberId);
      if (!memberRes.ok) {
        if (memberRes.error.code === 'repo.not_found') {
          skipped.push({ memberId: rawId, reason: 'member_not_found' });
          continue;
        }
        logger.error(
          { requestId: meta.requestId, memberId: rawId, err: memberRes.error.code },
          'bulk-invite: member lookup failed',
        );
        failed.push({ memberId: rawId, code: 'server_error' });
        continue;
      }
      if (memberRes.value.status === 'archived') {
        skipped.push({ memberId: rawId, reason: 'member_archived' });
        continue;
      }

      // 2. Find the primary live contact (the invite recipient). listByMember
      //    with includeRemoved:false already excludes soft-deleted rows.
      const contactsRes = await deps.contactRepo.listByMember(deps.tenant, memberId, {
        includeRemoved: false,
      });
      if (!contactsRes.ok) {
        logger.error(
          { requestId: meta.requestId, memberId: rawId, err: contactsRes.error.code },
          'bulk-invite: contact list failed',
        );
        failed.push({ memberId: rawId, code: 'server_error' });
        continue;
      }
      const primary = contactsRes.value.find((c) => c.isPrimary);
      if (!primary) {
        skipped.push({ memberId: rawId, reason: 'no_invitable_contact' });
        continue;
      }

      // 3. Reuse the proven single-invite path (one shared dispatch code path).
      //    invitePortal → F1 createUser enqueues the notifications_outbox row;
      //    the existing outbox-dispatch cron sends + throttles it. No dedicated
      //    F3 audit is emitted here: the invite is recorded by F1 account_created
      //    (exactly like the single-invite path), and a member-scoped F3 audit
      //    would also bump members.last_activity_at via the migration-0009
      //    trigger — falsely resetting the at-risk clock for bulk-invited members.
      const res = await invitePortal(
        {
          tenant: deps.tenant,
          contactRepo: deps.contactRepo,
          createUser: deps.createUser,
          deleteInvitedUser: deps.deleteInvitedUser,
        },
        {
          contactId: primary.contactId,
          actorUserId: meta.actorUserId,
          sourceIp: meta.sourceIp,
          requestId: meta.requestId,
          ...(meta.locale !== undefined ? { locale: meta.locale } : {}),
        },
      );

      if (res.ok) {
        invited.push({
          memberId: rawId,
          contactId: primary.contactId as string,
          userId: res.value.userId,
          email: res.value.email,
        });
        continue;
      }

      switch (res.error.code) {
        case 'already_linked': {
          // The contact is linked, but that covers two very different states:
          // an ACTIVE portal user (nothing to do) and a PENDING user whose
          // invitation expired unaccepted (needs a fresh token). The chip
          // counts the latter, so skipping them all would promise work the
          // bulk action refuses to do.
          //
          // resendBouncedInvite distinguishes them for us: it returns
          // not_eligible/already_active when the user has activated.
          const resend = await resendBouncedInvite(
            {
              tenant: deps.tenant,
              contactRepo: deps.contactRepo,
              userEmails: deps.userEmails,
              reissueInvitation: deps.reissueInvitation,
              audit: deps.audit,
              clock: deps.clock,
            },
            {
              contactId: primary.contactId,
              memberId: rawId,
              actorUserId: meta.actorUserId,
              requestId: meta.requestId,
              ...(meta.locale !== undefined ? { locale: meta.locale } : {}),
            },
          );
          if (resend.ok) {
            resent.push({ memberId: rawId, contactId: primary.contactId as string });
            break;
          }
          if (resend.error.code === 'server_error') {
            logger.error(
              { requestId: meta.requestId, memberId: rawId },
              'bulk-invite: re-send failed',
            );
            failed.push({ memberId: rawId, code: 'server_error' });
            break;
          }
          // not_found / not_eligible (already_active | no_linked_user) →
          // the pre-existing behaviour.
          skipped.push({ memberId: rawId, reason: 'already_linked' });
          break;
        }
        case 'no_email':
          skipped.push({ memberId: rawId, reason: 'no_email' });
          break;
        case 'not_found':
          // The primary contact vanished between the list and the invite (race).
          skipped.push({ memberId: rawId, reason: 'no_invitable_contact' });
          break;
        case 'invalid_email':
          failed.push({ memberId: rawId, code: 'invalid_email' });
          break;
        case 'email_taken':
          failed.push({ memberId: rawId, code: 'email_taken' });
          break;
        case 'link_failed':
          // The invite was rolled back (SAGA compensation) — no orphan persists.
          // Surfaced as its own failed code so the operator sees a link fault
          // distinct from a generic server error and can re-invite cleanly.
          logger.error(
            { requestId: meta.requestId, memberId: rawId },
            'bulk-invite: contact link failed — invite rolled back (compensated)',
          );
          failed.push({ memberId: rawId, code: 'link_failed' });
          break;
        default:
          logger.error(
            { requestId: meta.requestId, memberId: rawId, err: res.error.code },
            'bulk-invite: invitePortal server_error',
          );
          failed.push({ memberId: rawId, code: 'server_error' });
          break;
      }
    } catch (e) {
      // A genuinely-unexpected throw (createUser re-raise on connection
      // loss/timeout, or linkUserInTx tx fault). Never abort the batch.
      logger.error(
        { requestId: meta.requestId, memberId: rawId, errKind: errKind(e) },
        'bulk-invite: unexpected error — member bucketed as failed',
      );
      failed.push({ memberId: rawId, code: 'server_error' });
    }
  }

  return ok({
    invited,
    resent,
    skipped,
    failed,
    counts: {
      invited: invited.length,
      resent: resent.length,
      skipped: skipped.length,
      failed: failed.length,
    },
  });
}
