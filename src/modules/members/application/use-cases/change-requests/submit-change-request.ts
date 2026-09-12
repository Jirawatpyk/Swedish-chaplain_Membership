/**
 * F114 — `submitChangeRequest` (US1: FR-001, FR-002, FR-005–FR-008, FR-011,
 * FR-012, FR-025; research R3 / R7 / R8 / R14).
 *
 * A member's edit of Group B fields becomes a PENDING change request; the
 * member record is not touched. Order of checks (every refusal before the
 * first write):
 *
 *   1. forged keys — anything outside Group B (a Group C key, a Group A key,
 *      an unknown address line) is refused BEFORE parsing and audited
 *      `member_self_update_forbidden`, exactly as a forged immediate edit is
 *      today (FR-002 / FR-003);
 *   2. the caller's own contact (IDOR guard) — must belong to the member and
 *      be live; company keys need `is_primary` (FR-002);
 *   3. `validateProposal` — the staff rules (FR-006);
 *   4. archived member — refused (FR-020 class);
 *   5. `diffAgainstRecord` — the baseline is the CURRENT record; nothing
 *      differing is answered INSIDE the tx (step 6) once the pending row is
 *      known: `nothing_to_submit` (FR-007), or `already_pending` +
 *      `unchanged: true` when a different proposal is pending (round 6 code #5);
 *   6. ONE `runInTenant`: the submitter's pending row FOR UPDATE → identical
 *      → `already_pending` (no write) · then the DURABLE cap (US5, R9): ≥ 10
 *      rows by this person in the trailing 24 h → `rate_limited` before any
 *      write (counted from the request table — replaced rows count; no
 *      rate-limiting service is consulted, so the cap holds with Upstash
 *      down or absent) · different → withdrawn/replaced (R3); member FOR
 *      UPDATE re-check; insert; audit; one outbox row PER REVIEWER (FR-011 /
 *      FR-012) — UNLESS the replaced request's `staff_notified_at` is within
 *      1 h (US5, R8): then the new row INHERITS that timestamp, no row is
 *      queued and the audit says `coalesced: true` (the earlier email's link
 *      resolves to the person's CURRENT pending request). Every failure after
 *      the first write is a `UseCaseAbort` throw — never `return err()`
 *      inside the callback.
 *
 * The rate-limit refusal is a throw inside the tx (the tx wrote nothing) and
 * its audit row `member_change_request_rate_limited` is recorded AFTER the
 * tx with `audit.record` — inside it the rollback would erase it.
 *
 * Audit payloads carry ids, keys and outcomes — never a value (R7). The
 * `member_id` key (snake_case) bumps `last_activity_at` on submit: this IS
 * member activity. `actor_role` is the session role passed in — never a
 * literal (check:actor-role-truth).
 */
