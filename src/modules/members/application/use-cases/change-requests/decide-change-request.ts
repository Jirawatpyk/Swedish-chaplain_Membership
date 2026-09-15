/**
 * F114 — `decideChangeRequest` (US2: FR-013–FR-020, FR-022–FR-025;
 * research R4 / R7).
 *
 * A reviewer approves or rejects EVERY proposed field of a pending request
 * in ONE transaction: the approved values are applied to the member /
 * contact record, the request rows are stamped, one audit row and one
 * member email are queued — or nothing is. Order:
 *
 *   input shape (no read yet)
 *     - every decision key unique; reason/note ≤ 1000 chars; a reason is
 *       required iff at least one field is rejected (FR-014);
 *   ONE `runInTenant`, request FOR UPDATE (R4):
 *     - withdrawn → `not_pending`; decided → an IDENTICAL decision is a
 *       harmless repeat (`repeated: true`, no write), a DIFFERENT one is
 *       `already_decided` with the recorded decision (FR-017);
 *     - decisions cover exactly the request's fields (`decisions_incomplete`);
 *     - member under erasure / archived → refused (FR-020);
 *     - a contact-target row whose contact is removed or unlinked may only be
 *       rejected (`contact_removed`);
 *     - approved fields re-validated with the STAFF rules (FR-006) — a value
 *       that no longer passes must be rejected instead (`validation_error`);
 *     - apply: contact patch + member patch (an already-current value is
 *       recorded approved without a write — FR-015); decide rows; audit
 *       `member_change_request_decided` with the REVIEWER as actor; one
 *       `member_change_request_decided_member` outbox row to the submitter's
 *       CURRENT address in the contact's language (FR-023) — skipped, logged,
 *       when the contact is gone (`recipient_gone`).
 *   Every refusal is a throw (rollback); every failure after the first write
 *   is a `UseCaseAbort` throw — never `return err()` inside the callback.
 *
 * The audit payload keys `related_member_id` (NOT `member_id`): a staff
 * decision is not member activity, so `last_activity_at` must not bump.
 * Payloads carry ids, keys, outcomes and the reason LENGTH — never a value
 * or the reason text (R7). `actor_role` is the session role passed in.
 */
import type { z } from 'zod';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { membersMetrics } from '@/lib/metrics';
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import { isDecided, DECISION_NOTE_MAX_LENGTH, DECISION_REASON_MAX_LENGTH, type ChangeRequest, type ChangeRequestId, type ChangeRequestOutcome, type FieldOutcome, type ProposedField, type ProposedValue } from '../../../domain/change-request/change-request';
import { validateProposal } from '../../../domain/change-request/field-rules';
import { deriveOutcome, proposedValuesEqual, type GroupBProposal, type GroupBRecord, normaliseText } from '../../../domain/change-request/policies';
import {
  type BillingAddress,
  type ProposableFieldKey,
  type RegisteredAddress,
} from '../../../domain/change-request/proposable-fields';
import type { Member } from '../../../domain/member';
import { asIsoCountryCode } from '../../../domain/value-objects/iso-country-code';
import { asPhone } from '../../../domain/value-objects/phone';
import type { UserId } from '../../../domain/value-objects/user-id';
import type { AuditPort, ChangeRequestAuditPayload } from '../../ports/audit-port';
import type { ChangeRequestDecision, ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ClockPort } from '../../ports/clock-port';
import type { ContactPatch, ContactRepo } from '../../ports/contact-repo';
import type { EmailPort } from '../../ports/email-port';
import { isRepoError, type MemberPatch, type MemberRepo, type RepoError } from '../../ports/member-repo';
import { UseCaseAbort } from '../../tx-abort';
import { groupBRecordOf } from './submit-change-request';
import { removedContactStandIn } from './removed-contact-stand-in';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FieldDecision = {
  readonly key: string;
  readonly outcome: FieldOutcome;
};

export type DecideChangeRequestInput = {
  readonly changeRequestId: ChangeRequestId;
  readonly decisions: readonly FieldDecision[];
  /** Required iff any field is rejected; shown to the member verbatim (escaped). */
  readonly reason: string | null;
  /** Staff-only remark, never shown to the member. */
  readonly note: string | null;
  readonly actorUserId: UserId;
  /** The SESSION role — recorded in the audit payload as `actor_role`. */
  readonly actorRole: string;
  readonly requestId: string;
};

