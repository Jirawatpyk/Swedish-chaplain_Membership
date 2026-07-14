/**
 * `invite-user-for-member` use case — F1 spec:672-678 gap fix.
 *
 * Admin-initiated variant of `invite-colleague`. The admin invites a
 * `member`-role user and optionally links the new user to an existing
 * member record via a secondary contact row.
 *
 * Difference from `invite-colleague`:
 *   - No "actor must be primary contact" gate (admin bypasses member
 *     hierarchy).
 *   - Simplified input: admin form only collects email; contact first /
 *     last name are derived from `displayName` (if provided) or the
 *     email local-part — the admin isn't asked to fill in HR-level
 *     personal details up front. Member admins can correct later via
 *     the regular contact edit flow.
 *   - Pre-validates tenant ownership of memberId before calling F1
 *     `createUser` — emits `member_cross_tenant_probe` on mismatch so
 *     the telemetry for PII-resource probes stays consistent with the
 *     `get-member` path (plan.md § Constraints).
 *
 * Atomicity: same pattern as `invite-colleague`. F1 createUser is its
 * OWN tx; the contact + link + contact_created audit run in a second
 * tx with `throw new UseCaseAbort(...)` rollback. If the second tx
 * fails, F1 createUser already committed the pending user — go-live
 * #12-13 (follow-up): that orphan is ROLLED BACK via `deleteInvitedUser`
 * SAGA compensation, NOT left for redemption (redeem-invite never links a
 * contact, so the orphan would be permanent: an active user whose contact
 * stays unlinked → broken member-portal resolution). Compensation is
 * correct for BOTH paths — the user is always freshly created at step 4,
 * so deleting it leaves no half-state (create_new → the new contact was
 * already rolled back; link_existing → the pre-existing contact returns to
 * its prior unlinked state).
 */

import { runInTenant } from '@/lib/db';
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { hashId } from '@/lib/log-id';
import type { TenantContext } from '@/modules/tenants';
import { type MemberId } from '../../domain/member';
import type { ContactId, PreferredLanguage } from '../../domain/contact';
import { asEmail } from '../../domain/value-objects/email';
import type { ContactRepo } from '../ports/contact-repo';
import type { MemberRepo, RepoError } from '../ports/member-repo';
import type { AuditPort } from '../ports/audit-port';
import {
  compensateInviteOrphan,
  type CreateUserPort,
  type DeleteInvitedUserPort,
} from './_lib/invite-saga';
import { UseCaseAbort } from '../tx-abort';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InviteUserForMemberInput = {
  readonly memberId: MemberId;
  readonly email: string;
  readonly displayName?: string | null;
  readonly actorUserId: string;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly locale?: 'en' | 'th' | 'sv' | undefined;
};

export type InviteUserForMemberError =
  | { readonly type: 'invalid_email' }
  | { readonly type: 'email_taken' }
  | { readonly type: 'member_not_found' }
  | { readonly type: 'contact_already_linked' }
  | { readonly type: 'email_belongs_to_other_member' }
  // go-live #12-13 (follow-up) — the contact tx failed after createUser
  // committed; the orphaned invite was rolled back (SAGA compensation), so a
  // retry is safe. Distinct from server_error (an unexpected fault) for parity
  // with invitePortal — see invite-portal.ts `link_failed`.
  | { readonly type: 'link_failed' }
  | { readonly type: 'server_error'; readonly message: string };

export type InviteUserForMemberDeps = {
  readonly tenant: TenantContext;
  readonly contactRepo: ContactRepo;
  readonly memberRepo: MemberRepo;
  readonly audit: AuditPort;
  readonly createUser: CreateUserPort;
  /** SAGA compensation for the invite orphan window (go-live #12-13 follow-up). */
  readonly deleteInvitedUser: DeleteInvitedUserPort;
  readonly idFactory: { contactId(): ContactId };
};

