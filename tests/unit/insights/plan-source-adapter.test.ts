/**
 * F9 US4 (review-run R3-3) — planSourceAdapter.getEntitlements active-benefit
 * derivation. Pins the partnership-tier branches (`tailor_made_services`,
 * `partnership !== null → partnership_package`) that the integration suite
 * never exercises (it uses DEFAULT_TEST_BENEFIT_MATRIX with both false/null) —
 * a partnership member's AS-3 active badges would otherwise regress green. The
 * F2 plan repo is mocked so we drive exact matrix shapes.
 */
import { describe, it, expect, vi } from 'vitest';
import type { TenantContext } from '@/modules/tenants';

const findOneMock = vi.fn();

vi.mock('@/modules/plans', () => ({
  asPlanSlug: (s: string) => s,
  asPlanYear: (n: number) => n,
}));
vi.mock('@/modules/plans/infrastructure/db/plan-repo', () => ({
  planRepo: { findOne: (...a: unknown[]) => findOneMock(...a) },
}));

import { planSourceAdapter } from '@/modules/insights/infrastructure/sources/plan-source-adapter';

const CTX = { slug: 'test-tenant' } as unknown as TenantContext;

function planWith(matrix: Record<string, unknown>) {
  return { benefit_matrix: matrix };
}

describe('planSourceAdapter.getEntitlements — active-benefit derivation', () => {
  it('partnership tier surfaces tailor_made_services + partnership_package (R3-3)', async () => {
    findOneMock.mockResolvedValueOnce(
      planWith({
        eblast_per_year: 6,
        cultural_tickets_per_year: 4,
        event_discount_scope: 'all_employees',
        directory_listing_size: 'full_page',
        m2m_benefits_access: true,
        business_referrals: true,
        tailor_made_services: true,
        partnership: { event_tickets_included: 6 },
      }),
    );
    const r = await planSourceAdapter.getEntitlements(CTX, 'partnership', 2026);
    expect(r).not.toBeNull();
    expect(r!.eblastPerYear).toBe(6);
    expect(r!.culturalTicketsPerYear).toBe(4);
    expect(r!.activeBenefits).toEqual(
      expect.arrayContaining([
        'all_employee_event_discount',
        'directory_listing',
        'm2m_benefits',
        'business_referrals',
        'tailor_made_services',
        'partnership_package',
      ]),
    );
  });

  it('corporate tier (partnership null, tailor false) omits those keys', async () => {
    findOneMock.mockResolvedValueOnce(
      planWith({
        eblast_per_year: 1,
        cultural_tickets_per_year: 0,
        event_discount_scope: 'one_ticket_per_event',
        directory_listing_size: null,
        m2m_benefits_access: false,
        business_referrals: false,
        tailor_made_services: false,
        partnership: null,
      }),
    );
    const r = await planSourceAdapter.getEntitlements(CTX, 'regular', 2026);
    expect(r!.activeBenefits).toEqual([]);
  });

  it('missing plan → null (empty benefit view)', async () => {
    findOneMock.mockResolvedValueOnce(undefined);
    expect(await planSourceAdapter.getEntitlements(CTX, 'ghost', 2026)).toBeNull();
  });
});
