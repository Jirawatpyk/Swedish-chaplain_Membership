/**
 * `invite-colleague` use case — FR-015, US5 AS4 (T119).
 *
 * A signed-in member who is the primary contact of their member
 * company may invite a colleague as a secondary contact. This
 * wraps the F1 `createUser` port (same as `invite-portal.ts`)
 * but additionally creates a Contact row scoped to the inviter's
 * member_id.
 *
 * Gating: only primary contacts may invite. Non-primary → forbidden.
 */

import { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { type MemberId } from '../../domain/member';
import type { Contact, ContactId, PreferredLanguage } from '../../domain/contact';
import { asEmail } from '../../domain/value-objects/email';
import type { ContactRepo } from '../ports/contact-repo';
import type { RepoError } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import type { MembershipAccessPort } from '../ports/membership-access-port';
import {
  compensateInviteOrphan,
  type CreateUserPort,
  type DeleteInvitedUserPort,
} from './_lib/invite-saga';
import { UseCaseAbort } from '../tx-abort';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const inviteColleagueSchema = z.object({
  first_name: z.string().min(1).max(100),
  last_name: z.string().min(1).max(100),
  email: z.string().email().max(254),
  role_title: z.string().max(100).nullable().optional(),
  preferred_language: z.enum(['en', 'th', 'sv']).optional(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteColleagueInput = {
  readonly memberId: MemberId;
  readonly actorUserId: string;
  readonly actorContactId: ContactId;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly body: z.infer<typeof inviteColleagueSchema>;
  readonly locale?: 'en' | 'th' | 'sv';
};

export type InviteColleagueError =
  | { type: 'not_primary'; reason: string }
  | { type: 'validation_error'; issues: z.ZodIssue[] }
  | { type: 'email_taken' }
  | { type: 'invalid_email' }
  // 059-membership-suspension Task 6 — a suspended/terminated member (F8
  // `deriveMembershipAccess`) cannot invite a colleague: every invite mints
  // a brand-new F1 auth account via `createUser`, which is exactly the
  // account-provisioning surface a suspended member must not reach.
  | { type: 'membership_suspended' }
  // go-live #12-13 (follow-up) — the contact tx failed after createUser
  // committed; the orphaned invite was rolled back (SAGA compensation), so a
  // retry is safe. Distinct from server_error (an unexpected fault) for parity
  // with invitePortal — see invite-portal.ts `link_failed`.
  | { type: 'link_failed' }
  | { type: 'server_error'; message: string };

export type InviteColleagueDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly audit: AuditPort;
  readonly createUser: CreateUserPort;
  /** SAGA compensation for the invite orphan window (go-live #12-13 follow-up). */
  readonly deleteInvitedUser: DeleteInvitedUserPort;
  /**
   * 059-membership-suspension Task 6 — F8 benefit-access gate (F3-owned
   * port; concrete adapter is `membershipAccessBridge` in
   * `../../infrastructure/membership-access-bridge.ts`).
   */
  readonly membershipAccess: MembershipAccessPort;
  readonly idFactory: { contactId(): ContactId };
};

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function inviteColleague(
  deps: InviteColleagueDeps,
  input: InviteColleagueInput,
): Promise<Result<{ contact: Contact; userId: string }, InviteColleagueError>> {
  // 0. 059-membership-suspension Task 6 — membership-access gate. Checked
  // FIRST (before the actor-contact lookup and before any createUser call)
  // so a suspended/terminated member's request never touches F1's
  // account-provisioning path. A route-only guard would leak: nothing
  // stops a future second caller of this use case from skipping it.
  const access = await deps.membershipAccess.getMembershipAccess(
    deps.tenant,
    input.memberId,
  );
  if (!access.ok) {
    // Infra error → fail CLOSED. A DB blip on the F8 lookup must not be
    // silently treated as "member is fine, let them mint an account".
    return err({
      type: 'server_error',
      message: `membership_access_error: ${access.error.kind}`,
    });
  }
  if (access.value.access !== 'full') {
    return err({ type: 'membership_suspended' });
  }

  // 1. Verify the actor is the primary contact
  const actorContact = await deps.contactRepo.findById(
    deps.tenant,
    input.actorContactId,
  );
  if (!actorContact.ok) {
    return err({
      type: 'server_error',
      message: `actor contact: ${actorContact.error.code}`,
    });
  }
  if (!actorContact.value.isPrimary) {
    return err({
      type: 'not_primary',
      reason: 'only the primary contact may invite colleagues',
    });
  }
  // B-5: Verify actor belongs to the target member — prevents cross-member bypass
  if (actorContact.value.memberId !== input.memberId) {
    return err({
      type: 'not_primary',
      reason: 'actor does not belong to the target member',
    });
  }

  // 2. Validate email
  const emailResult = asEmail(input.body.email);
  if (!emailResult.ok) {
    return err({ type: 'invalid_email' });
  }

  // 3. Create F1 user with member role
  // W-1: Use normalized (lowercase) email from emailResult.value
  const created = await deps.createUser({
    email: emailResult.value,
    role: 'member',
    displayName: `${input.body.first_name} ${input.body.last_name}`.trim(),
    actorUserId: input.actorUserId,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale ?? input.body.preferred_language,
    tenantId: deps.tenant.slug,
  });
  if (!created.ok) {
    if (created.error.code === 'invalid-input') {
      return err({ type: 'invalid_email' });
    }
    if (created.error.code === 'email-taken') {
      return err({ type: 'email_taken' });
    }
    // `invitation-create-failed` — F1 create-user already ran its
    // compensating `users.deletePending`, so no state leaks here.
    // Surface as server_error so the route returns 500 and the admin
    // can retry.
    return err({
      type: 'server_error',
      message: `createUser: ${created.error.code}`,
    });
  }

  // 4. Add secondary contact to the member
  const newContactId = deps.idFactory.contactId();
  const contactDraft = {
    // W-3: Use branded constructor instead of raw `as` cast
    tenantId: deps.tenant.slug,
    contactId: newContactId,
    memberId: input.memberId,
    firstName: input.body.first_name,
    lastName: input.body.last_name,
    email: emailResult.value,
    phone: null,
    roleTitle: input.body.role_title ?? null,
    preferredLanguage: (input.body.preferred_language ?? 'en') as PreferredLanguage,
    isPrimary: false,
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    removedAt: null,
  };

  // S1 + W1 — Add + linkUser + audit in ONE tx with throw-to-rollback
  // so all three land atomically. `return err(...)` would commit the
  // preceding writes; only `throw` triggers Drizzle rollback.
  try {
    const contact = await runInTenant(deps.tenant, async (tx) => {
      const added = await deps.contactRepo.addInTx(tx, contactDraft);
      if (!added.ok) throw new UseCaseAbort<RepoError>(added.error);

      const linked = await deps.contactRepo.linkUserInTx(
        tx,
        newContactId,
        created.value.user.id,
      );
      if (!linked.ok) throw new UseCaseAbort<RepoError>(linked.error);

      // W-2: PII-touching operation audit (Constitution Principle I).
      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'contact_created',
        actorUserId: input.actorUserId,
        targetUserId: created.value.user.id,
        requestId: input.requestId,
        summary: `colleague invited as secondary contact`,
        payload: {
          contact_id: newContactId,
          member_id: input.memberId,
          user_id: created.value.user.id,
          is_primary: false,
        },
      });
      if (!auditResult.ok)
        throw new UseCaseAbort<RepoError>(auditResult.error);

      return linked.value;
    });

    return ok({ contact, userId: created.value.user.id });
  } catch (e) {
    const cause = e instanceof UseCaseAbort ? e.error : e;
    logger.error(
      {
        contactId: newContactId,
        // PII: hash the user id in logs (CLAUDE.md § Secrets) — consistent with
        // invite-user-for-member + the shared invite-saga compensation log.
        userIdHash: hashId(created.value.user.id),
        cause,
        requestId: input.requestId,
      },
      'invite-colleague.tx_failed: rolling back orphaned F1 user (SAGA compensation)',
    );
    // go-live #12-13 (follow-up) — the contact tx rolled back, but F1 createUser
    // already committed the pending user + invitation + queued email in its own
    // tx. Leaving it = a PERMANENT orphan (active user, no contact -> broken
    // member-portal resolution via findByLinkedUserId; redeem-invite never links
    // a contact). Roll the invite back via the shared SAGA compensation (never
    // throws → cannot mask the original failure).
    await compensateInviteOrphan(deps.deleteInvitedUser, {
      userId: created.value.user.id,
      outboxRowId: created.value.outboxRowId,
      actorUserId: input.actorUserId,
      sourceIp: input.sourceIp,
      requestId: input.requestId,
      targetEmail: emailResult.value,
      opLabel: 'invite-colleague',
    });
    if (e instanceof UseCaseAbort) {
      // Controlled repo failure, orphan compensated → link_failed (retry safe),
      // mirroring invitePortal's link_failed branch.
      return err({ type: 'link_failed' });
    }
    // Genuinely unexpected throw (e.g. PG connection lost). Orphan compensated,
    // but it is an incident to investigate — keep server_error (parity with
    // invitePortal, where an uncaught throw surfaces as a generic 500).
    return err({
      type: 'server_error',
      message: 'invite-colleague tx: unexpected',
    });
  }
}