export type InviteUserForMemberOutput = {
  readonly userId: string;
  readonly contactId: ContactId;
  readonly email: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split displayName into first/last name best-effort. Both fields have a
 * `>= 1 char` zod rule, so every branch falls back to the literal
 * `'Member'` as a placeholder when input is missing — admin corrects via
 * contact edit later. Single-word displayName → lastName='Member';
 * missing displayName → firstName=email local-part, lastName='Member'.
 */
function deriveContactName(
  email: string,
  displayName?: string | null,
): { firstName: string; lastName: string } {
  if (displayName && displayName.trim().length > 0) {
    const parts = displayName.trim().split(/\s+/);
    const firstName = parts[0] ?? 'Member';
    const lastName = parts.slice(1).join(' ') || 'Member';
    return { firstName, lastName };
  }
  const localPart = email.split('@')[0] ?? 'Member';
  return { firstName: localPart, lastName: 'Member' };
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function inviteUserForMember(
  deps: InviteUserForMemberDeps,
  input: InviteUserForMemberInput,
): Promise<Result<InviteUserForMemberOutput, InviteUserForMemberError>> {
  // 1. Pre-validate tenant ownership of memberId. If the member is not
  //    visible in the caller's tenant (RLS), emit a high-signal probe
  //    audit and return `member_not_found`. Does this BEFORE createUser
  //    so we don't orphan an F1 user when the memberId is cross-tenant.
  const memberCheck = await deps.memberRepo.findById(deps.tenant, input.memberId);
  if (!memberCheck.ok) {
    if (memberCheck.error.code === 'repo.not_found') {
      await deps.audit.record(deps.tenant, {
        type: 'member_cross_tenant_probe',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `probe on ${input.memberId} during invite-user-for-member`,
        payload: {
          attempted_member_id: input.memberId,
          actor_tenant_id: deps.tenant.slug,
          context: 'invite-user-for-member',
        },
      });
      return err({ type: 'member_not_found' });
    }
    return err({
      type: 'server_error',
      message: `member probe: ${memberCheck.error.code}`,
    });
  }

  // 2. Validate email (F1 createUser also validates, but normalising
  //    here lets us use the same lowercase value for the contact row).
  const emailResult = asEmail(input.email);
  if (!emailResult.ok) {
    return err({ type: 'invalid_email' });
  }

  // 3. Hybrid A+B duplicate-email pre-check. Same-tenant `contacts`
  //    rows carry a unique email partial-index; if we blindly INSERT
  //    on duplicate, the DB conflict rolls back the contact tx AND
  //    orphans the already-created F1 user. Branch on the lookup
  //    result BEFORE createUser so no orphan is ever created for the
  //    deterministic duplicate cases.
  const existing = await deps.contactRepo.findByEmail(
    deps.tenant,
    emailResult.value,
  );

  // Decision table (discriminated union makes illegal states unrepresentable):
  //   not_found                              -> path A: create new contact
  //   found, member_id DIFFERENT             -> reject email_belongs_to_other_member
  //   found, member_id matches, linked_user  -> reject contact_already_linked
  //   found, member_id matches, unlinked     -> path B: link existing contact
  type Decision =
    | { readonly mode: 'create_new' }
    | { readonly mode: 'link_existing'; readonly contactId: ContactId };
  let decision: Decision;

  if (existing.ok) {
    // Constitution v1.4.0 Principle I — two-layer tenant isolation:
    // RLS + app-layer tenantId filter in findByEmail is the first
    // layer; this explicit check is the app-layer belt-and-suspenders
    // required for the Review-Gate blocker. Removing it breaks the
    // two-layer requirement. Mirror the F3 `get-member` pattern.
    if (existing.value.tenantId !== deps.tenant.slug) {
      logger.error(
        {
          contactId: existing.value.contactId,
          expectedTenant: deps.tenant.slug,
          actualTenant: existing.value.tenantId,
          requestId: input.requestId,
        },
        'invite-user-for-member.findByEmail_tenant_mismatch',
      );
      return err({
        type: 'server_error',
        message: 'findByEmail: tenant mismatch',
      });
    }
    if (existing.value.memberId !== input.memberId) {
      return err({ type: 'email_belongs_to_other_member' });
    }
    if (existing.value.linkedUserId !== null) {
      return err({ type: 'contact_already_linked' });
    }
    decision = { mode: 'link_existing', contactId: existing.value.contactId };
  } else {
    if (existing.error.code !== 'repo.not_found') {
      return err({
        type: 'server_error',
        message: `findByEmail: ${existing.error.code}`,
      });
    }
    decision = { mode: 'create_new' };
  }

  // 4. F1 createUser — its own tx. Creates pending user + invitation +
  //    outbox + account_created audit atomically. Run for BOTH paths
  //    (the link-existing branch still needs an F1 user row for auth).
  const { firstName, lastName } = deriveContactName(
    emailResult.value,
    input.displayName,
  );
  const created = await deps.createUser({
    email: emailResult.value,
    role: 'member',
    displayName: input.displayName ?? `${firstName} ${lastName}`.trim(),
    actorUserId: input.actorUserId,
    sourceIp: input.sourceIp,
    requestId: input.requestId,
    locale: input.locale,
    tenantId: deps.tenant.slug,
  });
  if (!created.ok) {
    if (created.error.code === 'invalid-input') {
      return err({ type: 'invalid_email' });
    }
    if (created.error.code === 'email-taken') {
      return err({ type: 'email_taken' });
    }
    return err({
      type: 'server_error',
      message: `createUser: ${created.error.code}`,
    });
  }

  // 5. Persist in atomic tx.
  //    Path A (create_new): add secondary contact + link user + emit
  //      `contact_created`.
  //    Path B (link_existing): skip addInTx, call linkUserInTx on the
  //      pre-existing contact, emit `contact_linked_to_user`. Existing
  //      contact's firstName/lastName/phone/roleTitle are preserved —
  //      a real person typed them, admin's quick-invite form shouldn't
  //      overwrite with less-accurate data.
  const newContactId =
    decision.mode === 'link_existing'
      ? decision.contactId
      : deps.idFactory.contactId();

  try {
    const contact = await runInTenant(deps.tenant, async (tx) => {
      if (decision.mode === 'create_new') {
        const contactDraft = {
          tenantId: deps.tenant.slug,
          contactId: newContactId,
          memberId: input.memberId,
          firstName,
          lastName,
          email: emailResult.value,
          phone: null,
          roleTitle: null,
          preferredLanguage: (input.locale ?? 'en') as PreferredLanguage,
          isPrimary: false,
          dateOfBirth: null,
          linkedUserId: null,
          inviteBouncedAt: null,
          // Task 8 (GDPR Art. 14) residual — same reasoning as
          // invite-colleague.ts: this path also sends the new contact a real
          // invitation email, a different information-flow from the two
          // silent-collection paths Task 8 closes. Left `null` rather than
          // fabricated; flagged for a follow-up product decision.
          art14AttestedAt: null,
          removedAt: null,
        };
        const added = await deps.contactRepo.addInTx(tx, contactDraft);
        if (!added.ok) throw new UseCaseAbort<RepoError>(added.error);
      }

      const linked = await deps.contactRepo.linkUserInTx(
        tx,
        newContactId,
        created.value.user.id,
      );
      if (!linked.ok) throw new UseCaseAbort<RepoError>(linked.error);

      const audit =
        decision.mode === 'create_new'
          ? {
              eventType: 'contact_created' as const,
              source: 'admin_invite_with_member_link',
              summary: `admin linked new user to member ${input.memberId}`,
            }
          : {
              eventType: 'contact_linked_to_user' as const,
              source: 'admin_invite_link_existing',
              summary: `admin linked existing contact to new user on member ${input.memberId}`,
            };
      const auditResult = await deps.audit.recordInTx(tx, deps.tenant, {
        type: audit.eventType,
        actorUserId: input.actorUserId,
        targetUserId: created.value.user.id,
        requestId: input.requestId,
        summary: audit.summary,
        payload: {
          contact_id: newContactId,
          member_id: input.memberId,
          user_id: created.value.user.id,
          is_primary: false,
          source: audit.source,
        },
      });
      if (!auditResult.ok) throw new UseCaseAbort<RepoError>(auditResult.error);

      return linked.value;
    });

    return ok({
      userId: created.value.user.id,
      contactId: contact.contactId,
      email: emailResult.value,
    });
  } catch (e) {
    const cause = e instanceof UseCaseAbort ? e.error : e;
    logger.error(
      {
        contactId: newContactId,
        // PII hygiene: hash F1 user id to keep cross-request
        // correlation possible without writing the raw id.
        userIdHash: hashId(created.value.user.id),
        cause,
        requestId: input.requestId,
        mode: decision.mode,
      },
      'invite-user-for-member.tx_failed: rolling back orphaned F1 user (SAGA compensation)',
    );
    // go-live #12-13 (follow-up) — the contact tx rolled back, but F1 createUser
    // already committed the pending user. Roll it back via the shared SAGA
    // compensation so no orphan persists. Correct for BOTH paths: the user is
    // freshly created at step 4; deleting it leaves create_new clean (its new
    // contact was rolled back) and link_existing clean (the pre-existing contact
    // stays unlinked, its original state). Never throws → cannot mask the failure.
    await compensateInviteOrphan(deps.deleteInvitedUser, {
      userId: created.value.user.id,
      outboxRowId: created.value.outboxRowId,
      actorUserId: input.actorUserId,
      sourceIp: input.sourceIp,
      requestId: input.requestId,
      targetEmail: emailResult.value,
      opLabel: 'invite-user-for-member',
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
      message: 'invite-user-for-member tx: unexpected',
    });
  }
}

