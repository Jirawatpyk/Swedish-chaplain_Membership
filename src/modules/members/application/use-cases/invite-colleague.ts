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
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '../../domain/member';
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

  // 2. Validate email
  const emailResult = asEmail(input.body.email);
  if (!emailResult.ok) {
    return err({ type: 'invalid_email' });
  }

  // 3. Create F1 user with member role
  const created = await deps.createUser({
    email: input.body.email,
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
    return err({ type: 'email_taken' });
  }

  // 4. Add secondary contact to the member
  const newContactId = deps.idFactory.contactId();
  const contactDraft = {
    tenantId: deps.tenant.slug as Contact['tenantId'],
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

  const added = await deps.contactRepo.add(
    deps.tenant,
    contactDraft,
    input.actorUserId,
    input.requestId,
  );
  if (!added.ok) {
    return err({
      type: 'server_error',
      message: `add contact: ${added.error.code}`,
    });
  }

  // 5. Link the new user to the new contact
  await deps.contactRepo.linkUser(
    deps.tenant,
    newContactId,
    created.value.user.id,
    input.actorUserId,
    input.requestId,
  );

  return ok({
    contact: added.value,
    userId: created.value.user.id,
  });
}
