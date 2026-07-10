/**
 * Stage-3 importer — validateRows unit tests (spec § 3 rules 1-8, § 8 TDD).
 * Pure (no DB). Uses SE for the valid-tax path (non-TH = 1..50 chars, no checksum)
 * and TH to exercise the tax-id-required + format rules.
 */
import { describe, expect, it } from 'vitest';

const { validateRows } = await import('@/../scripts/import-members/validate');
const { buildTierResolver } = await import('@/../scripts/import-members/tier-resolution');

const RESOLVER = buildTierResolver([
  { planId: 'premium', nameEn: 'Premium Corporate', memberTypeScope: 'company' },
  { planId: 'thai-alumni', nameEn: 'Thai Alumni/Student', memberTypeScope: 'individual' },
]);

type RawRow = Parameters<typeof validateRows>[0][number];

function row(over: Partial<RawRow> & { rowIndex: number }): RawRow {
  return {
    rowIndex: over.rowIndex,
    companyName: over.companyName ?? 'Acme Co',
    country: over.country ?? 'SE',
    taxId: over.taxId ?? 'SE5566778899',
    tier: over.tier ?? 'Premium',
    turnover: over.turnover ?? '',
    registrationDate: over.registrationDate ?? '2026-01-15',
    memberLocale: over.memberLocale ?? '',
    city: over.city ?? '',
    province: over.province ?? '',
    postalCode: over.postalCode ?? '',
    contactFirstName: over.contactFirstName ?? 'Jane',
    contactLastName: over.contactLastName ?? 'Doe',
    contactEmail: over.contactEmail ?? 'jane@acme.test',
    contactPhone: over.contactPhone ?? '',
    contactRole: over.contactRole ?? '',
    contactLanguage: over.contactLanguage ?? '',
    isPrimary: over.isPrimary ?? 'yes',
  };
}
const errCodes = (r: ReturnType<typeof validateRows>) =>
  r.issues.filter((i) => i.severity === 'error').map((i) => i.code);