import type { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { membersMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import {
  STAFF_NOTIFICATION_COALESCE_HOURS,
  SUBMISSIONS_PER_WINDOW_CAP,
  SUBMISSION_WINDOW_HOURS,
  type ChangeRequest,
  type ChangeRequestId,
  type ChangeRequestScope,
  type ProposedField,
} from '../../../domain/change-request/change-request';
import { validateProposal } from '../../../domain/change-request/field-rules';
import {
  deriveScope,
  diffAgainstRecord,
  proposedValuesEqual,
  type GroupBProposal,
  type GroupBRecord,
  normaliseText,
} from '../../../domain/change-request/policies';
import {
  BILLING_ADDRESS_LINES,
  COMPANY_FIELD_KEYS,
  CONTACT_FIELD_KEYS,
  REGISTERED_ADDRESS_LINES,
  isCompanyFieldKey,
  type CompanyFieldKey,
} from '../../../domain/change-request/proposable-fields';
import type { Contact, ContactId } from '../../../domain/contact';
import type { Member, MemberId, TenantId } from '../../../domain/member';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { AuditPort, ChangeRequestAuditPayload } from '../../ports/audit-port';
import type { ChangeRequestDraft, ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { ContactRepo } from '../../ports/contact-repo';
import type { EmailPort } from '../../ports/email-port';
import { isRepoError, type MemberRepo, type RepoError } from '../../ports/member-repo';
import type { ReviewerDirectoryPort, Reviewer } from '../../ports/reviewer-directory-port';
import { UseCaseAbort } from '../../tx-abort';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubmitChangeRequestInput = {
  readonly memberId: MemberId;
  /** The caller's OWN contact (from the member context) — never a body value. */
  readonly contactId: ContactId;
  readonly rawBody: unknown;
  readonly actorUserId: UserId;
  /** The SESSION role — recorded in every audit payload as `actor_role`. */
  readonly actorRole: string;
  readonly requestId: string;
};

export type SubmitChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: ChangeRequestRepo;
  readonly memberRepo: Pick<MemberRepo, 'findById' | 'findByIdInTx'>;
  readonly contactRepo: Pick<ContactRepo, 'findById'>;
  readonly audit: AuditPort;
  readonly emails: EmailPort;
  readonly reviewers: ReviewerDirectoryPort;
  readonly clock: ClockPort;
  readonly newRequestId: () => ChangeRequestId;
};

export type SubmitChangeRequestOutcome =
  | {
      readonly outcome: 'submitted';
      readonly request: ChangeRequest;
      /** The previous pending request this one replaced (FR-008), or null. */
      readonly replaced: ChangeRequestId | null;
      /** false when zero reviewers exist (misconfigured tenant) or the email was coalesced (US5). */
      readonly staffNotified: boolean;
      /** true when the replaced request's staff email is < 1 h old, so none was queued (FR-011). */
      readonly coalesced: boolean;
    }
  | { readonly outcome: 'nothing_to_submit' }
  | {
      readonly outcome: 'already_pending';
      readonly request: ChangeRequest;
      /**
       * `true` when the proposal matched the RECORD (the member "reverted" the
       * form) while a DIFFERENT proposal is pending — the pending request is
       * still what will be applied (round 7). `false` when the proposal is the
       * pending one.
       */
      readonly unchanged: boolean;
    };

export type SubmitChangeRequestError =
  | {
      readonly type: 'forbidden';
      readonly reason: 'forged_fields' | 'company_fields_require_primary' | 'contact_mismatch';
      readonly fields: readonly string[];
    }
  | { readonly type: 'validation_error'; readonly issues: z.ZodIssue[] }
  | { readonly type: 'member_archived' }
  | { readonly type: 'not_found' }
  /** FR-008 — ≥ 10 CREATED requests in the trailing 24 h; `retryAfterSeconds` = when the oldest leaves the window. */
  | { readonly type: 'rate_limited'; readonly retryAfterSeconds: number; readonly windowCount: number }
  | { readonly type: 'server_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Forged-key detection (BEFORE parsing — FR-002 / FR-003)
// ---------------------------------------------------------------------------

const TOP_LEVEL_KEYS = new Set(['contact', 'company']);
const CONTACT_KEYS = new Set<string>(CONTACT_FIELD_KEYS);
const COMPANY_KEYS = new Set<string>(COMPANY_FIELD_KEYS);
const REGISTERED_LINES = new Set<string>(REGISTERED_ADDRESS_LINES);
const BILLING_LINES = new Set<string>(BILLING_ADDRESS_LINES);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Every key the raw body carries that is not a Group B key, dotted
 * (`company.tax_id`, `contact.preferred_language`, `company.registered_address.street`).
 * Mirrors `detectForbiddenFields` in member-self-update.ts.
 */
export function detectForbiddenProposalKeys(raw: unknown): string[] {
  if (!isRecord(raw)) return [];
  const forbidden: string[] = [];
  for (const key of Object.keys(raw)) {
    if (!TOP_LEVEL_KEYS.has(key)) forbidden.push(key);
  }
  const contact = raw['contact'];
  if (isRecord(contact)) {
    for (const key of Object.keys(contact)) {
      if (!CONTACT_KEYS.has(key)) forbidden.push(`contact.${key}`);
    }
  }
  const company = raw['company'];
  if (isRecord(company)) {
    for (const key of Object.keys(company)) {
      if (!COMPANY_KEYS.has(key)) {
        forbidden.push(`company.${key}`);
        continue;
      }
      const group = company[key];
      if (key === 'registered_address' && isRecord(group)) {
        for (const line of Object.keys(group)) {
          if (!REGISTERED_LINES.has(line)) forbidden.push(`company.registered_address.${line}`);
        }
      }
      if (key === 'billing_address' && isRecord(group)) {
        for (const line of Object.keys(group)) {
          if (!BILLING_LINES.has(line)) forbidden.push(`company.billing_address.${line}`);
        }
      }
    }
  }
  return forbidden;
}

const FORGED_KEYS_MAX = 20;
const FORGED_KEY_MAX_LENGTH = 64;

/** Attacker-controlled key names are bounded before they reach ANY sink (audit, response, idempotency cache). */
export function boundForbiddenKeys(fields: readonly string[]): { readonly fields: string[]; readonly truncated: boolean } {
  return {
    fields: fields.slice(0, FORGED_KEYS_MAX).map((k) => (k.length > FORGED_KEY_MAX_LENGTH ? `${k.slice(0, FORGED_KEY_MAX_LENGTH)}…` : k)),
    truncated: fields.length > FORGED_KEYS_MAX,
  };
}

function companyKeysIn(raw: unknown): CompanyFieldKey[] {
  if (!isRecord(raw) || !isRecord(raw['company'])) return [];
  return Object.keys(raw['company']).filter(isCompanyFieldKey);
}

// ---------------------------------------------------------------------------
// Record projection (Member + Contact → the Group B view)
// ---------------------------------------------------------------------------

// The record is read NORMALISED (trim, '' → null — `normaliseText`, the rule
// both sides of the diff apply) so the review page's `changedSinceSubmitted`
// / `alreadyCurrent` compare like with like: a record holding 'CEO ' against a
// seen 'CEO' is not a change (round 6, code #2).
/** The four contact columns the Group B record reads — a removed contact's stand-in provides exactly these (round 7). */
export type GroupBContactRecord = Pick<Contact, 'firstName' | 'lastName' | 'phone' | 'roleTitle'>;

export function groupBRecordOf(member: Member, contact: GroupBContactRecord): GroupBRecord {
  const n = normaliseText;
  return {
    contact: {
      first_name: n(contact.firstName) ?? '',
      last_name: n(contact.lastName) ?? '',
      phone: n(contact.phone),
      role_title: n(contact.roleTitle),
    },
    company: {
      company_name: n(member.companyName) ?? '',
      website: n(member.website),
      description: n(member.description),
      registered_address: {
        line1: n(member.addressLine1),
        line2: n(member.addressLine2),
        sub_district: n(member.subDistrict),
        city: n(member.city),
        province: n(member.province),
        postal_code: n(member.postalCode),
      },
      billing_address: {
        line1: n(member.billingAddressLine1),
        line2: n(member.billingAddressLine2),
        sub_district: n(member.billingSubDistrict),
        city: n(member.billingCity),
        province: n(member.billingProvince),
        postal_code: n(member.billingPostalCode),
        country: n(member.billingCountry),
      },
    },
  };
}

/** "Set" ⟺ `billingAddressLine1 !== null` (member-billing-address 0284). */
export function memberHasBillingAddress(member: Member): boolean {
  return (member.billingAddressLine1 ?? null) !== null;
}

/**
 * The billing state the approval could LEAVE — a NARROWING of today's state,
 * never a replacement: a proposal that CLEARS the group makes the registered
 * address the §86/4 buyer address (flag it), while a proposal that ADDS a
 * group to a member without one may be rejected field-by-field, so the
 * registered address must stay flagged (review round 2, tax R1).
 */
export function resultingHasBillingAddress(member: Member, proposal: GroupBProposal): boolean {
  const proposed = proposal.company?.billing_address;
  if (proposed !== undefined && proposed.line1 === null) return false;
  return memberHasBillingAddress(member);
}

function sameProposal(pending: ChangeRequest, fields: readonly Omit<ProposedField, 'outcome' | 'appliedAt'>[]): boolean {
  if (pending.fields.length !== fields.length) return false;
  const byKey = new Map(pending.fields.map((f) => [f.key, f]));
  return fields.every((f) => {
    const p = byKey.get(f.key);
    return p !== undefined && proposedValuesEqual(p.proposed, f.proposed);
  });
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

export async function submitChangeRequest(
  deps: SubmitChangeRequestDeps,
  input: SubmitChangeRequestInput,
  opts: { readonly retriedAfterConflict?: boolean } = {},
): Promise<Result<SubmitChangeRequestOutcome, SubmitChangeRequestError>> {
  const tenantId = deps.tenant.slug;

  // 1. forged keys — refuse + audit BEFORE parsing (FR-002 / FR-003).
  const forbiddenRaw = detectForbiddenProposalKeys(input.rawBody);
  if (forbiddenRaw.length > 0) {
    const bounded = boundForbiddenKeys(forbiddenRaw);
    await auditForged(deps, input, bounded);
    membersMetrics.changeRequests.refused(tenantId, 'forbidden');
    return err({ type: 'forbidden', reason: 'forged_fields', fields: bounded.fields });
  }

  // 2. the caller's own contact (IDOR guard) + who-may-propose (FR-002).
  const contactResult = await deps.contactRepo.findById(deps.tenant, input.contactId);
  if (!contactResult.ok) return err(mapLoadError(contactResult.error));
  const contact = contactResult.value;
  if (contact.memberId !== input.memberId || contact.removedAt !== null) {
    membersMetrics.changeRequests.refused(tenantId, 'forbidden');
    return err({ type: 'forbidden', reason: 'contact_mismatch', fields: [] });
  }
  const submitterIsPrimary = contact.isPrimary;
  const companyKeys = companyKeysIn(input.rawBody);
  if (companyKeys.length > 0 && !submitterIsPrimary) {
    const bounded = boundForbiddenKeys(companyKeys.map((k) => `company.${k}`));
    await auditForged(deps, input, bounded);
    membersMetrics.changeRequests.refused(tenantId, 'forbidden');
    return err({ type: 'forbidden', reason: 'company_fields_require_primary', fields: bounded.fields });
  }

  // 3. the staff rules (FR-006).
  const validated = validateProposal(input.rawBody);
  if (!validated.ok) {
    membersMetrics.changeRequests.refused(tenantId, 'validation');
    return err({ type: 'validation_error', issues: validated.error });
  }
  const proposal: GroupBProposal = validated.value;

  // 4. the member (pre-tx read; re-checked FOR UPDATE inside the tx).
  const memberResult = await deps.memberRepo.findById(deps.tenant, input.memberId);
  if (!memberResult.ok) return err(mapLoadError(memberResult.error));
  const member = memberResult.value;
  if (member.status === 'archived') {
    membersMetrics.changeRequests.refused(tenantId, 'archived');
    return err({ type: 'member_archived' });
  }

  // 5. the diff against the CURRENT record (FR-005 / FR-007). The
  //    tax-affecting flag reads the billing state the approval would LEAVE
  //    (FR-019 "a member with no billing address on record"): a proposal that
  //    clears the billing group makes the registered address the §86/4 buyer
  //    address, so it is flagged even though a billing address exists today
  //    (review: tax I-1 — the update-member rule evaluates `resulting(k)` too).
  const fields = diffAgainstRecord(groupBRecordOf(member, contact), proposal, {
    memberHasBillingAddress: resultingHasBillingAddress(member, proposal),
    submitterIsPrimary,
  });
  // "nothing differs from the RECORD" is answered inside the tx, after the
  // pending read: while a proposal is pending the honest answer is
  // `already_pending` (the member cannot silently "revert" it — withdrawing
  // is US5), never "nothing to submit" (round 6, code #5)
  const nothingDiffers = fields.length === 0;
  const scopeResult = nothingDiffers ? ok('company' as ChangeRequestScope) : deriveScope(
    fields.map((f) => f.key),
    submitterIsPrimary,
  );
  if (!scopeResult.ok) {
    // Unreachable after the company-key guard above; kept as a typed refusal
    // rather than a cast so a future Domain rule change surfaces here.
    membersMetrics.changeRequests.refused(tenantId, 'forbidden');
    return err({ type: 'forbidden', reason: 'company_fields_require_primary', fields: [] });
  }
  const scope: ChangeRequestScope = scopeResult.value;

  // Reviewer roster — a cross-tenant `users` read; taken BEFORE the tx so no
  // row lock is held during it. Empty is a valid (misconfigured) answer; a
  // THROW (the read has no Result — round 2 R-1's class) is a logged
  // server_error, never an unhandled rejection out of the route (round 7,
  // silent-failure N1). The no-reviewers signal itself fires only once a
  // request is actually CREATED — see the outcome branch below.
  let reviewers: readonly Reviewer[];
  try {
    reviewers = await deps.reviewers.listReviewers();
  } catch (e) {
    logger.error(
      { tenantId, memberId: input.memberId, requestId: input.requestId, err: errKind(e) },
      'change-request.submit.roster_read_failed',
    );
    return err({ type: 'server_error', message: 'submit: roster_read_failed' });
  }

  const now = deps.clock.now();
  const newId = deps.newRequestId();

  // 6. ONE transaction — throw-to-rollback after the first write.
  try {
    const outcome = await runInTenant(deps.tenant, async (tx): Promise<SubmitChangeRequestOutcome> => {
      const pendingResult = await deps.changeRequestRepo.findPendingBySubmitterInTx(tx, input.actorUserId);
      if (!pendingResult.ok) throw new UseCaseAbort<RepoError>(pendingResult.error);
      const pending = pendingResult.value;
      if (nothingDiffers) {
        return pending !== null ? { outcome: 'already_pending', request: pending, unchanged: true } : { outcome: 'nothing_to_submit' };
      }
      if (pending !== null && sameProposal(pending, fields)) {
        return { outcome: 'already_pending', request: pending, unchanged: false };
      }

      // The durable cap (FR-008, R9) — counted from the rows themselves,
      // replaced ones included, BEFORE the first write. `retryAfterSeconds`
      // is when the OLDEST row in the window falls out of it.
      const windowStart = new Date(now.getTime() - SUBMISSION_WINDOW_HOURS * 3_600_000);
      const inWindow = await deps.changeRequestRepo.countSubmittedSince(tx, input.actorUserId, windowStart);
      if (!inWindow.ok) throw new UseCaseAbort<RepoError>(inWindow.error);
      if (inWindow.value.count >= SUBMISSIONS_PER_WINDOW_CAP) {
        const oldest = inWindow.value.oldestSubmittedAt ?? now;
        const retryAfterSeconds = Math.max(1, Math.ceil((oldest.getTime() + SUBMISSION_WINDOW_HOURS * 3_600_000 - now.getTime()) / 1000));
        throw new RateLimitedAbort(inWindow.value.count, retryAfterSeconds);
      }

      const fresh = await deps.memberRepo.findByIdInTx(tx, input.memberId);
      if (!fresh.ok) throw new UseCaseAbort<RepoError>(fresh.error);
      if (fresh.value.status === 'archived') throw new MemberArchivedAbort();

      let replaced: ChangeRequestId | null = null;
      // FR-011 coalescing (R8): no new staff email within 1 h of the last one
      // for this person — the replaced row carries that time (itself
      // inherited along a chain of replacements, so a burst of resubmits
      // yields ONE email per hour, never one per resubmit).
      const lastNotifiedAt = pending?.staffNotifiedAt ?? null;
      const coalesced =
        lastNotifiedAt !== null && now.getTime() - lastNotifiedAt.getTime() < STAFF_NOTIFICATION_COALESCE_HOURS * 3_600_000;
      if (pending !== null) {
        const w = await deps.changeRequestRepo.withdrawInTx(tx, pending.id, {
          reason: 'replaced',
          withdrawnAt: now,
          replacedByRequestId: newId,
        });
        if (!w.ok) throw new UseCaseAbort<RepoError>(w.error);
        replaced = pending.id;
        const wa = await deps.audit.recordInTx(tx, deps.tenant, {
          type: 'member_change_request_withdrawn',
          actorUserId: input.actorUserId,
          requestId: input.requestId,
          summary: `change request ${pending.id} replaced by ${newId}`,
          // `withdrawn_reason`, not `reason`: the bare key is on the audit
          // redaction deny-list (free-text reasons), and this is a closed enum
          // the manager projection + the member's own archive must keep.
          payload: ({
            related_member_id: input.memberId,
            request_id: pending.id,
            contact_id: pending.submittedByContactId,
            scope: pending.scope,
            withdrawn_reason: 'replaced',
            replaced_by_request_id: newId,
            actor_role: input.actorRole,
          } satisfies ChangeRequestAuditPayload['member_change_request_withdrawn']),
        });
        if (!wa.ok) throw new UseCaseAbort<RepoError>(wa.error);
      }

      const staffNotified = !coalesced && reviewers.length > 0;
      const draft: ChangeRequestDraft = {
        id: newId,
        tenantId: tenantId as TenantId,
        memberId: input.memberId,
        submittedByUserId: input.actorUserId,
        submittedByContactId: input.contactId,
        submitterRoleAtSubmission: submitterIsPrimary ? 'primary' : 'secondary',
        scope,
        submittedAt: now,
        // inherited when coalesced (the earlier email already leads here)
        staffNotifiedAt: coalesced ? lastNotifiedAt : staffNotified ? now : null,
        fields,
      };
      const inserted = await deps.changeRequestRepo.insertInTx(tx, draft);
      if (!inserted.ok) throw new UseCaseAbort<RepoError>(inserted.error);

      const fieldKeys = fields.map((f) => f.key);
      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_change_request_submitted',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `change request ${newId} submitted (${scope}: ${fieldKeys.join(', ')})`,
        payload: ({
          member_id: input.memberId,
          request_id: newId,
          contact_id: input.contactId,
          scope,
          field_keys: fieldKeys,
          replaced_request_id: replaced,
          coalesced,
          actor_role: input.actorRole,
        } satisfies ChangeRequestAuditPayload['member_change_request_submitted']),
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);

      for (const reviewer of coalesced ? [] : reviewers) {
        const queued = await deps.emails.enqueueInTx(tx, deps.tenant, {
          type: 'member_change_request_submitted_staff',
          toEmail: reviewer.email,
          locale: reviewer.locale,
          contextData: {
            tenantId,
            requestId: newId,
            memberId: input.memberId,
            submitterUserId: input.actorUserId,
            reviewerUserId: reviewer.userId,
            fieldKeys,
          },
        });
        if (!queued.ok) throw new UseCaseAbort<RepoError>(queued.error);
      }

      return { outcome: 'submitted', request: inserted.value, replaced, staffNotified, coalesced };
    });

    if (outcome.outcome === 'submitted') {
      membersMetrics.changeRequests.submitted(tenantId, scope, outcome.coalesced);
      if (reviewers.length === 0) {
        // a CREATED request nobody will be told about (round 5, silent-failure
        // #5; moved here in round 7 so a no-op submit does not count)
        logger.warn(
          { tenantId, memberId: input.memberId, requestId: input.requestId, changeRequestId: outcome.request.id },
          'change-request.submit.no_reviewers — request created but nobody is notified',
        );
        membersMetrics.changeRequests.noReviewers(tenantId);
      }
    }
    return ok(outcome);
  } catch (e) {
    if (e instanceof MemberArchivedAbort) {
      membersMetrics.changeRequests.refused(tenantId, 'archived');
      return err({ type: 'member_archived' });
    }
    if (e instanceof RateLimitedAbort) {
      // the tx wrote nothing; the refusal itself is recorded OUTSIDE it
      // (FR-008 "recorded in the audit trail as a rate-limit refusal") —
      // best-effort like the forgery trail: the refusal stands regardless
      membersMetrics.changeRequests.refused(tenantId, 'rate_limited');
      const audited = await deps.audit.record(deps.tenant, {
        type: 'member_change_request_rate_limited',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `change request refused: ${e.windowCount} submissions in ${SUBMISSION_WINDOW_HOURS} h`,
        // a REFUSED attempt is not member activity: `related_member_id`, never
        // the 0009 trigger key `member_id` (review round 1, REL-3 / P-7)
        payload: {
          related_member_id: input.memberId,
          window_count: e.windowCount,
          retry_after_seconds: e.retryAfterSeconds,
          actor_role: input.actorRole,
        } satisfies ChangeRequestAuditPayload['member_change_request_rate_limited'],
      });
      if (!audited.ok) {
        logger.error(
          { tenantId, memberId: input.memberId, requestId: input.requestId, err: audited.error.code },
          'change-request.submit: audit write failed on rate_limited path',
        );
      }
      return err({ type: 'rate_limited', retryAfterSeconds: e.retryAfterSeconds, windowCount: e.windowCount });
    }
    if (e instanceof UseCaseAbort && isRepoError(e.error)) {
      const re = e.error;
      // The partial unique index refused a second pending row: two submits
      // raced past the (empty) FOR UPDATE read. The loser's proposal is
      // already pending — answer `already_pending` from a fresh read, never
      // a 500 (review: reliability I-1). Falls through when the re-read
      // finds nothing (the winner withdrew in between).
      if (re.code === 'repo.conflict' && re.reason === 'change_request_pending_exists') {
        const raced = await runInTenant(deps.tenant, (tx) =>
          deps.changeRequestRepo.findPendingBySubmitterInTx(tx, input.actorUserId),
        ).catch((e: unknown) => {
          logger.warn(
            { tenantId, memberId: input.memberId, requestId: input.requestId, err: e instanceof Error ? e.name : String(e) },
            'change-request.submit.conflict_reread_failed',
          );
          return null;
        });
        // the re-read can also fail as a Result (a throw is caught above) —
        // log that arm too, or the operator reads the original conflict as the
        // whole story (round 5, silent-failure #11)
        if (raced && !raced.ok) {
          logger.warn(
            { tenantId, memberId: input.memberId, requestId: input.requestId, err: raced.error.code },
            'change-request.submit.conflict_reread_failed',
          );
        }
        if (raced && raced.ok && raced.value) {
          // the winner's proposal IS this one → the harmless answer
          if (sameProposal(raced.value, fields)) return ok({ outcome: 'already_pending', request: raced.value, unchanged: false });
          // a DIFFERENT proposal lost the race: one bounded retry now finds the
          // winner's pending row FOR UPDATE and takes the replace path (FR-008)
          if (!opts.retriedAfterConflict) return submitChangeRequest(deps, input, { retriedAfterConflict: true });
        }
      }
      logger.error(
        { tenantId, memberId: input.memberId, requestId: input.requestId, err: re.code, cause: errKind('cause' in re ? re.cause : undefined) },
        'change-request.submit.tx_aborted',
      );
      return err({ type: 'server_error', message: `submit: ${re.code}` });
    }
    logger.error(
      { tenantId, memberId: input.memberId, requestId: input.requestId, err: e instanceof Error ? e.name : String(e) },
      'change-request.submit.unexpected',
    );
    return err({ type: 'server_error', message: 'submit: unexpected' });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

class MemberArchivedAbort extends Error {}

/** FR-008 — the durable cap refused the submission; carries what the audit row and the 429 need. */
class RateLimitedAbort extends Error {
  constructor(
    readonly windowCount: number,
    readonly retryAfterSeconds: number,
  ) {
    super('rate_limited');
  }
}

function mapLoadError(error: RepoError): SubmitChangeRequestError {
  if (error.code === 'repo.not_found') return { type: 'not_found' };
  return { type: 'server_error', message: error.code };
}

/**
 * The forgery trail (FR-002 / FR-003) — the SAME event a forged immediate edit
 * emits today. Best-effort: the refusal is fail-closed regardless; a failed
 * audit write is logged so an un-audited forgery attempt is detectable.
 */
async function auditForged(deps: SubmitChangeRequestDeps, input: SubmitChangeRequestInput, bounded: ReturnType<typeof boundForbiddenKeys>): Promise<void> {
  // Key NAMES are attacker-controlled text landing in an append-only table
  // that erasure never scrubs — the caller bounded them (review: privacy M-7).
  const audited = await deps.audit.record(deps.tenant, {
    type: 'member_self_update_forbidden',
    actorUserId: input.actorUserId,
    requestId: input.requestId,
    summary: `forged change-request fields: ${bounded.fields.join(', ')}`,
    payload: {
      member_id: input.memberId,
      contact_id: input.contactId,
      attempted_fields: bounded.fields,
      attempted_fields_truncated: bounded.truncated,
      actor_role: input.actorRole,
    },
  });
  if (!audited.ok) {
    logger.error(
      { tenantId: deps.tenant.slug, memberId: input.memberId, requestId: input.requestId, err: audited.error.code },
      'change-request.submit: audit write failed on forgery path',
    );
  }
}
