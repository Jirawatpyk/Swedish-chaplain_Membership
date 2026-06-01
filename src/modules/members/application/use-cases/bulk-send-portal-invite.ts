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
 * Per-member outcomes (3 buckets, no abort-on-error):
 *   - invited — F1 user + invitation queued; the contact is linked.
 *   - skipped — an EXPECTED precondition the admin can resolve:
 *       already_linked · no_email · no_invitable_contact · member_archived ·
 *       member_not_found.
 *   - failed  — bad contact data or a transient fault:
 *       invalid_email · email_taken · server_error.
 *
 * Idempotent: re-running on an already-invited member returns `already_linked`
 * → skipped (no duplicate user / outbox row). Tenant-scoped: every repo read is
 * RLS-bound via `deps.tenant`; a cross-tenant member id misses → member_not_found.
 *
 * Pure Application — orchestrates ports + the `invitePortal` use case; zero
 * drizzle/next/react imports.
 */
import { z } from 'zod';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import { asMemberId } from '../../domain/member';
import type { MemberRepo } from '../ports/member-repo';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import { invitePortal, type CreateUserPort } from './invite-portal';
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

export type InviteFailCode = 'invalid_email' | 'email_taken' | 'server_error';

export type BulkSendPortalInviteOutput = {
  readonly invited: ReadonlyArray<{
    readonly memberId: string;
    readonly contactId: string;
    readonly userId: string;
    readonly email: string;
  }>;
  readonly skipped: ReadonlyArray<{ readonly memberId: string; readonly reason: InviteSkipReason }>;
  readonly failed: ReadonlyArray<{ readonly memberId: string; readonly code: InviteFailCode }>;
  readonly counts: {
    readonly invited: number;
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
  readonly audit: Pick<AuditPort, 'record'>;
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
  const skipped: Array<{ memberId: string; reason: InviteSkipReason }> = [];
  const failed: Array<{ memberId: string; code: InviteFailCode }> = [];

  for (const rawId of data.member_ids) {
    const memberId = asMemberId(rawId);

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

    // 2. Find the primary live contact (the invite recipient). listByMember with
    //    includeRemoved:false already excludes soft-deleted rows.
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
    const res = await invitePortal(
      {
        tenant: deps.tenant,
        contactRepo: deps.contactRepo,
        createUser: deps.createUser,
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
      // Best-effort bulk-correlation audit. The invite itself is already audited
      // by F1 `account_created`; this row links the queued invite to the bulk
      // operation (bulk_request_id) for the admin timeline. A failure here must
      // NOT fail the invite — it is already queued + unrecallable.
      const auditRes = await deps.audit.record(deps.tenant, {
        type: 'member_portal_invite_queued',
        actorUserId: meta.actorUserId,
        requestId: meta.requestId,
        summary: `bulk portal invite queued for member ${rawId}`,
        payload: {
          member_id: rawId,
          contact_id: primary.contactId,
          action: 'send_portal_invite',
          bulk_request_id: meta.requestId,
        },
      });
      if (!auditRes.ok) {
        logger.warn(
          { requestId: meta.requestId, memberId: rawId, err: auditRes.error.code },
          'bulk-invite: correlation audit failed (invite already queued)',
        );
      }
      continue;
    }

    switch (res.error.code) {
      case 'already_linked':
        skipped.push({ memberId: rawId, reason: 'already_linked' });
        break;
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
      default:
        logger.error(
          { requestId: meta.requestId, memberId: rawId, err: res.error.code },
          'bulk-invite: invitePortal server_error',
        );
        failed.push({ memberId: rawId, code: 'server_error' });
        break;
    }
  }

  return ok({
    invited,
    skipped,
    failed,
    counts: { invited: invited.length, skipped: skipped.length, failed: failed.length },
  });
}
