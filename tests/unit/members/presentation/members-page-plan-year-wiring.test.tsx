/**
 * /admin/members — `?plan_id=&plan_year=` reaches BOTH directory reads.
 *
 * The plan detail page links here with the plan year so the list matches its
 * per-(plan, year) member count. The year must narrow the list/total AND the
 * needs-invite chip count, or the chip would count members the list hides.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const directorySearchWithCount = vi.fn();
const resolveMemberNumberPrefixMock = vi.fn();
const loadMembersMembershipStatusMock = vi.fn();
const countMembersNeedingPortalInviteMock = vi.fn();

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'test-tenant' }),
}));

vi.mock('@/modules/members', () => ({
  directorySearchWithCount: (...args: unknown[]) =>
    directorySearchWithCount(...args),
  formatMemberNumber: (prefix: string, n: number) =>
    `${prefix}-${String(n).padStart(4, '0')}`,
  resolveMemberNumberPrefix: (...args: unknown[]) =>
    resolveMemberNumberPrefixMock(...args),
  // page.tsx also imports loadMembersPortalStatus; none of these tests
  // exercise the badge read so it is left unmocked (undefined) — the
  // page's own try/catch degrades it to `null` (portal badges suppressed),
  // exactly like an unmocked countMembersNeedingPortalInvite call would.
  countMembersNeedingPortalInvite: (...args: unknown[]) =>
    countMembersNeedingPortalInviteMock(...args),
  MEMBER_STATUSES: ['active', 'inactive', 'archived'] as const,
}));

vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: {}, memberSettings: {} }),
}));

vi.mock('@/modules/renewals', () => ({
  loadMembersMembershipStatus: (...args: unknown[]) =>
    loadMembersMembershipStatusMock(...args),
  makeMembersMembershipStatusDeps: () => ({}),
}));

vi.mock('@/modules/plans', () => ({
  listPlans: vi.fn().mockResolvedValue({ ok: true, value: { data: [] } }),
}));

vi.mock('@/modules/plans/plans-deps', () => ({
  buildPlansDeps: () => ({
    tenant: { slug: 'test-tenant' },
    planRepo: {},
    taxPolicy: {},
    clock: {},
  }),
}));

vi.mock('@/modules/insights', () => ({
  projectEngagementScore: () => ({ score: null, band: null }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((k: string) => k),
}));

import { MembersDirectoryBody } from '@/app/(staff)/admin/members/page';

beforeEach(() => {
  vi.clearAllMocks();
  resolveMemberNumberPrefixMock.mockResolvedValue('SCCM');
  loadMembersMembershipStatusMock.mockResolvedValue({
    ok: true,
    value: { lapsed: new Set(), suspended: new Set() },
  });
  countMembersNeedingPortalInviteMock.mockResolvedValue({ ok: true, value: 0 });
  directorySearchWithCount.mockResolvedValue({
    ok: true,
    value: { total: 0, items: [] },
  });
});

describe('MembersDirectoryBody — plan_year filter wiring', () => {
  it('passes planId + planYear to the directory search and the needs-invite count', async () => {
    await MembersDirectoryBody({
      query: { plan_id: 'diamond', plan_year: '2026' },
      isAdmin: true,
    });
    expect(directorySearchWithCount.mock.calls[0]?.[1]).toMatchObject({
      planId: 'diamond',
      planYear: 2026,
    });
    expect(countMembersNeedingPortalInviteMock.mock.calls[0]?.[1]).toMatchObject({
      planId: 'diamond',
      planYear: 2026,
    });
  });

  it('passes no planYear when the param is absent', async () => {
    await MembersDirectoryBody({ query: { plan_id: 'diamond' }, isAdmin: true });
    expect(directorySearchWithCount.mock.calls[0]?.[1]).not.toHaveProperty('planYear');
  });
});
