/**
 * `mark-invitation-bounced` use case — F3 spec § Edge Cases.
 *
 * When the F1 invitation email to a contact bounces (Resend `email.bounced`),
 * mark the contact's invitation failed (stamp `contacts.invite_bounced_at`)
 * and append the `invitation_bounced` audit event — atomically, in the
 * contact's OWNER tenant. The `invitations` table has no failure state of its
 * own, so the contact column is the canonical marker.
 *
 * Idempotent: a re-delivered bounce hits the repo's `invite_bounced_at IS NULL`
 * guard → `affected: 0` → no duplicate audit row, no error.
 *
 * Tenant resolution is the orchestrator's job (the webhook is tenant-agnostic
 * — see `infrastructure/handle-invitation-bounce.ts`); this use-case runs once
 * per resolved (tenant, contact) tuple, inside that tenant's RLS scope.
 */
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ContactId } from '../../domain/contact';
import type { MemberId } from '../../domain/member';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import type { RepoError } from '../ports/member-repo';
import { UseCaseAbort } from '../tx-abort';
import { hashEmail } from '../crypto-helpers';

/**
 * Seeded system actor (migration 0181) for the tenant-agnostic Resend webhook,
 * which has no human actor. FK target for `audit_log.actor_user_id` on
 * `invitation_bounced` events. Mirrors F5's SYSTEM_ACTOR_STRIPE_WEBHOOK.
 */
export const SYSTEM_ACTOR_RESEND_WEBHOOK =
  '00000000-0000-0000-0000-0000000f5002';

export type MarkInvitationBouncedInput = {
  readonly contactId: ContactId;
  readonly memberId: MemberId;
  readonly toEmail: string;
  readonly requestId: string;
  readonly bouncedAt: Date;
};

export type MarkInvitationBouncedError = {
  type: 'server_error';
  message: string;
};

export type MarkInvitationBouncedDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly audit: AuditPort;
};

export async function markInvitationBounced(
  deps: MarkInvitationBouncedDeps,
  input: MarkInvitationBouncedInput,
): Promise<Result<{ marked: boolean }, MarkInvitationBouncedError>> {
  try {
    const marked = await runInTenant(deps.tenant, async (tx) => {
      const res = await deps.contactRepo.markInviteBouncedInTx(
        tx,
        input.contactId,
        input.bouncedAt,
      );
      if (!res.ok) throw new UseCaseAbort<RepoError>(res.error);
      // Idempotent no-op: already marked / removed / not found → no audit row.
      if (res.value.affected === 0) return false;

      const audit = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'invitation_bounced',
        actorUserId: SYSTEM_ACTOR_RESEND_WEBHOOK,
        requestId: input.requestId,
        summary: `invitation_bounced ${input.contactId}`,
        payload: {
          // NOTE: deliberately NO `member_id` key. The migration-0009 AFTER
          // INSERT trigger bumps members.last_activity_at for any audit payload
          // carrying `member_id` — but an invitation BOUNCE is a negative
          // signal and must NOT register as member activity (it would inflate
          // the directory "recently active" sort + reset the F8 at-risk
          // staleness). The member is still resolvable via contact_id.
          contact_id: input.contactId,
          // PDPA/GDPR: audit_log is append-only, 5y retention — store the
          // hashed email (project convention; see change-contact-email).
          // The plaintext is still forensically resolvable via contact_id.
          to_email_hash: hashEmail(input.toEmail),
        },
      });
      if (!audit.ok) throw new UseCaseAbort<RepoError>(audit.error);
      return true;
    });
    return ok({ marked });
  } catch (e) {
    if (e instanceof UseCaseAbort) {
      const re = e.error as RepoError;
      return err({ type: 'server_error', message: re.code });
    }
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
