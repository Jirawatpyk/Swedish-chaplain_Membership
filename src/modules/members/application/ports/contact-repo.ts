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
   *
   * `draft.art14AttestedAt` (Task 8, GDPR Art. 14) is the caller's
   * responsibility to set correctly BEFORE calling this method: `null` for
   * the member's own primary contact, a real timestamp for any contact
   * collected on someone else's behalf. This port does not gate or default
   * it — see `Contact.art14AttestedAt` (domain/contact.ts) for the full
   * invariant.
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
   * COMP-1 US2a — list `linkedUserId`s for EVERY contact on the member,
   * INCLUDING removed (`removed_at IS NOT NULL`) contacts, inside the caller's
   * transaction. This is the F1 linked-login ERASURE work-list source.
   *
   * Why unfiltered (and why a SEPARATE method from
   * `listLinkedUserIdsForMemberInTx`): the contacts scrub
   * (`scrubPiiForMemberInTx`) stamps `removed_at` on every contact but
   * PRESERVES `linked_user_id`. The `removed_at IS NULL` variant therefore
   * returns `[]` once the scrub has run — so on a US2d reconciler RE-DRIVE
   * (where the contacts are already scrubbed) the filtered read would yield an
   * empty F1 work-list and the loop would silently skip a login that FAILED to
   * erase on a prior pass, while `member_erased` was emitted as "complete" — an
   * Art.17 credential-survival hole. Reading unfiltered re-discovers every
   * linked login on the removed contact row, so the re-drive re-attempts the
   * previously-failed login. The `removed_at IS NULL` variant is for the in-tx
   * session/invitation cascade ONLY (it operates on the live contacts).
   *
   * Same FAIL-LOUD contract as the filtered variant: a read failure
   * (statement timeout / connection blip) THROWS rather than returning `[]`,
   * so the caller's atomic tx rolls back instead of silently skipping the
   * Art.17 login anonymisation. Returns a de-duplication-friendly list (a
   * member may have two removed contacts pointing at the same login); callers
   * dedupe via `new Set(...)`.
   */
  listAllLinkedUserIdsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<readonly string[]>;

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
   * COMP-1 US2a (L1) — list the REAL email addresses of every contact on the
   * member (any state, including already-removed rows), inside the caller's
   * transaction. Read BEFORE `scrubPiiForMemberInTx` sentinel-izes the emails,
   * so it captures the frozen `to_email` values used by pending
   * `notifications_outbox` rows (`member_invitation` / `email_verification` to
   * the contact's address) that the erasure must cancel (L1).
   *
   * Not filtered by `removed_at` — a re-drive over an already-scrubbed member
   * would then only see the `erased+…@erased.invalid` sentinels (harmless,
   * never matches a real outbox row), and a contact removed by ordinary
   * archive still has its real email on the row until the erasure scrub runs.
   *
   * Same FAIL-LOUD contract as the linked-user reads: a DB error THROWS so the
   * caller's atomic erasure tx rolls back rather than silently skipping the
   * outbox cancel. De-duplicated.
   */
  listEmailsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<readonly string[]>;

  /**
   * COMP-1 US2a (L1 over-delete fix) — list the REAL email addresses of the
   * member's LIVE contacts ONLY (`removed_at IS NULL`), inside the caller's
   * transaction. Read BEFORE `scrubPiiForMemberInTx` sentinel-izes the emails.
   *
   * This is the CONTACT-email component of the outbox cancel-set (the address
   * set used to DELETE the erased subject's pending `notifications_outbox`
   * rows). It MUST be live-only — and is therefore a SEPARATE method from the
   * unfiltered `listEmailsForMemberInTx`:
   *
   *   The `contacts_tenant_email_uniq` index is PARTIAL (`WHERE removed_at IS
   *   NULL`), so a REMOVED contact of member A and a LIVE contact of member B
   *   (same tenant) can share an email X. A removed contact's email is thus
   *   AMBIGUOUSLY OWNED — it may be another member's live contact's address.
   *   Cancelling on a removed contact's email would `DELETE … WHERE
   *   to_email='X'` and silently delete member B's legitimate pending mail
   *   (cross-member over-delete). A LIVE contact's email is unambiguously the
   *   erased member's right now, so only those are safe to cancel on.
   *
   * The unfiltered `listEmailsForMemberInTx` stays in use for the F1 work-list
   * reads that are USER-keyed (no email collision) and must be re-drive-stable;
   * this live-only read is used SOLELY for the outbox cancel-set. The residual
   * (a pending row A enqueued to an already-removed contact's email, if that
   * email is not also a live-login/token email, is no longer cancelled) is the
   * documented, safer failure mode vs. deleting a peer member's mail.
   *
   * Same FAIL-LOUD contract as the other erasure reads: a DB error THROWS so
   * the caller's atomic erasure tx rolls back rather than silently skipping the
   * outbox cancel. De-duplicated.
   */
  listLiveEmailsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<readonly string[]>;

  /**
   * COMP-1 FIX-3 (cross-member-safe recipient-PII redaction) — list the REAL
   * email addresses of ALL of the member's contacts (ANY `removed_at` state),
   * MINUS any email currently held by a LIVE contact of a DIFFERENT member in
   * the tenant. Read BEFORE `scrubPiiForMemberInTx` sentinel-izes the emails.
   *
   * This is the email set for the EMAIL-KEYED REDACTION ops (the F7 delivery
   * tombstone, the Resend audience-removal derivation, and the cross-author
   * custom-recipient redaction). It is a THIRD email read, distinct from both
   * `listEmailsForMemberInTx` (unfiltered, USER-keyed work-lists) and
   * `listLiveEmailsForMemberInTx` (live-only, the address-keyed outbox cancel):
   *
   *   - It must INCLUDE a contact ARCHIVED before erasure (its identity row IS
   *     scrubbed by `scrubPiiForMemberInTx`, which redacts ALL contacts
   *     regardless of `removed_at` — so its historical recipient PII must be
   *     redacted too, or it survives in plaintext on the delivery / Resend
   *     audience / a sibling author's custom-recipient list). `listLive…` would
   *     EXCLUDE it (the FIX-3 gap).
   *   - It must EXCLUDE an email a PEER member still holds LIVE. The partial
   *     `contacts_tenant_email_uniq` index (`WHERE removed_at IS NULL`) permits
   *     an email X to be simultaneously (this member, REMOVED contact) AND
   *     (peer member, LIVE contact). Redacting on X would tombstone the PEER's
   *     live delivery to a sentinel AND drive the post-commit Resend
   *     audience-removal on X → UNSUBSCRIBE the peer from Resend (cross-member
   *     data loss). A blanket "all contact emails" (the unfiltered read) would
   *     over-reach into exactly this. For the rare collision we leave the erased
   *     member's own datum — the SAME accepted safer-failure residual as the
   *     live-only outbox guard (a residual self-datum beats peer data loss).
   *
   * Same FAIL-LOUD contract as the other erasure reads: a DB error THROWS so
   * the caller's atomic erasure tx rolls back rather than silently skipping the
   * redaction. Lower-cased + de-duplicated.
   */
  listTombstoneEmailsForMemberInTx(
    tx: TenantTx,
    memberId: MemberId,
  ): Promise<readonly string[]>;

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
