import { describe, expect, it } from 'vitest';
import { lookupPostalCode } from '@/lib/thai-postal/lookup';

describe('lookupPostalCode', () => {
  it('returns every sub-district for a multi-district code (10110)', () => {
    const candidates = lookupPostalCode('10110');

    expect(candidates).toHaveLength(9);
    const districts = new Set(candidates.map((c) => c.district.th));
    expect(districts).toEqual(new Set(['เขตคลองเตย', 'เขตวัฒนา']));
    expect(new Set(candidates.map((c) => c.province.th))).toEqual(
      new Set(['กรุงเทพมหานคร']),
    );
    expect(candidates.some((c) => c.subDistrict.th === 'คลองตันเหนือ')).toBe(true);
    expect(candidates.some((c) => c.subDistrict.en === 'Khlong Tan Nuea')).toBe(true);
  });

  it('returns candidates spanning TWO provinces for 13240', () => {
    const provinces = new Set(
      lookupPostalCode('13240').map((c) => c.province.en),
    );

    expect(provinces).toEqual(
      new Set(['Phra Nakhon Si Ayutthaya', 'Lopburi']),
    );
  });

  it('returns an empty array for an unknown code', () => {
    expect(lookupPostalCode('99999')).toEqual([]);
  });

  it('returns an empty array for a malformed code rather than throwing', () => {
    expect(lookupPostalCode('abc')).toEqual([]);
    expect(lookupPostalCode('101')).toEqual([]);
    expect(lookupPostalCode('')).toEqual([]);
  });
});
