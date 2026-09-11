/**
 * F114 — `getChangeRequestReview` (US2: FR-019 / FR-020; contracts/
 * admin-change-requests-api.md § review payload).
 *
 * The staff review read model: the request with its display facts (member,
 * submitter, reviewer) plus, per proposed field, the CURRENT value read live
 * and the three flags the review page renders — `changedSinceSubmitted`
 * (current ≠ seen: show all three values), `alreadyCurrent` (proposed =
 * current: approve is a recorded no-op, FR-015) and `undecidable`
 * (`contact_removed`: the submitting contact is removed or unlinked, so the
 * row may only be rejected, FR-020) — and `taxHint`, which names what a
 * tax-affecting flag feeds so the reviewer knows what to check (FR-019).
 *
 * `canDecide` = pending ∧ `canWrite` ∧ ¬archived ∧ ¬erasing. `canWrite` is
 * the caller's answer from the permission evaluator (`members.write`) — the
 * members module cannot import the auth Domain, so the route asks and passes
 * it in. Plain reads, no lock: the decision itself re-reads FOR UPDATE.
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ChangeRequestId, ProposedField, ProposedValue } from '../../../domain/change-request/change-request';
import { proposedValuesEqual, type GroupBRecord } from '../../../domain/change-request/policies';
import { isContactFieldKey, type ProposableFieldKey } from '../../../domain/change-request/proposable-fields';
import type { Contact } from '../../../domain/contact';
import type { Member, MemberId } from '../../../domain/member';
import type { ChangeRequestListRow, ChangeRequestRepo } from '../../ports/change-request-repo';
import type { ContactRepo } from '../../ports/contact-repo';
import type { MemberRepo, RepoError } from '../../ports/member-repo';
import { groupBRecordOf, memberHasBillingAddress } from './submit-change-request';

export type TaxHint = 'buyer_name' | 'buyer_address' | 'buyer_contact' | 'billing_country';

export type ChangeRequestReviewField = ProposedField & {
  readonly current: ProposedValue;
  readonly changedSinceSubmitted: boolean;
  readonly alreadyCurrent: boolean;
  readonly taxHint: TaxHint | null;
  readonly undecidable: 'contact_removed' | null;
};

export type ChangeRequestReview = {
  readonly row: ChangeRequestListRow;
  readonly fields: readonly ChangeRequestReviewField[];
  readonly member: {
    readonly id: MemberId;
    readonly companyName: string;
    readonly memberNumber: number;
    readonly status: string;
    readonly archived: boolean;
    readonly erasing: boolean;
    readonly hasBillingAddress: boolean;
  };
  readonly canDecide: boolean;
};

export type GetChangeRequestReviewDeps = {
  readonly tenant: TenantContext;
  readonly changeRequestRepo: Pick<ChangeRequestRepo, 'findListRowById'>;
  readonly memberRepo: Pick<MemberRepo, 'findById' | 'findErasedAtById'>;
  readonly contactRepo: Pick<ContactRepo, 'listByMember'>;
};

export type GetChangeRequestReviewInput = {
  readonly changeRequestId: ChangeRequestId;
  /** The caller's `members.write` answer from the permission evaluator. */
  readonly canWrite: boolean;
};

export type GetChangeRequestReviewError = { readonly type: 'not_found' } | { readonly type: 'server_error'; readonly message: string };

function liveValueOf(record: GroupBRecord, key: ProposableFieldKey): ProposedValue {
  return isContactFieldKey(key) ? record.contact[key] : record.company[key];
}

/** FR-019 — what the tax-affecting flag feeds, for a field that carries it. */
export function taxHintFor(field: ProposedField, ctx: { readonly submitterIsPrimary: boolean }): TaxHint | null {
  if (!field.affectsTaxDocuments) return null;
  switch (field.key) {
    case 'company_name':
      return 'buyer_name';
    case 'registered_address':
      return 'buyer_address';
    case 'billing_address': {
      const country = field.proposed !== null && typeof field.proposed === 'object' && 'country' in field.proposed ? field.proposed.country : null;
      return country !== null && country.trim().toUpperCase() !== 'TH' ? 'billing_country' : 'buyer_address';
    }
    case 'first_name':
    case 'last_name':
      return ctx.submitterIsPrimary ? 'buyer_contact' : null;
    default:
      return null;
  }
}

export async function getChangeRequestReview(
  deps: GetChangeRequestReviewDeps,
  input: GetChangeRequestReviewInput,
): Promise<Result<ChangeRequestReview, GetChangeRequestReviewError>> {
  const rowResult = await deps.changeRequestRepo.findListRowById(deps.tenant, input.changeRequestId);
  if (!rowResult.ok) return err(mapError(rowResult.error));
  const row = rowResult.value;
  const request = row.request;

  const memberResult = await deps.memberRepo.findById(deps.tenant, request.memberId);
  if (!memberResult.ok) return err(mapError(memberResult.error));
  const member: Member = memberResult.value;
  const erased = await deps.memberRepo.findErasedAtById(deps.tenant, request.memberId);
  if (!erased.ok) return err(mapError(erased.error));
  const erasing = erased.value.erasedAt !== null;

  // Removed contacts included: a removed submitting contact still has to be
  // found to be reported as `contact_removed` rather than silently absent.
  const contactsResult = await deps.contactRepo.listByMember(deps.tenant, request.memberId, { includeRemoved: true });
  if (!contactsResult.ok) return err(mapError(contactsResult.error));
  const contact: Contact | null = contactsResult.value.find((c) => c.contactId === request.submittedByContactId) ?? null;
  const contactGone = contact === null || contact.removedAt !== null || contact.linkedUserId === null;

  const record = groupBRecordOf(member, contact ?? emptyContactFor(request.submittedByContactId, request.memberId));
  const submitterIsPrimary = request.submitterRoleAtSubmission === 'primary';
  const fields: ChangeRequestReviewField[] = request.fields.map((f) => {
    const current = liveValueOf(record, f.key);
    return {
      ...f,
      current,
      changedSinceSubmitted: !proposedValuesEqual(current, f.seen),
      alreadyCurrent: proposedValuesEqual(current, f.proposed),
      taxHint: taxHintFor(f, { submitterIsPrimary }),
      undecidable: contactGone && f.target === 'contact' ? 'contact_removed' : null,
    };
  });

  const archived = member.status === 'archived';
  return ok({
    row,
    fields,
    member: {
      id: member.memberId,
      companyName: member.companyName,
      memberNumber: member.memberNumber,
      status: member.status,
      archived,
      erasing,
      hasBillingAddress: memberHasBillingAddress(member),
    },
    canDecide: request.state === 'pending' && input.canWrite && !archived && !erasing,
  });
}

function mapError(error: RepoError): GetChangeRequestReviewError {
  if (error.code === 'repo.not_found') return { type: 'not_found' };
  return { type: 'server_error', message: error.code };
}

/** A gone contact renders its rows as `contact_removed`; the current value shown is "(empty)". */
function emptyContactFor(contactId: Contact['contactId'], memberId: MemberId): Contact {
  return { contactId, memberId, firstName: '', lastName: '', phone: null, roleTitle: null } as unknown as Contact;
}
