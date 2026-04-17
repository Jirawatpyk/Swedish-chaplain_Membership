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
   */
  listLinkedUserIdsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<string[]>;
}
