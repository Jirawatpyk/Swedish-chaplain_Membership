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

  it('rule 8: TH company with no tax_id → required_for_company error, member excluded', () => {
    const r = validateRows([row({ rowIndex: 2, country: 'TH', taxId: '' })], RESOLVER);
    expect(errCodes(r)).toContain('required_for_company');
    expect(r.members).toHaveLength(0);
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
});
