/**
 * Unit — 124 slice 1: the admin invoice list's `?plan=<plan_id>` resolves
 * against the tenant's plans. A known id gives the filter and its chip label
 * (in the viewer's locale, English as fallback). A well-formed id the lookup
 * does not know (another plan year, a failed lookup) still
 * filters, its chip named by the id, so the list never widens unmarked.
 */
import { describe, it, expect } from 'vitest';
import { resolvePlanFilter } from '@/app/(staff)/admin/invoices/_lib/plan-filter';

const plans = [
  { plan_id: 'corporate-gold', plan_name: { en: 'Corporate Gold', th: 'คอร์ปอเรตโกลด์' } },
  { plan_id: 'individual', plan_name: { en: 'Individual' } },
];

describe('resolvePlanFilter', () => {
  it('a known plan id → the id and its name in the locale', () => {
    expect(resolvePlanFilter('corporate-gold', plans, 'th')).toEqual({
      id: 'corporate-gold',
      label: 'คอร์ปอเรตโกลด์',
    });
  });

  it('falls back to the English name, then to the id', () => {
    expect(resolvePlanFilter('individual', plans, 'sv')).toEqual({
      id: 'individual',
      label: 'Individual',
    });
    expect(
      resolvePlanFilter('bare', [{ plan_id: 'bare', plan_name: {} }], 'en'),
    ).toEqual({ id: 'bare', label: 'bare' });
  });

  it("an id this year's plans do not know still filters, named by the id", () => {
    expect(resolvePlanFilter('gold-2025', plans, 'en')).toEqual({ id: 'gold-2025', label: 'gold-2025' });
  });

  it('an empty, absent or over-long value is ignored', () => {
    expect(resolvePlanFilter('', plans, 'en')).toBeUndefined();
    expect(resolvePlanFilter(undefined, plans, 'en')).toBeUndefined();
    expect(resolvePlanFilter('x'.repeat(65), plans, 'en')).toBeUndefined();
  });

  it('when the plan lookup failed, still filters by a plausible id and names it by the id', () => {
    expect(resolvePlanFilter('corporate-gold', undefined, 'en')).toEqual({
      id: 'corporate-gold',
      label: 'corporate-gold',
    });
    expect(resolvePlanFilter('x'.repeat(65), undefined, 'en')).toBeUndefined();
    expect(resolvePlanFilter('', undefined, 'en')).toBeUndefined();
  });
});

