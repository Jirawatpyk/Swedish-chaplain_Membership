/**
 * #82 — the new-invoice member options: the label, and a deep-linked member
 * outside the 100-row preload added once.
 */
import { describe, expect, it } from 'vitest';
import {
  MEMBER_PRELOAD_LIMIT,
  toMemberOption,
  withDeepLinkedMember,
} from '@/app/(staff)/admin/invoices/new/_lib/member-options';

const plans = new Map([['regular', 'Regular Corporate']]);
const a = toMemberOption({ memberId: 'm-1', companyName: 'Alpha Co', planId: 'regular', planYear: 2026 }, plans, 'en');
const b = toMemberOption({ memberId: 'm-2', companyName: 'Beta Co', planId: 'start_up', planYear: 2026 }, plans, 'en');

describe('new-invoice member options (#82)', () => {
  it('preloads the directory read ceiling, not more than it returns', () => {
    expect(MEMBER_PRELOAD_LIMIT).toBe(100);
  });

  it('labels a member with its plan name and year, or the plan id when unknown', () => {
    expect(a.label).toBe('Alpha Co (Regular Corporate / 2026)');
    expect(b.label).toBe('Beta Co (start_up / 2026)');
    expect(a).toMatchObject({ currentPlanId: 'regular', currentPlanYear: 2026 });
  });

  it('adds a deep-linked member outside the preload once, at the end', () => {
    const list = [a];
    expect(withDeepLinkedMember(list, b)).toEqual([a, b]);
    expect(withDeepLinkedMember(list, a)).toBe(list);
    expect(withDeepLinkedMember(list, null)).toBe(list);
  });
});