export type DecideChangeRequestDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: ChangeRequestRepo;
  readonly memberRepo: Pick<MemberRepo, 'findByIdInTx' | 'findErasedAtByIdInTx' | 'updateFieldsInTx'>;
  readonly contactRepo: Pick<ContactRepo, 'listByMemberInTx' | 'updateInTx'>;
  readonly audit: AuditPort;
  readonly emails: EmailPort;
  readonly clock: ClockPort;
};

export type DecideChangeRequestOutcome = {
  readonly request: ChangeRequest;
  /** true when the request was already decided with EXACTLY this decision — nothing was written. */
  readonly repeated: boolean;
  readonly applied: readonly ProposableFieldKey[];
  readonly rejected: readonly ProposableFieldKey[];
};

export type DecideChangeRequestError =
  | {
      readonly type: 'decisions_incomplete';
      readonly missing: readonly string[];
      readonly unknown: readonly string[];
      readonly duplicates: readonly string[];
    }
  | { readonly type: 'reason_required' }
  | { readonly type: 'reason_too_long'; readonly field: 'reason' | 'note'; readonly max: number }
  | { readonly type: 'not_found' }
  | { readonly type: 'not_pending' }
  | {
      readonly type: 'already_decided';
      /** The recorded decision, or null when this caller LOST the lock race and holds nothing (round 7, types S6 — one honest null, never three). */
      readonly decided: { readonly byUserId: UserId; readonly at: Date; readonly outcome: ChangeRequestOutcome } | null;
    }
  | { readonly type: 'member_archived' }
  | { readonly type: 'member_erasing' }
  | { readonly type: 'contact_removed'; readonly keys: readonly ProposableFieldKey[] }
  | { readonly type: 'validation_error'; readonly issues: z.ZodIssue[] }
  | { readonly type: 'server_error'; readonly message: string };

// ---------------------------------------------------------------------------
// Input rules (FR-014) — before any read
// ---------------------------------------------------------------------------


function checkInput(input: DecideChangeRequestInput): DecideChangeRequestError | null {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const d of input.decisions) {
    if (seen.has(d.key)) duplicates.push(d.key);
    seen.add(d.key);
  }
  if (duplicates.length > 0) return { type: 'decisions_incomplete', missing: [], unknown: [], duplicates };
  if (input.reason !== null && input.reason.length > DECISION_REASON_MAX_LENGTH) {
    return { type: 'reason_too_long', field: 'reason', max: DECISION_REASON_MAX_LENGTH };
  }
  if (input.note !== null && input.note.length > DECISION_NOTE_MAX_LENGTH) {
    return { type: 'reason_too_long', field: 'note', max: DECISION_NOTE_MAX_LENGTH };
  }
  const anyRejected = input.decisions.some((d) => d.outcome === 'rejected');
  if (anyRejected && normaliseText(input.reason) === null) return { type: 'reason_required' };
  return null;
}

function checkCoverage(request: ChangeRequest, decisions: readonly FieldDecision[]): DecideChangeRequestError | null {
  const requested = new Set<string>(request.fields.map((f) => f.key));
  const decided = new Set(decisions.map((d) => d.key));
  const missing = [...requested].filter((k) => !decided.has(k));
  const unknown = [...decided].filter((k) => !requested.has(k));
  if (missing.length > 0 || unknown.length > 0) {
    return { type: 'decisions_incomplete', missing, unknown, duplicates: [] };
  }
  return null;
}

/** The recorded decision equals this one: same per-field outcomes, same reason, same note. */
function sameDecision(request: ChangeRequest, input: DecideChangeRequestInput): boolean {
  const byKey = new Map(input.decisions.map((d) => [d.key, d.outcome]));
  if (request.fields.length !== input.decisions.length) return false;
  for (const f of request.fields) {
    if (byKey.get(f.key) !== f.outcome) return false;
  }
  return (
    normaliseText(request.decisionReason) === normaliseText(input.reason) &&
    normaliseText(request.decisionNote) === normaliseText(input.note)
  );
}

