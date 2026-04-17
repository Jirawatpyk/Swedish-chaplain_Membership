/**
 * Invite-portal use case — FR-012 (T046).
 *
 * Admin triggers this from the member detail page to send a portal
 * invitation to a contact. Internally delegates to F1 `createUser`
 * (which creates a `pending` user + 7-day invitation token + sends
 * the invitation email via Resend), then binds the new user id to
 * the contact row.
 *
 * Flow:
 *   1. Load contact; refuse when already linked
 *   2. F1 `createUser` with role='member' + the contact's email
 *   3. `contactRepo.linkUser` binds user_id to the contact
 *   4. On linkUser failure the F1 user row remains (orphan). That is
 *      acceptable: the invitation can still be redeemed and the
 *      redemption path sets the contact link separately. Logging the
 *      orphan creates a breadcrumb for operational reconciliation.
 *
 * Emits no dedicated F3 audit event — F1 `account_created` already
 * records the invitation, and `contactRepo.linkUser` emits
 * `contact_updated` with the `linked_user_id` delta.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { ContactId } from '../../domain/contact';
import type { ContactRepo } from '../ports/contact-repo';

/**
 * Narrowed F1 createUser surface we depend on. Typed here rather than
 * imported from `@/modules/auth` to keep the Application layer free
 * of Infrastructure composition roots — the route handler wires the
 * real `createUser` at the boundary.
 */
export type CreateUserPort = (input: {
  readonly email: string;
  readonly role: 'member';
  readonly displayName?: string | null;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
}) => Promise<
  | { readonly ok: true; readonly value: { readonly user: { readonly id: string } } }
  | { readonly ok: false; readonly error: { readonly code: 'invalid-input' | 'email-taken' | 'invitation-create-failed' } }
>;

export type InvitePortalDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly createUser: CreateUserPort;
};

export type InvitePortalInput = {
  readonly contactId: ContactId;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
};

export type InvitePortalError =
  | { readonly code: 'not_found' }
  | { readonly code: 'already_linked' }
  | { readonly code: 'no_email' }
  | { readonly code: 'email_taken' }
  | { readonly code: 'invalid_email' }
  | { readonly code: 'server_error'; readonly cause?: unknown };

export type InvitePortalOutput = {
  readonly contactId: ContactId;
  readonly userId: string;
  readonly email: string;
};

export async function invitePortal(
  deps: InvitePortalDeps,
  input: InvitePortalInput,
): Promise<Result<InvitePortalOutput, InvitePortalError>> {
  // 1. Load contact
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
  if (contact.linkedUserId) return err({ code: 'already_linked' });
  if (!contact.email) return err({ code: 'no_email' });

  // 2. F1 createUser
  const created = await deps.createUser({
    email: contact.email,
    role: 'member',
    displayName: `${contact.firstName} ${contact.lastName}`.trim(),
    actorUserId: input.actorUserId,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    // Fallback to contact's preferred_language when no explicit locale
    locale: input.locale ?? contact.preferredLanguage,
  });
  if (!created.ok) {
    if (created.error.code === 'invalid-input') {
      return err({ code: 'invalid_email' });
    }
    if (created.error.code === 'email-taken') {
      return err({ code: 'email_taken' });
    }
    // invitation-create-failed — compensating delete already ran in
    // create-user; surface as server_error so the route returns 500.
    return err({ code: 'server_error', cause: created.error.code });
  }

  // 3. Link user_id to the contact (short tenant-scoped tx — S1 refactor)
  const linked = await runInTenant(deps.tenant, (tx) =>
    deps.contactRepo.linkUserInTx(tx, input.contactId, created.value.user.id),
  );
  if (!linked.ok) {
    // Orphan created — F1 user exists but contact.linked_user_id is
    // not set. Log for operational reconciliation; return success
    // because the invitation email is already in flight.
    logger.error(
      {
        contactId: input.contactId,
        userId: created.value.user.id,
        cause: linked.error,
        requestId: input.requestId,
      },
      'invite-portal.link_user_failed: orphan user created; contact not linked',
    );
  }

  return ok({
    contactId: input.contactId,
    userId: created.value.user.id,
    email: contact.email,
  });
}
