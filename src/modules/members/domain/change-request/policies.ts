/**
 * F114 — pure change-request policies (data-model.md § 7).
 *
 *   deriveOutcome        — per-field outcomes → request outcome (FR-016)
 *   deriveScope          — keys + submitter role → scope, or the FR-002 refusal
 *   diffAgainstRecord    — proposal vs the current record → the rows to store
 *                          (drops equal values; address groups atomic; null = clear)
 *   affectsTaxDocuments  — the FR-019 tax-affecting rule per key
 *   changedSinceSubmitted — FR-019 three-value display (deep-equal on addresses)
 *
 * Pure TypeScript — no framework imports.
 */
import { err, ok, type Result } from '@/lib/result';
import type { ChangeRequestOutcome, ChangeRequestScope, FieldOutcome, ProposedField, ProposedValue } from './change-request';
import {
  BILLING_ADDRESS_LINES,
  PROPOSABLE_FIELD_KEYS,
  PROPOSABLE_FIELD_TARGET,
  REGISTERED_ADDRESS_LINES,
  isAddressGroupKey,
  isCompanyFieldKey,
  type BillingAddress,
  type CompanyFieldKey,
  type ContactFieldKey,
  type ProposableFieldKey,
  type RegisteredAddress,
} from './proposable-fields';

// ---------------------------------------------------------------------------
// Group B shapes
// ---------------------------------------------------------------------------

/** The Group B view of the member record — what a proposal is diffed against. */
export type GroupBContactFields = Readonly<Record<ContactFieldKey, string | null>>;

export type GroupBCompanyFields = {
  readonly company_name: string | null;
  readonly website: string | null;
  readonly description: string | null;
  readonly registered_address: RegisteredAddress;
  readonly billing_address: BillingAddress;
};

export type GroupBRecord = {
  readonly contact: GroupBContactFields;
  readonly company: GroupBCompanyFields;
};

/** A (validated) proposal: only the keys the member sent. */
export type GroupBProposal = {
  readonly contact?: Partial<GroupBContactFields>;
  readonly company?: Partial<GroupBCompanyFields>;
};

/** Inputs to the FR-019 tax-affecting rule. */
export type TaxAffectingContext = {
  /** `true` when the member has a billing address on record at submission. */
  readonly memberHasBillingAddress: boolean;
  /** `true` when the submitting contact is the member's primary contact. */
  readonly submitterIsPrimary: boolean;
};

// ---------------------------------------------------------------------------
// deriveOutcome
// ---------------------------------------------------------------------------

export function deriveOutcome(outcomes: readonly FieldOutcome[]): ChangeRequestOutcome {
  if (outcomes.length === 0) {
    throw new Error('deriveOutcome: a decision needs at least one field');
  }
  const approved = outcomes.filter((o) => o === 'approved').length;
  if (approved === outcomes.length) return 'approved';
  if (approved === 0) return 'rejected';
  return 'partially_approved';
}

// ---------------------------------------------------------------------------
// deriveScope
// ---------------------------------------------------------------------------

export type DeriveScopeError =
  | { readonly code: 'company_fields_require_primary'; readonly keys: readonly CompanyFieldKey[] }
  | { readonly code: 'no_fields' };

export function deriveScope(
  keys: readonly ProposableFieldKey[],
  submitterIsPrimary: boolean,
): Result<ChangeRequestScope, DeriveScopeError> {
  if (keys.length === 0) return err({ code: 'no_fields' });
  const companyKeys = keys.filter(isCompanyFieldKey);
  if (companyKeys.length > 0 && !submitterIsPrimary) {
    return err({ code: 'company_fields_require_primary', keys: companyKeys });
  }
  const hasContact = companyKeys.length < keys.length;
  if (companyKeys.length === 0) return ok('own_contact');
  return ok(hasContact ? 'mixed' : 'company');
}

// ---------------------------------------------------------------------------
// affectsTaxDocuments (FR-019)
// ---------------------------------------------------------------------------