// ---------------------------------------------------------------------------
// Proposal re-validation + patches
// ---------------------------------------------------------------------------

/** The approved fields as a raw proposal body — re-run through the staff rules (FR-006). */
function proposalOf(fields: readonly ProposedField[]): Record<string, Record<string, ProposedValue>> {
  const raw: Record<string, Record<string, ProposedValue>> = {};
  for (const f of fields) {
    const group = f.target === 'contact' ? 'contact' : 'company';
    (raw[group] ??= {})[f.key] = f.proposed;
  }
  return raw;
}

type Patches = { readonly contact: ContactPatch; readonly member: MemberPatch };
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

/** Build the two patches from the VALIDATED proposal; an already-current field is skipped. */
function patchesOf(
  proposal: GroupBProposal,
  approved: readonly ProposableFieldKey[],
  record: GroupBRecord,
): Result<Patches, DecideChangeRequestError> {
  const contact: Mutable<ContactPatch> = {};
  const member: Mutable<MemberPatch> = {};
  for (const key of approved) {
    switch (key) {
      case 'first_name': {
        const v = proposal.contact?.first_name;
        if (v !== undefined && v !== null && v !== record.contact.first_name) contact.firstName = v;
        break;
      }
      case 'last_name': {
        const v = proposal.contact?.last_name;
        if (v !== undefined && v !== null && v !== record.contact.last_name) contact.lastName = v;
        break;
      }
      case 'role_title': {
        const v = proposal.contact?.role_title;
        if (v !== undefined && v !== record.contact.role_title) contact.roleTitle = v;
        break;
      }
      case 'phone': {
        const v = proposal.contact?.phone;
        if (v === undefined || v === record.contact.phone) break;
        if (v === null) {
          contact.phone = null;
          break;
        }
        const phone = asPhone(v);
        if (!phone.ok) return err({ type: 'validation_error', issues: [namedIssue(['contact', 'phone'], `phone.${phone.error.code}`)] });
        contact.phone = phone.value;
        break;
      }
      case 'company_name': {
        const v = proposal.company?.company_name;
        if (v !== undefined && v !== null && v !== record.company.company_name) member.companyName = v;
        break;
      }
      case 'website': {
        const v = proposal.company?.website;
        if (v !== undefined && v !== record.company.website) member.website = v;
        break;
      }
      case 'description': {
        const v = proposal.company?.description;
        if (v !== undefined && v !== record.company.description) member.description = v;
        break;
      }
      case 'registered_address': {
        const v = proposal.company?.registered_address;
        if (v === undefined || proposedValuesEqual(v, record.company.registered_address)) break;
        Object.assign(member, registeredPatch(v));
        break;
      }
      case 'billing_address': {
        const v = proposal.company?.billing_address;
        if (v === undefined || proposedValuesEqual(v, record.company.billing_address)) break;
        const billing = billingPatch(v);
        if (!billing.ok) return billing;
        Object.assign(member, billing.value);
        break;
      }
      default: {
        const _exhaustive: never = key;
        void _exhaustive;
        return err({ type: 'validation_error', issues: [] });
      }
    }
  }
  return ok({ contact, member });
}

/** The 422 names the field the reviewer must reject (round 6, silent-failure #22) — never an empty `issues`. */
function namedIssue(path: readonly string[], message: string): z.ZodIssue {
  return { code: 'custom', path: [...path], message };
}

function registeredPatch(v: RegisteredAddress): MemberPatch {
  return {
    addressLine1: v.line1,
    addressLine2: v.line2,
    subDistrict: v.sub_district,
    city: v.city,
    province: v.province,
    postalCode: v.postal_code,
  };
}

function billingPatch(v: BillingAddress): Result<MemberPatch, DecideChangeRequestError> {
  let country: MemberPatch['billingCountry'] = null;
  if (v.country !== null) {
    const parsed = asIsoCountryCode(v.country);
    if (!parsed.ok) return err({ type: 'validation_error', issues: [namedIssue(['company', 'billing_address', 'country'], 'country.invalid')] });
    country = parsed.value;
  }
  return ok({
    billingAddressLine1: v.line1,
    billingAddressLine2: v.line2,
    billingSubDistrict: v.sub_district,
    billingCity: v.city,
    billingProvince: v.province,
    billingPostalCode: v.postal_code,
    billingCountry: country,
  });
}

