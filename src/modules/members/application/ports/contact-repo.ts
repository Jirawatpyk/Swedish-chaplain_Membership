/**
 * Application port — Contact repository.
 */
import type { TenantTx } from '@/lib/db';
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { Contact, ContactId } from '../../domain/contact';
import type { MemberId } from '../../domain/member';
import type { Email } from '../../domain/value-objects/email';
import type { Phone } from '../../domain/value-objects/phone';
import type { RepoError } from './member-repo';

/**
 * Narrowed patch type for contact updates — only mutable fields.
 * Identity fields (tenantId, contactId, memberId, createdAt) are excluded.
 */
export type ContactPatch = Partial<
  Pick<
    Contact,
    'firstName' | 'lastName' | 'roleTitle' | 'preferredLanguage' | 'dateOfBirth'
  > & {
    phone: Phone | null;
  }
>;

export interface ContactRepo {
  listByMember(
    ctx: TenantContext,
    memberId: MemberId,
    options?: { readonly includeRemoved?: boolean },
  ): Promise<Result<Contact[], RepoError>>;

  findById(
    ctx: TenantContext,
    contactId: ContactId,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Look up a non-removed contact by email within the caller's tenant.
   * Used by admin invite flow (`invite-user-for-member`) to decide
   * between creating a new contact vs. linking an existing unlinked
   * contact vs. rejecting an already-linked / cross-member duplicate.
   *
   * Scoped to the tenant via RLS (`runInTenant`) + defensive
   * `tenantId = ctx.slug` WHERE clause. Ignores soft-deleted rows
   * (`removed_at IS NULL`) — a soft-deleted contact with the same
   * email should not block a new invite.
   *
   * Returns `repo.not_found` when no live contact with that email
   * exists in the tenant.
   */
  findByEmail(
    ctx: TenantContext,
    email: Email,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Insert a contact row inside the caller's transaction. Does NOT emit
   * audit events — the caller is responsible for writing the matching
   * `contact_created` audit via `AuditPort.recordInTx` so Application-
   * layer ownership of audit emission is preserved (Principle III, S1).
   */
  addInTx(
    tx: TenantTx,
    draft: Omit<Contact, 'createdAt' | 'updatedAt'>,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Patch mutable contact fields inside the caller's transaction. Does
   * NOT emit audit events — caller emits `contact_updated`.
   */
  updateInTx(
    tx: TenantTx,
    contactId: ContactId,
    patch: ContactPatch,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Soft-delete (`removedAt = now`). A primary contact cannot be removed
   * while still primary — caller must `promotePrimary` first. Does NOT
   * emit audit events — caller emits `contact_removed` with the
   * `was_primary` flag derived from the returned row.
   */
  removeInTx(
    tx: TenantTx,
    contactId: ContactId,
  ): Promise<Result<{ contact: Contact; wasPrimary: boolean }, RepoError>>;

  /**
   * Demote the current primary + promote the target in one transaction.
   * Maps the partial-index race condition to `repo.conflict`. Does NOT
   * emit audit events — caller emits `member_primary_contact_changed`.
   */
  promotePrimaryInTx(
    tx: TenantTx,
    memberId: MemberId,
    newPrimaryContactId: ContactId,
  ): Promise<Result<{ demoted: Contact; promoted: Contact }, RepoError>>;

  /**
   * Bind an F1 user account to a contact. Used on invitation acceptance
   * or when admin invites a contact to the portal via the F3 use case
   * `invitePortal`. Refuses if the contact already has a linked user —
   * overwriting would strand the previous account without cleanup. Does
   * NOT emit audit events — caller emits `contact_updated` with
   * `fields_changed: ['linked_user_id']` + `targetUserId: userId`.
   */
  linkUserInTx(
    tx: TenantTx,
    contactId: ContactId,
    userId: string,
  ): Promise<Result<Contact, RepoError>>;

  /**
   * Update only the email column, using the caller's transaction. Part
   * of the FR-012a 6-step atomic change-contact-email txn. Returns the
   * previous email (needed for audit + for the revert notification's
   * `oldEmail` field).
   *
   * Conflicts on the `contacts_tenant_email_uniq` partial index
   * surface as `repo.conflict`.
   */
  updateEmailInTx(
    tx: TenantTx,
    ctx: TenantContext,
    contactId: ContactId,
    newEmail: Email,
  ): Promise<Result<{ oldEmail: Email }, RepoError>>;

  /**
   * List `linkedUserId`s for every non-removed contact on the member,
   * inside the caller's transaction. Used by the archive cascade to
   * collect the F1 users whose sessions + pending invitations must be
   * revoked atomically with the status flip (US7).
   *
   * Returns a de-duplication-friendly list (may contain duplicates if
   * the same F1 user is linked to multiple contacts on the same
   * member); callers dedupe via `new Set(...)` before iterating.
   *
   * An empty array means "genuinely no linked users". A read failure
   * (statement timeout / connection blip) THROWS rather than returning
   * `[]`, so the caller's atomic tx rolls back instead of silently
   * skipping the session/invitation revocation cascade (Bug I-1).
   */
  listLinkedUserIdsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<string[]>;

  /**
   * Mark a contact's pending invitation as bounced (spec § Edge Cases) by
   * stamping `invite_bounced_at = now()`. Idempotent: returns `affected: 0`
   * if the contact does not exist, is removed, or is already marked.
   * Caller (markInvitationBounced use-case) emits the `invitation_bounced`
   * audit event in the same tx. Does NOT emit audit itself.
   */
  markInviteBouncedInTx(
    tx: TenantTx,
    contactId: ContactId,
    bouncedAt: Date,
  ): Promise<Result<{ affected: number }, RepoError>>;

  /**
   * Clear the `invite_bounced_at` flag after an admin re-sends the
   * invitation email (spec § Edge Cases — "Re-send invite" action).
   * Sets `invite_bounced_at = NULL` on the contact row identified by
   * `contactId`. Returns `affected: 1` on success, `affected: 0` if
   * the contact does not exist or is already NULL (idempotent).
   * Does NOT emit audit — caller (resendBouncedInvite use-case) emits
   * `member_portal_invite_queued` in the same chamber_app tx.
   */
  clearInviteBouncedInTx(
    tx: TenantTx,
    contactId: ContactId,
  ): Promise<Result<{ affected: number }, RepoError>>;

  /**
   * COMP-1 — anonymise every contact of a member in place. NOT NULL identity
   * columns (`first_name`/`last_name`/`email`) get non-PII sentinels; the
   * per-row email sentinel embeds `contact_id` so it is unique and cannot
   * collide with another erased member's sentinel. `phone`/`date_of_birth`/
   * `role_title` → NULL. `removed_at` is set (and `is_primary` forced FALSE) so
   * the row leaves the `lower(email) WHERE removed_at IS NULL` partial unique
   * index. Idempotent: re-running on already-scrubbed rows is a no-op-equivalent
   * (sentinels are stable per contact_id).
   */
  scrubPiiForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
    opts: { readonly erasedAt: Date },
  ): Promise<Result<{ readonly scrubbedCount: number }, RepoError>>;
}
