/**
 * Unit — 124 slice 1: the admin invoice list's `?plan=<plan_id>` resolves
 * against the tenant's plans. A known id gives the filter and its chip label
 * (in the viewer's locale, English as fallback); anything else is ignored,
 * like every other list param (no 500, no restriction).
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

  it('an unknown, empty or absent value is ignored', () => {
    expect(resolvePlanFilter('no-such-plan', plans, 'en')).toBeUndefined();
    expect(resolvePlanFilter('', plans, 'en')).toBeUndefined();
    expect(resolvePlanFilter(undefined, plans, 'en')).toBeUndefined();
  });
});