// ---------------------------------------------------------------------------
// Use case
// ---------------------------------------------------------------------------

/** A refusal thrown inside the tx — rolls back (nothing written) and surfaces typed. */
class Refusal extends UseCaseAbort<DecideChangeRequestError> {}

export async function decideChangeRequest(
  deps: DecideChangeRequestDeps,
  input: DecideChangeRequestInput,
): Promise<Result<DecideChangeRequestOutcome, DecideChangeRequestError>> {
  const tenantId = deps.tenant.slug;
  const startedAt = Date.now();

  const inputError = checkInput(input);
  if (inputError !== null) {
    membersMetrics.changeRequests.refused(tenantId, 'validation');
    return err(inputError);
  }
  const reason = normaliseText(input.reason);
  const note = normaliseText(input.note);
  const now = deps.clock.now();

  try {
    const outcome = await runInTenant(deps.tenant, async (tx): Promise<DecideChangeRequestOutcome> => {
      // 1. the request, FOR UPDATE (R4).
      const found = await deps.changeRequestRepo.findByIdInTx(tx, input.changeRequestId);
      if (!found.ok) {
        if (found.error.code === 'repo.not_found') throw new Refusal({ type: 'not_found' });
        throw new UseCaseAbort<RepoError>(found.error);
      }
      const request = found.value;

      // 2. state (FR-017).
      if (request.state === 'withdrawn') throw new Refusal({ type: 'not_pending' });
      if (isDecided(request)) {
        if (sameDecision(request, input)) {
          return { request, repeated: true, applied: [], rejected: [] };
        }
        // narrowed: a decided row always carries who / when / what (F6)
        throw new Refusal({
          type: 'already_decided',
          decided: { byUserId: request.decidedByUserId, at: request.decidedAt, outcome: request.outcome },
        });
      }

      // 3. every field decided exactly once.
      const coverage = checkCoverage(request, input.decisions);
      if (coverage !== null) throw new Refusal(coverage);
      const outcomeByKey = new Map(input.decisions.map((d) => [d.key, d.outcome]));
      const approvedFields = request.fields.filter((f) => outcomeByKey.get(f.key) === 'approved');
      const rejectedFields = request.fields.filter((f) => outcomeByKey.get(f.key) === 'rejected');
      const approvedKeys = approvedFields.map((f) => f.key);
      const rejectedKeys = rejectedFields.map((f) => f.key);

      // 4. the member: FOR UPDATE first, THEN the erasure check on the same
      //    tx — an erasure that commits between the two reads is seen (it
      //    waits on our lock); a check-before-lock on another connection
      //    would let a decision write PII back into an erased record
      //    (review: reliability I-2 / security I-2). Archived → refused (FR-020).
      const memberResult = await deps.memberRepo.findByIdInTx(tx, request.memberId);
      if (!memberResult.ok) throw new UseCaseAbort<RepoError>(memberResult.error);
      const member: Member = memberResult.value;
      const erased = await deps.memberRepo.findErasedAtByIdInTx(tx, request.memberId);
      if (!erased.ok) throw new UseCaseAbort<RepoError>(erased.error);
      if (erased.value.erasedAt !== null) throw new Refusal({ type: 'member_erasing' });
      if (member.status === 'archived') throw new Refusal({ type: 'member_archived' });

      // 5. the submitting contact — gone ⇒ its rows may only be rejected.
      const contactsResult = await deps.contactRepo.listByMemberInTx(tx, request.memberId);
      if (!contactsResult.ok) throw new UseCaseAbort<RepoError>(contactsResult.error);
      const contact = contactsResult.value.find((c) => c.contactId === request.submittedByContactId) ?? null;
      const contactGone = contact === null || contact.removedAt !== null || contact.linkedUserId === null;
      if (contactGone) {
        const approvedContactKeys = approvedFields.filter((f) => f.target === 'contact').map((f) => f.key);
        if (approvedContactKeys.length > 0) throw new Refusal({ type: 'contact_removed', keys: approvedContactKeys });
      }

      // 6. approved values re-validated with the staff rules (FR-006).
      const validated = validateProposal(proposalOf(approvedFields));
      if (!validated.ok) throw new Refusal({ type: 'validation_error', issues: validated.error });
      const record = groupBRecordOf(member, contact ?? removedContactStandIn());
      const patches = patchesOf(validated.value, approvedKeys, record);
      if (!patches.ok) throw new Refusal(patches.error);

      // 7. apply (FR-015) — contact first, then member. A contact patch with
      //    no contact cannot happen (step 5 refuses approved contact keys when
      //    the contact is gone); if it ever does, abort loudly rather than
      //    silently dropping the approved values (review: reliability M-6).
      if (Object.keys(patches.value.contact).length > 0) {
        if (contact === null) throw new UseCaseAbort<RepoError>({ code: 'repo.unexpected', cause: 'contact patch without a contact' });
        const updated = await deps.contactRepo.updateInTx(tx, contact.contactId, patches.value.contact);
        if (!updated.ok) throw new UseCaseAbort<RepoError>(updated.error);
      }
      if (Object.keys(patches.value.member).length > 0) {
        const updated = await deps.memberRepo.updateFieldsInTx(tx, request.memberId, patches.value.member);
        if (!updated.ok) throw new UseCaseAbort<RepoError>(updated.error);
      }

      // 8. the decision rows.
      // `checkCoverage` proved every key is present; a checked lookup keeps
      // that proof visible instead of three casts (round 7, types N3)
      const outcomeOf = (key: string): FieldOutcome => {
        const o = outcomeByKey.get(key);
        if (o === undefined) throw new Error(`decide: no decision for field ${key} after coverage check`);
        return o;
      };
      const overall = deriveOutcome(request.fields.map((f) => outcomeOf(f.key)));
      const decision: ChangeRequestDecision = {
        decidedAt: now,
        decidedByUserId: input.actorUserId,
        outcome: overall,
        reason,
        note,
        fields: request.fields.map((f) => {
          const o = outcomeOf(f.key);
          return { key: f.key, outcome: o, appliedAt: o === 'approved' ? now : null };
        }),
      };
      const decided = await deps.changeRequestRepo.decideInTx(tx, request.id, decision);
      if (!decided.ok) {
        // 0 rows matched `state = 'pending'`: a concurrent decision won the lock race.
        if (decided.error.code === 'repo.not_found') {
          throw new Refusal({ type: 'already_decided', decided: null });
        }
        throw new UseCaseAbort<RepoError>(decided.error);
      }

      // 9. audit — the REVIEWER is the actor; ids/keys/outcomes only (R7).
      const audited = await deps.audit.recordInTx(tx, deps.tenant, {
        type: 'member_change_request_decided',
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        summary: `change request ${request.id} ${overall} (${approvedKeys.length} approved, ${rejectedKeys.length} rejected)`,
        payload: ({
          related_member_id: request.memberId,
          request_id: request.id,
          contact_id: request.submittedByContactId,
          scope: request.scope,
          outcome: overall,
          fields: request.fields.map((f) => ({ key: f.key, outcome: outcomeOf(f.key) })),
          reason_length: reason?.length ?? 0,
          // round 5 (silent-failure #3) — a decision nobody was told about is
          // a fact on the trail (DSAR-visible via related_member_id), not an
          // info line: FR-023's email is skipped only when the submitting
          // contact is gone / unlinked
          member_notified: !contactGone,
          ...(contactGone ? { member_notification_skipped: 'recipient_gone' } : {}),
          actor_role: input.actorRole,
        } satisfies ChangeRequestAuditPayload['member_change_request_decided']),
      });
      if (!audited.ok) throw new UseCaseAbort<RepoError>(audited.error);

      // 10. the member email (FR-023) — to the submitter's CURRENT address.
      if (contactGone) {
        logger.info(
          { tenantId, changeRequestId: request.id, memberId: request.memberId, requestId: input.requestId, reason: 'recipient_gone' },
          'change-request.decide.member_email_skipped',
        );
        membersMetrics.changeRequests.decisionEmailSkipped(tenantId, 'recipient_gone');
      } else {
        const queued = await deps.emails.enqueueInTx(tx, deps.tenant, {
          type: 'member_change_request_decided_member',
          toEmail: contact.email,
          locale: emailLocale(contact.preferredLanguage),
          contextData: {
            tenantId,
            requestId: request.id,
            memberId: request.memberId,
            submitterUserId: request.submittedByUserId,
          },
        });
        if (!queued.ok) throw new UseCaseAbort<RepoError>(queued.error);
      }

      return { request: decided.value, repeated: false, applied: approvedKeys, rejected: rejectedKeys };
    });

    if (!outcome.repeated && isDecided(outcome.request)) {
      membersMetrics.changeRequests.decided(tenantId, outcome.request.outcome);
      membersMetrics.changeRequests.decideDurationMs(tenantId, Date.now() - startedAt);
    }
    return ok(outcome);
  } catch (e) {
    if (e instanceof Refusal) {
      const refusedReason = refusedMetricReason(e.error);
      if (refusedReason !== null) membersMetrics.changeRequests.refused(tenantId, refusedReason);
      if (e.error.type === 'not_found') {
        await auditProbe(deps.audit, deps.tenant, {
          changeRequestId: input.changeRequestId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          requestId: input.requestId,
          action: 'decide',
        });
      }
      return err(e.error);
    }
    if (e instanceof UseCaseAbort && isRepoError(e.error)) {
      const re = e.error;
      logger.error(
        // `re.code` is the constant `repo.unexpected` for every non-conflict
        // fault; the CAUSE (SQLSTATE / constraint / driver) is what on-call
        // needs (round 5, silent-failure #9 — the set-contact-marketing precedent)
        { tenantId, changeRequestId: input.changeRequestId, requestId: input.requestId, err: re.code, cause: errKind('cause' in re ? re.cause : undefined) },
        'change-request.decide.tx_aborted',
      );
      return err({ type: 'server_error', message: `decide: ${re.code}` });
    }
    logger.error(
      { tenantId, changeRequestId: input.changeRequestId, requestId: input.requestId, err: e instanceof Error ? e.name : String(e) },
      'change-request.decide.unexpected',
    );
    return err({ type: 'server_error', message: 'decide: unexpected' });
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

export { auditProbe as auditChangeRequestProbe };

/**
 * Constitution I.3 — a miss on a change-request id is audited as
 * `member_cross_tenant_probe` (the get-member rule: under RLS a foreign
 * tenant's id and an unknown id look the same, so every miss is recorded).
 * Best-effort: the refusal stands regardless; a failed audit write is logged.
 */
async function auditProbe(
  audit: Pick<AuditPort, 'record'>,
  tenant: TenantContext,
  p: { changeRequestId: ChangeRequestId; actorUserId: UserId; actorRole: string | null; requestId: string; action: 'decide' | 'acknowledge' | 'review' | 'history_item' },
): Promise<void> {
  const audited = await audit.record(tenant, {
    type: 'member_cross_tenant_probe',
    actorUserId: p.actorUserId,
    requestId: p.requestId,
    summary: `change-request probe (${p.action}) on ${p.changeRequestId}`,
    payload: {
      attempted_change_request_id: p.changeRequestId,
      actor_tenant_id: tenant.slug,
      action: p.action,
      actor_role: p.actorRole,
    },
  });
  if (!audited.ok) {
    logger.error(
      { tenantId: tenant.slug, changeRequestId: p.changeRequestId, requestId: p.requestId, err: audited.error.code },
      'change-request.probe_audit_failed',
    );
  }
}

function refusedMetricReason(error: DecideChangeRequestError): 'archived' | 'already_decided' | 'validation' | null {
  switch (error.type) {
    case 'member_archived':
      return 'archived';
    case 'already_decided':
      return 'already_decided';
    case 'validation_error':
    case 'decisions_incomplete':
    case 'reason_required':
    case 'reason_too_long':
      return 'validation';
    default:
      return null;
  }
}

function emailLocale(preferred: string | null | undefined): 'en' | 'th' | 'sv' {
  return preferred === 'th' || preferred === 'sv' ? preferred : 'en';
}
