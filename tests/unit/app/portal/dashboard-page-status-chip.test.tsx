/**
 * Spec 122 US3 — the dashboard header's status chip names the member RECORD's
 * status (active / inactive / archived), not whether the membership is paid
 * up: a lapsed member's record is still `active`. So the chip stays neutral
 * and never takes the green "ready" tone, which read as "your membership is
 * fine" above the "Membership lapsed" card (found on the dev branch,
 * 2026-09-27). The lapse itself is the Membership stat card's job.
 */
import { describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { StatusPill } from '@jirawatpyk/aura-react/server';

vi.mock('@/lib/db', () => ({ db: {}, runInTenant: vi.fn() }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => (key: string) => key),
}));
vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({ user: { id: 'u1', email: 'anna@example.com', displayName: 'Anna' } }),
}));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/modules/members', () => ({
  formatMemberNumber: () => 'TSCC-0042',
  resolveMemberNumberPrefix: vi.fn().mockResolvedValue('TSCC'),
}));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({
    memberRepo: {
      findByLinkedUserId: vi.fn().mockResolvedValue({
        ok: true,
        value: { memberId: 'm1', status: 'active', planId: 'gold', planYear: 2026, memberNumber: '0042' },
      }),
    },
    memberSettings: {},
    plans: { getPlan: vi.fn().mockResolvedValue({ ok: true, value: { planNameEn: 'Gold Corporate' } }) },
  }),
}));
// The streamed sections read the DB; the header is all this test looks at.
vi.mock('@/components/portal/invoices-summary-card', () => ({ InvoicesSummaryCard: () => null }));
vi.mock('@/app/(member)/portal/_components/membership-stat-section', () => ({ StatSkeleton: () => null, MembershipStatSection: () => null }));
vi.mock('@/app/(member)/portal/_components/outstanding-stat-section', () => ({ OutstandingStatSection: () => null }));
vi.mock('@/app/(member)/portal/_components/benefits-stat-section', () => ({ BenefitsStatSection: () => null }));
vi.mock('@/app/(member)/portal/_components/benefits-panel-section', () => ({ BenefitsPanelSection: () => null }));
vi.mock('@/app/(member)/portal/_components/recent-activity-section', () => ({ RecentActivitySection: () => null, RecentActivitySkeleton: () => null }));

import MemberPortalHomePage from '@/app/(member)/portal/(home)/page';

function findAll(node: ReactNode, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, type, out));
  else if (isValidElement(node)) {
    if (node.type === type) out.push(node);
    const props = node.props as Record<string, unknown>;
    for (const value of Object.values(props)) if (value && typeof value === 'object') findAll(value as ReactNode, type, out);
  }
  return out;
}

describe('MemberPortalHomePage — the header status chip', () => {
  it('shows an active record in a neutral chip, not the green ready tone', async () => {
    const tree = await MemberPortalHomePage();
    const pills = findAll(tree, StatusPill);
    expect(pills).toHaveLength(1);
    expect((pills[0]!.props as { tone?: string }).tone).toBe('neutral');
  });
});
