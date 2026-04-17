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
import type { TenantContext } from '@/modules/tenants';
import { asTenantId, type MemberId } from '../../domain/member';
import type { Contact, ContactId, PreferredLanguage } from '../../domain/contact';
import { asEmail } from '../../domain/value-objects/email';
import type { ContactRepo } from '../ports/contact-repo';
import type { AuditPort } from '../ports/audit-port';
import type { CreateUserPort } from './invite-portal';

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
  | { type: 'server_error'; message: string };

export type InviteColleagueDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly audit: AuditPort;
  readonly createUser: CreateUserPort;
  readonly idFactory: { contactId(): ContactId };
};

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function inviteColleague(
  deps: InviteColleagueDeps,
  input: InviteColleagueInput,
): Promise<Result<{ contact: Contact; userId: string }, InviteColleagueError>> {
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
    tenantId: asTenantId(deps.tenant.slug),
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
    removedAt: null,
  };

  // S1 — Add + linkUser + audit inside a single tenant-scoped tx so all
  // three land or none do. Previously each port call owned its own tx
  // which could leave an orphan contact if linkUser failed after add.
  const outcome = await runInTenant(deps.tenant, async (tx) => {
    const added = await deps.contactRepo.addInTx(tx, contactDraft);
    if (!added.ok) return added;

    const linked = await deps.contactRepo.linkUserInTx(
      tx,
      newContactId,
      created.value.user.id,
    );
    if (!linked.ok) return linked;

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
    if (!auditResult.ok) return err(auditResult.error);

    return ok(linked.value);
  });

  if (!outcome.ok) {
    logger.error(
      {
        contactId: newContactId,
        userId: created.value.user.id,
        cause: outcome.error,
        requestId: input.requestId,
      },
      'invite-colleague.tx_failed: contact + link + audit rolled back',
    );
    return err({
      type: 'server_error',
      message: `invite-colleague tx: ${outcome.error.code}`,
    });
  }

  return ok({
    contact: outcome.value,
    userId: created.value.user.id,
  });
}