describe('validateRows (spec § 3)', () => {
  it('happy path: one valid SE company + primary contact → 1 member, 0 errors', () => {
    const r = validateRows([row({ rowIndex: 2 })], RESOLVER);
    expect(r.stats.errorCount).toBe(0);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.planId).toBe('premium');
    expect(r.members[0]!.contacts[0]!.isPrimary).toBe(true);
    expect(r.tierHistogram['premium']).toBe(1);
  });

  it('groups multiple rows of one company into one member with N contacts', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, contactEmail: 'a@acme.test', isPrimary: 'yes' }),
        row({ rowIndex: 3, contactEmail: 'b@acme.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(r.stats.errorCount).toBe(0);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.contacts).toHaveLength(2);
  });

  it('rule 8 (relaxed 2026-07-10): TH company with no tax_id → missing_for_company WARNING, member still imports', () => {
    const r = validateRows([row({ rowIndex: 2, country: 'TH', taxId: '' })], RESOLVER);
    expect(r.stats.errorCount).toBe(0);
    expect(
      r.issues.some(
        (i) => i.field === 'taxId' && i.code === 'missing_for_company' && i.severity === 'warning',
      ),
    ).toBe(true);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.taxId).toBeNull();
  });

  it('rule 8: TH company with malformed tax_id → th_wrong_format error', () => {
    const r = validateRows([row({ rowIndex: 2, country: 'TH', taxId: '123' })], RESOLVER);
    expect(errCodes(r)).toContain('taxId.th_wrong_format');
  });

  it('rule 8: individual-scope (Thai Alumni) without tax_id is VALID', () => {
    const r = validateRows(
      [row({ rowIndex: 2, country: 'TH', tier: 'Thai Alumni', taxId: '' })],
      RESOLVER,
    );
    expect(r.stats.errorCount).toBe(0);
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.taxId).toBeNull();
  });

  it('rule 2: invalid email → error, member excluded', () => {
    const r = validateRows([row({ rowIndex: 2, contactEmail: 'not-an-email' })], RESOLVER);
    expect(errCodes(r)).toContain('email.invalid_format');
    expect(r.members).toHaveLength(0);
  });

  it('rule 2: same email across two companies → duplicate_in_import on both', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, companyName: 'A Co', contactEmail: 'dup@x.test' }),
        row({ rowIndex: 3, companyName: 'B Co', contactEmail: 'dup@x.test' }),
      ],
      RESOLVER,
    );
    expect(errCodes(r).filter((c) => c === 'duplicate_in_import')).toHaveLength(2);
  });

  it('rule 2 (code-review #2): same email twice in ONE company → warn + dedupe, member still imports', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Acme Co', contactEmail: 'dup@acme.test', isPrimary: 'yes' }),
        row({ rowIndex: 3, companyName: 'Acme Co', contactEmail: 'dup@acme.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    // Intra-member duplicate is NOT a cross-member collision.
    expect(errCodes(r)).not.toContain('duplicate_in_import');
    expect(r.issues.some((i) => i.code === 'duplicate_contact_in_member' && i.severity === 'warning')).toBe(true);
    // The legitimate single-company member still imports, with the dup deduped.
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.contacts).toHaveLength(1);
  });

  it('rule 6 (code-review #4): mononym (last name blank, first name present) → warn, member still imports', () => {
    const r = validateRows([row({ rowIndex: 2, contactLastName: '' })], RESOLVER);
    expect(r.stats.errorCount).toBe(0);
    expect(r.members).toHaveLength(1);
    expect(r.issues.some((i) => i.field === 'contactName' && i.code === 'mononym_single_name')).toBe(true);
    expect(r.members[0]!.contacts[0]!.lastName).toBe('');
  });

  it('rule 6 (code-review #4): fully-nameless contact → contactName required error, member excluded', () => {
    const r = validateRows(
      [row({ rowIndex: 2, contactFirstName: '', contactLastName: '' })],
      RESOLVER,
    );
    expect(r.issues.some((i) => i.field === 'contactName' && i.code === 'required' && i.severity === 'error')).toBe(true);
    expect(r.members).toHaveLength(0);
  });

  it('code-review #5: differing tax IDs under one display name → distinct_company_merged error, not silently merged', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Nordic Trading', taxId: 'SE1111111111', contactEmail: 'a@nordic.test' }),
        row({ rowIndex: 3, companyName: 'Nordic Trading', taxId: 'SE2222222222', contactEmail: 'b@nordic.test' }),
      ],
      RESOLVER,
    );
    expect(r.issues.some((i) => i.field === 'taxId' && i.code === 'distinct_company_merged' && i.severity === 'error')).toBe(true);
    // The ambiguous merge is refused — operator must disambiguate.
    expect(r.members).toHaveLength(0);
  });

  it('rule 5: Buddhist-Era registration date → date.be_leak error', () => {
    const r = validateRows([row({ rowIndex: 2, registrationDate: '2569-01-15' })], RESOLVER);
    expect(errCodes(r)).toContain('date.be_leak');
  });

  it('rule 4: unmapped tier → unmapped error', () => {
    const r = validateRows([row({ rowIndex: 2, tier: 'Bronze' })], RESOLVER);
    expect(errCodes(r)).toContain('unmapped');
    expect(r.members).toHaveLength(0);
  });

  it('rule 3: unresolved country → unresolved error', () => {
    const r = validateRows([row({ rowIndex: 2, country: 'Narnia' })], RESOLVER);
    expect(errCodes(r)).toContain('unresolved');
  });

  it('rule 7: no primary marked → warning + first contact defaulted to primary', () => {
    const r = validateRows([row({ rowIndex: 2, isPrimary: '' })], RESOLVER);
    expect(r.stats.errorCount).toBe(0);
    expect(r.issues.some((i) => i.code === 'none_marked_defaulting_first')).toBe(true);
    expect(r.members[0]!.contacts[0]!.isPrimary).toBe(true);
  });

  it('rule 6: an invalid phone is DROPPED with a warning — member NOT excluded', () => {
    const r = validateRows([row({ rowIndex: 2, contactPhone: '0812345678' })], RESOLVER); // Thai local, no +66
    expect(r.stats.errorCount).toBe(0); // not an error
    expect(r.members).toHaveLength(1); // member survives
    expect(r.members[0]!.contacts[0]!.phone).toBeNull(); // malformed phone dropped
    expect(r.issues.some((i) => i.field === 'contactPhone' && i.code === 'dropped_invalid_e164' && i.severity === 'warning')).toBe(true);
  });

  it('rule 2: a blank-company stray row does NOT false-flag a real member as duplicate', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Real Co', contactEmail: 'shared@x.test' }),
        row({ rowIndex: 3, companyName: '', contactEmail: 'shared@x.test' }), // stray blank-company row
      ],
      RESOLVER,
    );
    expect(r.members).toHaveLength(1); // Real Co is valid
    expect(errCodes(r)).not.toContain('duplicate_in_import');
    expect(errCodes(r)).toContain('required'); // the blank-company row still errors
  });

  it('member_field_mismatch warns on RESOLVED diffs, not equivalent spellings (items 3/9)', () => {
    // Same company, equivalent country spelling ('TH' vs 'Thailand') → NO false warning.
    const equiv = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Eq Co', tier: 'Thai Alumni', taxId: '', country: 'TH', contactEmail: 'a@eq.test' }),
        row({ rowIndex: 3, companyName: 'Eq Co', tier: 'Thai Alumni', taxId: '', country: 'Thailand', contactEmail: 'b@eq.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(equiv.issues.some((i) => i.code === 'member_field_mismatch')).toBe(false);

    // Same company name but genuinely different resolved country → warn (merge signal).
    const diff = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Mix Co', tier: 'Thai Alumni', taxId: '', country: 'SE', contactEmail: 'a@mix.test' }),
        row({ rowIndex: 3, companyName: 'Mix Co', tier: 'Thai Alumni', taxId: '', country: 'TH', contactEmail: 'b@mix.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(diff.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'country')).toBe(true);

    // Different resolved TIER on a sibling → warn (positive tier-branch coverage).
    const tierDiff = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Tier Co', tier: 'Premium', country: 'SE', contactEmail: 'a@tier.test' }),
        row({ rowIndex: 3, companyName: 'Tier Co', tier: 'Thai Alumni', taxId: '', country: 'SE', contactEmail: 'b@tier.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(tierDiff.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'tier')).toBe(true);

    // R3 bug 2: a sibling with an UNRESOLVABLE-but-different value still warns (was silently dropped).
    const unresolvable = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Garbage Co', tier: 'Thai Alumni', taxId: '', country: 'SE', contactEmail: 'a@g.test' }),
        row({ rowIndex: 3, companyName: 'Garbage Co', tier: 'Thai Alumni', taxId: '', country: 'Narnia', contactEmail: 'b@g.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(unresolvable.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'country')).toBe(true);

    // R4 #4: symmetric TIER under-warn — head resolves, sibling tier is unresolvable-but-different
    // ('Bronze'). Must warn on the sibling tier (the country branch above is not enough).
    const tierUnresolvable = validateRows(
      [
        row({ rowIndex: 2, companyName: 'Garb Tier', tier: 'Premium', country: 'SE', contactEmail: 'a@gt.test' }),
        row({ rowIndex: 3, companyName: 'Garb Tier', tier: 'Bronze', country: 'SE', contactEmail: 'b@gt.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(tierUnresolvable.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'tier')).toBe(true);
  });

  it('R4 #3/#8/#9/#11: when the HEAD value is unresolvable the member is excluded — siblings get NO spurious mismatch warning', () => {
    // Head tier 'Bronze' (unmapped → member excluded). A sibling that RESOLVES ('Premium')
    // must NOT be accused of being a wrongly-merged company — the only real issue is the head.
    const headBadTier = validateRows(
      [
        row({ rowIndex: 2, companyName: 'BadHead Co', tier: 'Bronze', country: 'SE', contactEmail: 'a@bh.test' }),
        row({ rowIndex: 3, companyName: 'BadHead Co', tier: 'Premium', country: 'SE', contactEmail: 'b@bh.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(errCodes(headBadTier)).toContain('unmapped'); // the real, actionable error
    expect(headBadTier.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'tier')).toBe(false);
    expect(headBadTier.members).toHaveLength(0);

    // Head country blank/unresolvable → a resolvable sibling country must NOT warn either.
    const headBadCountry = validateRows(
      [
        row({ rowIndex: 2, companyName: 'BadCty Co', tier: 'Premium', country: 'Narnia', contactEmail: 'a@bc.test' }),
        row({ rowIndex: 3, companyName: 'BadCty Co', tier: 'Premium', country: 'Sweden', contactEmail: 'b@bc.test', isPrimary: '' }),
      ],
      RESOLVER,
    );
    expect(headBadCountry.issues.some((i) => i.code === 'member_field_mismatch' && i.field === 'country')).toBe(false);
  });

  it('rule 7: multiple primaries → multiple_primary error', () => {
    const r = validateRows(
      [
        row({ rowIndex: 2, contactEmail: 'a@acme.test', isPrimary: 'yes' }),
        row({ rowIndex: 3, contactEmail: 'b@acme.test', isPrimary: 'yes' }),
      ],
      RESOLVER,
    );
    expect(errCodes(r)).toContain('multiple_primary');
  });

  it('turnover: a FRACTIONAL value degrades to a warning (member still imports), an integer passes (code-review fix)', () => {
    // turnover_thb is a bigint (whole baht); a fractional cell flowing into --commit would
    // crash the INSERT and roll back the WHOLE import. parseTurnover must reject non-integers
    // as a clean per-row not_a_number warning (turnover → null) instead of an opaque DB abort.
    const frac = validateRows([row({ rowIndex: 2, turnover: '5000000.50' })], RESOLVER);
    expect(frac.stats.errorCount).toBe(0); // not an error — member survives
    expect(frac.members).toHaveLength(1);
    expect(frac.members[0]!.turnoverThb).toBeNull();
    expect(
      frac.issues.some(
        (i) => i.field === 'turnover' && i.code === 'not_a_number' && i.severity === 'warning',
      ),
    ).toBe(true);
    // a whole-baht integer passes through unchanged.
    const whole = validateRows([row({ rowIndex: 2, turnover: '5000000' })], RESOLVER);
    expect(whole.members[0]!.turnoverThb).toBe(5000000);

    // R2 review: a NEGATIVE integer (would violate the members_turnover_non_negative
    // CHECK) and an OVER-RANGE value (> MAX_SAFE_INTEGER → bigint overflow) must ALSO
    // degrade to the warning, not crash --commit.
    for (const bad of ['-5000000', '99999999999999999999']) {
      const r = validateRows([row({ rowIndex: 2, turnover: bad })], RESOLVER);
      expect(r.stats.errorCount).toBe(0);
      expect(r.members).toHaveLength(1);
      expect(r.members[0]!.turnoverThb).toBeNull();
      expect(
        r.issues.some(
          (i) => i.field === 'turnover' && i.code === 'not_a_number' && i.severity === 'warning',
        ),
      ).toBe(true);
    }
  });
});