export function affectsTaxDocuments(key: ProposableFieldKey, ctx: TaxAffectingContext): boolean {
  switch (key) {
    case 'company_name':
    case 'billing_address':
      return true;
    case 'registered_address':
      return !ctx.memberHasBillingAddress;
    case 'first_name':
    case 'last_name':
      return ctx.submitterIsPrimary;
    case 'phone':
    case 'role_title':
    case 'website':
    case 'description':
      return false;
  }
}

// ---------------------------------------------------------------------------
// value equality
// ---------------------------------------------------------------------------

function isAddressObject(v: ProposedValue): v is RegisteredAddress | BillingAddress {
  return v !== null && typeof v === 'object';
}

/** Deep-equal for the two value shapes a proposed value can take. */
export function proposedValuesEqual(a: ProposedValue, b: ProposedValue): boolean {
  if (isAddressObject(a) || isAddressObject(b)) {
    if (!isAddressObject(a) || !isAddressObject(b)) return false;
    // Compare over the widest line set; a missing line reads as null so a
    // registered address never "differs" from itself by lacking `country`.
    const lines = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const line of lines) {
      const av = (a as Readonly<Record<string, string | null>>)[line] ?? null;
      const bv = (b as Readonly<Record<string, string | null>>)[line] ?? null;
      if (av !== bv) return false;
    }
    return true;
  }
  return a === b;
}

export function changedSinceSubmitted(field: ProposedField, liveValue: ProposedValue): boolean {
  return !proposedValuesEqual(field.seen, liveValue);
}

// ---------------------------------------------------------------------------
// diffAgainstRecord (FR-005 / FR-007)
// ---------------------------------------------------------------------------

function normaliseAddress(
  key: 'registered_address' | 'billing_address',
  value: Partial<Readonly<Record<string, string | null>>>,
): RegisteredAddress | BillingAddress {
  const lines = key === 'billing_address' ? BILLING_ADDRESS_LINES : REGISTERED_ADDRESS_LINES;
  const out: Record<string, string | null> = {};
  for (const line of lines) out[line] = value[line] ?? null;
  return out as RegisteredAddress | BillingAddress;
}

function proposedFor(proposal: GroupBProposal, key: ProposableFieldKey): ProposedValue | undefined {
  if (isCompanyFieldKey(key)) {
    const company = proposal.company;
    if (company === undefined || !(key in company)) return undefined;
    const raw = company[key];
    if (raw === undefined) return undefined;
    return isAddressGroupKey(key) ? normaliseAddress(key, raw as Partial<Record<string, string | null>>) : (raw as string | null);
  }
  const contact = proposal.contact;
  if (contact === undefined || !(key in contact)) return undefined;
  const raw = contact[key as ContactFieldKey];
  return raw === undefined ? undefined : raw;
}

function seenFor(record: GroupBRecord, key: ProposableFieldKey): ProposedValue {
  if (isCompanyFieldKey(key)) {
    const raw = record.company[key];
    return isAddressGroupKey(key) ? normaliseAddress(key, raw as Partial<Record<string, string | null>>) : (raw as string | null);
  }
  return record.contact[key as ContactFieldKey];
}

/**
 * The rows to store for a submission: every Group B key the proposal carries
 * whose value differs from the record, in `PROPOSABLE_FIELD_KEYS` order.
 * A key the proposal does not mention is not a change; a key equal to the
 * record is dropped (FR-007 "nothing to submit" baseline is the record).
 */
export function diffAgainstRecord(
  record: GroupBRecord,
  proposal: GroupBProposal,
  tax: TaxAffectingContext,
): ProposedField[] {
  const out: ProposedField[] = [];
  for (const key of PROPOSABLE_FIELD_KEYS) {
    const proposed = proposedFor(proposal, key);
    if (proposed === undefined) continue;
    const seen = seenFor(record, key);
    if (proposedValuesEqual(seen, proposed)) continue;
    out.push({
      key,
      target: PROPOSABLE_FIELD_TARGET[key],
      seen,
      proposed,
      affectsTaxDocuments: affectsTaxDocuments(key, tax),
      outcome: null,
      appliedAt: null,
    });
  }
  return out;
}
