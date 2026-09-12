/**
 * F114 T016 — Domain policies for member change requests (data-model.md § 3, § 4, § 7).
 *
 * Pure functions, no I/O. Pinned here:
 *   - `PROPOSABLE_FIELD_KEYS` is exactly the Group B set migration 0300's CHECK lists
 *     (FR-002 — one compile-time constant, one DB CHECK, one parity test);
 *   - `deriveOutcome`: all approved → approved, none → rejected, mixed → partially_approved
 *     (FR-016);
 *   - `deriveScope`: a company key from a non-primary submitter is refused
 *     (`company_fields_require_primary`, FR-002); own-contact-only → `own_contact`;
 *     company-only → `company`; both → `mixed`;
 *   - `diffAgainstRecord`: drops equal values, treats an address group as ONE atomic row,
 *     keeps `null` as "clear the field" (FR-005 / FR-007 / § Edge Cases);
 *   - `affectsTaxDocuments`: company_name + billing_address always; registered_address iff the
 *     member has NO billing address; first/last name iff the submitter is the primary (FR-019);
 *   - `changedSinceSubmitted`: deep-equal for address objects (FR-019 three-value display).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BILLING_ADDRESS_LINES,
  COMPANY_FIELD_KEYS,
  CONTACT_FIELD_KEYS,
  PROPOSABLE_FIELD_KEYS,
  PROPOSABLE_FIELD_TARGET,
  REGISTERED_ADDRESS_LINES,
  isProposableFieldKey,
} from '@/modules/members/domain/change-request/proposable-fields';
import {
  affectsTaxDocuments,
  changedSinceSubmitted,
  deriveOutcome,
  deriveScope,
  diffAgainstRecord,
  proposedValuesEqual,
  type GroupBRecord,
} from '@/modules/members/domain/change-request/policies';
import { changeRequestInvariantViolation, isDecided, isWithdrawn, type ChangeRequest, type ProposedField, type ProposedValue } from '@/modules/members/domain/change-request/change-request';

const RECORD: GroupBRecord = {
  contact: { first_name: 'Anna', last_name: 'Svensson', phone: '+66812345678', role_title: null },
  company: {
    company_name: 'Nordic Co',
    website: 'https://nordic.example',
    description: null,
    registered_address: {
      line1: '1 Main Rd',
      line2: null,
      sub_district: null,
      city: 'Bangkok',
      province: null,
      postal_code: '10110',
    },
    billing_address: {
      line1: null,
      line2: null,
      sub_district: null,
      city: null,
      province: null,
      postal_code: null,
      country: null,
    },
  },
};

const TAX_CTX = { memberHasBillingAddress: false, submitterIsPrimary: true } as const;

describe('PROPOSABLE_FIELD_KEYS (FR-002 compile-time constant)', () => {
  it('is exactly the Group B set, contact keys first', () => {
    expect(PROPOSABLE_FIELD_KEYS).toEqual([
      'first_name',
      'last_name',
      'phone',
      'role_title',
      'company_name',
      'website',
      'description',
      'registered_address',
      'billing_address',
    ]);
    expect([...CONTACT_FIELD_KEYS, ...COMPANY_FIELD_KEYS]).toEqual([...PROPOSABLE_FIELD_KEYS]);
  });

  it('maps every key to its write target', () => {
    for (const key of CONTACT_FIELD_KEYS) expect(PROPOSABLE_FIELD_TARGET[key]).toBe('contact');
    for (const key of COMPANY_FIELD_KEYS) expect(PROPOSABLE_FIELD_TARGET[key]).toBe('member');
  });

  it('address groups: billing = registered lines + country', () => {
    expect(REGISTERED_ADDRESS_LINES).toEqual([
      'line1',
      'line2',
      'sub_district',
      'city',
      'province',
      'postal_code',
    ]);
    expect(BILLING_ADDRESS_LINES).toEqual([...REGISTERED_ADDRESS_LINES, 'country']);
  });

  it('isProposableFieldKey narrows strings', () => {
    expect(isProposableFieldKey('phone')).toBe(true);
    expect(isProposableFieldKey('tax_id')).toBe(false);
    expect(isProposableFieldKey('preferred_language')).toBe(false);
  });

  it('matches the field_key CHECK list in migration 0300 (parity with the DB)', () => {
    const sql = readFileSync(
      join(process.cwd(), 'drizzle', 'migrations', '0300_member_change_requests.sql'),
      'utf8',
    );
    const m = sql.match(/"field_key"\s+text\s+NOT NULL\s+CHECK\s*\(\s*"field_key"\s+IN\s*\(([^)]*)\)/i);
    expect(m, 'migration 0300 must declare the field_key CHECK').not.toBeNull();
    const dbKeys = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1]).sort();
    expect(dbKeys).toEqual([...PROPOSABLE_FIELD_KEYS].sort());
  });
});

describe('diffAgainstRecord — text normalisation (whole-branch review F-7)', () => {
  // The staff schemas accept `''` and untrimmed text for description /
  // role_title / address lines; the portal form sends `nullable(trim())`.
  // Without normalising BOTH sides a record holding `''` produced a spurious
  // "(empty) → (empty)" row on every submit from that member.
  it("a record holding '' or whitespace equals a proposal of null — no row", () => {
    const record: GroupBRecord = {
      ...RECORD,
      contact: { ...RECORD.contact, role_title: '   ' },
      company: { ...RECORD.company, description: '', registered_address: { ...RECORD.company.registered_address, line2: ' ' } },
    };
    const rows = diffAgainstRecord(
      record,
      { contact: { role_title: null }, company: { description: null, registered_address: { ...RECORD.company.registered_address, line2: null } } },
      TAX_CTX,
    );
    expect(rows).toEqual([]);
  });

  it('surrounding whitespace never makes a diff, and a stored proposed value is trimmed', () => {
    const record: GroupBRecord = { ...RECORD, contact: { ...RECORD.contact, role_title: 'CFO' } };
    expect(diffAgainstRecord(record, { contact: { role_title: ' CFO ' } }, TAX_CTX)).toEqual([]);
    const rows = diffAgainstRecord(record, { contact: { role_title: ' Chief Financial Officer ' } }, TAX_CTX);
    expect(rows.map((r) => [r.key, r.seen, r.proposed])).toEqual([['role_title', 'CFO', 'Chief Financial Officer']]);
  });

  it('a key present with an UNDEFINED value (a hand-built proposal object) is "not mentioned" — no row', () => {
    const record: GroupBRecord = { ...RECORD, contact: { ...RECORD.contact, role_title: 'CFO' } };
    // `exactOptionalPropertyTypes` forbids this shape statically — which is
    // exactly why the runtime guard exists: a caller outside the type system
    const handBuilt = { company: { website: undefined }, contact: { role_title: undefined } } as unknown as Parameters<typeof diffAgainstRecord>[1];
    expect(diffAgainstRecord(record, handBuilt, TAX_CTX)).toEqual([]);
  });

  it("a proposed '' is stored as null (the same rule as fillLines on the address lines)", () => {
    const rows = diffAgainstRecord({ ...RECORD, contact: { ...RECORD.contact, role_title: 'CFO' } }, { contact: { role_title: '' } }, TAX_CTX);
    expect(rows.map((r) => [r.key, r.seen, r.proposed])).toEqual([['role_title', 'CFO', null]]);
  });
});

describe('deriveOutcome (FR-016)', () => {
  it('all approved → approved', () => {
    expect(deriveOutcome(['approved', 'approved'])).toBe('approved');
  });
  it('none approved → rejected', () => {
    expect(deriveOutcome(['rejected'])).toBe('rejected');
  });
  it('mixed → partially_approved', () => {
    expect(deriveOutcome(['approved', 'rejected', 'approved'])).toBe('partially_approved');
  });
  it('an empty decision is a domain invariant violation', () => {
    expect(() => deriveOutcome([])).toThrow(/at least one field/);
  });
});

describe('deriveScope (FR-002 who-may-propose)', () => {
  it('own-contact keys only → own_contact, for a primary or a secondary', () => {
    expect(deriveScope(['phone', 'role_title'], true)).toEqual({ ok: true, value: 'own_contact' });
    expect(deriveScope(['first_name'], false)).toEqual({ ok: true, value: 'own_contact' });
  });
  it('company keys only from the primary → company', () => {
    expect(deriveScope(['company_name', 'billing_address'], true)).toEqual({
      ok: true,
      value: 'company',
    });
  });
  it('both kinds from the primary → mixed', () => {
    expect(deriveScope(['phone', 'website'], true)).toEqual({ ok: true, value: 'mixed' });
  });
  it('any company key from a non-primary is refused naming the offending keys', () => {
    expect(deriveScope(['phone', 'website', 'description'], false)).toEqual({
      ok: false,
      error: { code: 'company_fields_require_primary', keys: ['website', 'description'] },
    });
  });
  it('no keys → no_fields', () => {
    expect(deriveScope([], true)).toEqual({ ok: false, error: { code: 'no_fields' } });
  });
});

describe('affectsTaxDocuments (FR-019)', () => {
  it('company_name and billing_address always', () => {
    expect(affectsTaxDocuments('company_name', { memberHasBillingAddress: true, submitterIsPrimary: false })).toBe(true);
    expect(affectsTaxDocuments('billing_address', { memberHasBillingAddress: true, submitterIsPrimary: false })).toBe(true);
  });
  it('registered_address iff the member has no billing address', () => {
    expect(affectsTaxDocuments('registered_address', { memberHasBillingAddress: false, submitterIsPrimary: false })).toBe(true);
    expect(affectsTaxDocuments('registered_address', { memberHasBillingAddress: true, submitterIsPrimary: false })).toBe(false);
  });
  it('first/last name iff the submitter is the primary contact (buyer contact person)', () => {
    expect(affectsTaxDocuments('first_name', { memberHasBillingAddress: true, submitterIsPrimary: true })).toBe(true);
    expect(affectsTaxDocuments('last_name', { memberHasBillingAddress: true, submitterIsPrimary: true })).toBe(true);
    expect(affectsTaxDocuments('first_name', { memberHasBillingAddress: true, submitterIsPrimary: false })).toBe(false);
  });
  it('phone, role_title, website, description never', () => {
    for (const key of ['phone', 'role_title', 'website', 'description'] as const) {
      expect(affectsTaxDocuments(key, TAX_CTX)).toBe(false);
    }
  });
});

describe('diffAgainstRecord (FR-005 / FR-007)', () => {
  it('returns only fields whose proposed value differs, with target + tax flag, undecided', () => {
    const fields = diffAgainstRecord(
      RECORD,
      { contact: { phone: '+66899999999', first_name: 'Anna' }, company: { company_name: 'Nordic Co' } },
      TAX_CTX,
    );
    expect(fields).toEqual<ProposedField[]>([
      {
        key: 'phone',
        target: 'contact',
        seen: '+66812345678',
        proposed: '+66899999999',
        affectsTaxDocuments: false,
        outcome: null,
        appliedAt: null,
      },
    ]);
  });

  it('a field reverted to the current value before submit is not included; nothing → []', () => {
    expect(diffAgainstRecord(RECORD, { company: { website: 'https://nordic.example' } }, TAX_CTX)).toEqual([]);
    expect(diffAgainstRecord(RECORD, {}, TAX_CTX)).toEqual([]);
  });

  it('null proposes a CLEAR of a nullable field and differs from a set value', () => {
    const fields = diffAgainstRecord(RECORD, { company: { website: null } }, TAX_CTX);
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({ key: 'website', seen: 'https://nordic.example', proposed: null });
  });

  it('null against an already-null field is not a change', () => {
    expect(diffAgainstRecord(RECORD, { contact: { role_title: null } }, TAX_CTX)).toEqual([]);
  });

  it('an address group is ONE row carrying the whole object, proposed when any line differs', () => {
    const fields = diffAgainstRecord(
      RECORD,
      {
        company: {
          registered_address: {
            line1: '1 Main Rd',
            line2: 'Floor 2',
            sub_district: null,
            city: 'Bangkok',
            province: null,
            postal_code: '10110',
          },
        },
      },
      TAX_CTX,
    );
    expect(fields).toHaveLength(1);
    expect(fields[0]).toMatchObject({
      key: 'registered_address',
      target: 'member',
      seen: RECORD.company.registered_address,
      proposed: { line1: '1 Main Rd', line2: 'Floor 2', city: 'Bangkok', postal_code: '10110' },
      affectsTaxDocuments: true, // no billing address on record → registered is the buyer address
    });
  });

  it('an address group identical line-for-line is dropped', () => {
    expect(
      diffAgainstRecord(RECORD, { company: { registered_address: { ...RECORD.company.registered_address } } }, TAX_CTX),
    ).toEqual([]);
  });

  it('a billing address proposed by the primary is tax-affecting and keeps its country line', () => {
    const fields = diffAgainstRecord(
      RECORD,
      {
        company: {
          billing_address: {
            line1: 'Box 9',
            line2: null,
            sub_district: null,
            city: 'Stockholm',
            province: null,
            postal_code: '11122',
            country: 'SE',
          },
        },
      },
      { memberHasBillingAddress: false, submitterIsPrimary: true },
    );
    expect(fields[0]).toMatchObject({ key: 'billing_address', affectsTaxDocuments: true, proposed: { country: 'SE' } });
  });

  it('emits rows in PROPOSABLE_FIELD_KEYS order regardless of proposal key order', () => {
    const fields = diffAgainstRecord(
      RECORD,
      { company: { description: 'New', company_name: 'Renamed' }, contact: { last_name: 'Berg' } },
      TAX_CTX,
    );
    expect(fields.map((f) => f.key)).toEqual(['last_name', 'company_name', 'description']);
    expect(fields.map((f) => f.affectsTaxDocuments)).toEqual([true, true, false]);
  });
});

describe('changedSinceSubmitted / proposedValuesEqual (FR-019)', () => {
  const base: ProposedField = {
    key: 'registered_address',
    target: 'member',
    seen: RECORD.company.registered_address,
    proposed: { ...RECORD.company.registered_address, line2: 'Floor 2' },
    affectsTaxDocuments: true,
    outcome: null,
    appliedAt: null,
  };
  it('deep-equal address objects are unchanged', () => {
    expect(changedSinceSubmitted(base, { ...RECORD.company.registered_address })).toBe(false);
  });
  it('a live line that differs from what the member saw is flagged', () => {
    expect(changedSinceSubmitted(base, { ...RECORD.company.registered_address, city: 'Chiang Mai' })).toBe(true);
  });
  it('scalars compare by value; null vs empty string differ', () => {
    const phone: ProposedField = { ...base, key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false };
    expect(changedSinceSubmitted(phone, '+66812345678')).toBe(false);
    expect(changedSinceSubmitted(phone, '+66800000000')).toBe(true);
    expect(proposedValuesEqual(null, null)).toBe(true);
    expect(proposedValuesEqual(null, '')).toBe(false);
    expect(proposedValuesEqual('a', { line1: 'a' } as unknown as ProposedValue)).toBe(false);
  });
});

describe('state-machine narrowing + the seam check (round 6, types F6)', () => {
  const base: ChangeRequest = {
    id: 'r1' as ChangeRequest['id'],
    tenantId: 't' as ChangeRequest['tenantId'],
    memberId: 'm' as ChangeRequest['memberId'],
    submittedByUserId: 'u' as ChangeRequest['submittedByUserId'],
    submittedByContactId: 'c' as ChangeRequest['submittedByContactId'],
    submitterRoleAtSubmission: 'primary',
    scope: 'company',
    state: 'pending',
    outcome: null,
    withdrawnReason: null,
    replacedByRequestId: null,
    submittedAt: new Date('2026-09-11T08:00:00Z'),
    staffNotifiedAt: null,
    decidedAt: null,
    decidedByUserId: null,
    decisionReason: null,
    decisionNote: null,
    withdrawnAt: null,
    outcomeAcknowledgedAt: null,
    fields: [],
  };

  it('a consistent pending / decided / withdrawn row passes and narrows', () => {
    expect(changeRequestInvariantViolation(base)).toBeNull();
    const decided: ChangeRequest = { ...base, state: 'decided', outcome: 'approved', decidedAt: new Date(), decidedByUserId: 'rev' as ChangeRequest['decidedByUserId'] };
    expect(changeRequestInvariantViolation(decided)).toBeNull();
    expect(isDecided(decided)).toBe(true);
    const withdrawn: ChangeRequest = { ...base, state: 'withdrawn', withdrawnReason: 'member', withdrawnAt: new Date() };
    expect(changeRequestInvariantViolation(withdrawn)).toBeNull();
    expect(isWithdrawn(withdrawn)).toBe(true);
    expect(isDecided(withdrawn)).toBe(false);
  });

  it('a decided request whose field rows are not all decided, or whose appliedAt contradicts the field outcome, is named (round 7, types #2)', () => {
    const decided: ChangeRequest = { ...base, state: 'decided', outcome: 'approved', decidedAt: new Date(), decidedByUserId: 'rev' as ChangeRequest['decidedByUserId'] };
    const field = { key: 'phone' as const, target: 'contact' as const, seen: null, proposed: '+66899999999', affectsTaxDocuments: false };
    expect(changeRequestInvariantViolation({ ...decided, fields: [{ ...field, outcome: 'approved', appliedAt: new Date() }] })).toBeNull();
    expect(changeRequestInvariantViolation({ ...decided, fields: [{ ...field, outcome: null, appliedAt: null }] })).toMatch(/field phone has no outcome/);
    expect(changeRequestInvariantViolation({ ...decided, fields: [{ ...field, outcome: 'rejected', appliedAt: new Date() }] })).toMatch(/appliedAt/);
    expect(changeRequestInvariantViolation({ ...base, fields: [{ ...field, outcome: 'approved', appliedAt: null }] })).toMatch(/pending request .* field phone carries an outcome/);
  });

  it('a row that contradicts its state is named (the DB CHECKs make these unreachable; the seam still refuses them)', () => {
    expect(changeRequestInvariantViolation({ ...base, state: 'decided' })).toMatch(/lacks outcome/);
    expect(changeRequestInvariantViolation({ ...base, state: 'withdrawn' })).toMatch(/lacks withdrawnReason/);
    expect(changeRequestInvariantViolation({ ...base, outcome: 'approved' })).toMatch(/pending request .* carries/);
    expect(changeRequestInvariantViolation({ ...base, state: 'decided', outcome: 'rejected', decidedAt: new Date(), decidedByUserId: 'rev' as ChangeRequest['decidedByUserId'], withdrawnAt: new Date() })).toMatch(/carries withdrawal/);
  });
});
