/**
 * Stage-3 importer — entity-type coercer (Task 7). Maps TSCC's `Member Type`
 * column → LegalEntityTypeCode; fail-loud on an unmapped value.
 */
import { describe, expect, it } from 'vitest';

const { coerceLegalEntityType } = await import('@/../scripts/import-members/entity-type');

describe('coerceLegalEntityType', () => {
  it('does NOT confuse the Member Type "Individual" with the Plan "Individual"', () => {
    // `Individual` appears in TWO columns of TSCC's sheet with unrelated meanings:
    // Member Type = บุคคลธรรมดา (legal form) and Plan = the Individual package.
    // This coercer must only ever see the Member Type column.
    const r = coerceLegalEntityType('Individual');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('individual');
  });

  it('maps every value present in the TSCC sheet', () => {
    const cases: ReadonlyArray<[string, string | null]> = [
      ['Private Limited Company (Company Limited)', 'limited_company'],
      ['State Enterprise', 'state_enterprise'],
      ['Public Limited Company', 'public_company'],
      ['Foundation', 'foundation'],
      ['N/A', null],
      ['', null],
    ];
    for (const [raw, expected] of cases) {
      const r = coerceLegalEntityType(raw);
      expect(r.ok, `"${raw}" should resolve`).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    }
  });

  it('FAILS LOUD on an unmapped value', () => {
    // A silent NULL is exactly how the §86/4 branch line came to be missing from
    // every invoice. An unknown Member Type stops the row.
    const r = coerceLegalEntityType('Sole Proprietorship Ltd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('entityType.unmapped');
  });
});
