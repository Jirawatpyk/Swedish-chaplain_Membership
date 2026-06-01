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
 *   2. F1 `createUser` with role='member' + the contact's email (its own
 *      owner-role tx — commits the pending user + invitation + queued email)
 *   3. `contactRepo.linkUser` binds user_id to the contact (a SEPARATE
 *      chamber_app tx — the role split forbids one atomic tx)
 *   4. go-live #12-13 — if step 3 fails AFTER step 2 committed, roll the invite
 *      back via SAGA compensation (`deleteInvitedUser`) and return `link_failed`.
 *      The pre-fix code returned ok() here and claimed the redemption path would
 *      link the contact later — it does NOT (redeem-invite never touches
 *      contacts.linked_user_id), so that "orphan" was a PERMANENT active user
 *      with an unlinked contact → broken member-portal resolution.
 *
 * Emits no dedicated F3 audit event on the happy path — F1 `account_created`
 * already records the invitation, and `contactRepo.linkUser` emits
 * `contact_updated` with the `linked_user_id` delta. The compensation path
 * emits F1 `account_creation_compensated`.
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import type { ContactId } from '../../domain/contact';
import type { ContactRepo } from '../ports/contact-repo';
import { compensateInviteOrphan } from './_lib/invite-saga';
import type { CreateUserPort, DeleteInvitedUserPort } from './_lib/invite-saga';

// `CreateUserPort` + `DeleteInvitedUserPort` now live in the shared
// `_lib/invite-saga` module (the contract is shared by invitePortal,
// inviteColleague, inviteUserForMember). Re-exported here for backward
// compatibility with consumers that import them from this use-case file
// (adapters, members-deps, the module barrel, bulk-send-portal-invite).
export type { CreateUserPort, DeleteInvitedUserPort };

export type InvitePortalDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly createUser: CreateUserPort;
  /** SAGA compensation for the orphan window (go-live #12-13). */
  readonly deleteInvitedUser: DeleteInvitedUserPort;
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
  // go-live #12-13 — contact link failed after createUser committed; the invite
  // was rolled back (SAGA compensation) so no orphan persists. Caller re-invites.
  | { readonly code: 'link_failed' }
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
    tenantId: deps.tenant.slug,
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
    // go-live #12-13 — the link failed AFTER createUser committed (rare cross-tx
    // fault). The pre-existing code returned ok() + logged an "orphan", claiming
    // redemption would link the contact later — but redeem-invite NEVER touches
    // contacts.linked_user_id, so the orphan was PERMANENT (an active user whose
    // contact stays unlinked → broken member-portal resolution via
    // findByLinkedUserId). SAGA compensation: roll back the just-created invite
    // (delete the pending user + its queued email) so NO orphan persists, then
    // surface a typed error so the caller (single-invite route / bulk) reports a
    // real failure and the admin re-invites cleanly.
    logger.error(
      {
        contactId: input.contactId,
        // PII: hash the user id in logs (CLAUDE.md § Secrets) — requestId already
        // provides cross-request correlation.
        userIdHash: hashId(created.value.user.id),
        cause: linked.error,
        requestId: input.requestId,
      },
      'invite-portal.link_user_failed: rolling back orphaned invite (SAGA compensation)',
    );
    // Shared SAGA compensation (owns the delete-call args + the
    // compensation_failed log). Never throws → cannot mask this failure.
    await compensateInviteOrphan(deps.deleteInvitedUser, {
      userId: created.value.user.id,
      outboxRowId: created.value.outboxRowId,
      actorUserId: input.actorUserId,
      sourceIp: input.sourceIp,
      requestId: input.requestId,
      targetEmail: contact.email,
      opLabel: 'invite-portal',
    });
    return err({ code: 'link_failed' });
  }

  return ok({
    contactId: input.contactId,
    userId: created.value.user.id,
    email: contact.email,
  });
}
