/**
 * Task 18 (059-membership-suspension) — the member-detail inline benefits
 * preview (`MemberBenefitsPreviewSection`) wires the viewed member's derived
 * membership access into `BenefitUsageCard`'s `suspended` prop, same as the
 * dedicated benefits page (benefits-page-suspended-badge.test.tsx).
 *
 * Mirrors the sibling `timeline-preview-section.test.tsx` harness (direct RSC
 * invocation, infra mocked) but renders via Testing Library + a real
 * `NextIntlClientProvider` (not `renderToStaticMarkup`) because the child
 * `BenefitUsageCard` is a client component that calls `useTranslations` —
 * it needs a live next-intl context, not just a mocked `next-intl/server`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { asTenantContext } from '@/modules/tenants';

vi.mock('next-intl/server', () => ({
  getLocale: vi.fn().mockResolvedValue('en'),
}));

const computeBenefitUsage = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: {
      membershipYear: 2026,
      elapsedYearPct: 50,
      quantifiable: [{ key: 'eblast', used: 3, entitlement: 10, lastUsedAt: null }],
      active: [],
      aggregateConsumedPct: 30,
      underUseWarning: false,
    },
  }),
);
vi.mock('@/modules/insights', () => ({
  computeBenefitUsage,
  makeComputeBenefitUsageDeps: () => ({}),
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));

// THE system-under-test dependency: the raw access tri-state.
const loadMembershipAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess }));

import { MemberBenefitsPreviewSection } from '@/app/(staff)/admin/members/[memberId]/_components/member-benefits-preview-section';

const TENANT = asTenantContext('t1');
const MEMBER_ID = 'm1';

async function renderSection() {
  const ui = await MemberBenefitsPreviewSection({ tenant: TENANT, memberId: MEMBER_ID });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('<MemberBenefitsPreviewSection> — suspended badge wiring (059-membership-suspension Task 18)', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls loadMembershipAccess with the tenant slug + memberId and renders the Suspended badge when suspended', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await renderSection();
    expect(loadMembershipAccess).toHaveBeenCalledWith('t1', 'm1');
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(
      screen.getByText('Membership suspended — benefits paused'),
    ).toBeInTheDocument();
  });

  it('does NOT render the Suspended badge when access is full', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    await renderSection();
    expect(screen.queryByText('Suspended')).toBeNull();
  });

  it('renders nothing (section omitted) when the benefit-usage read fails, regardless of access', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    computeBenefitUsage.mockResolvedValueOnce({
      ok: false,
      error: { code: 'server_error' },
    });
    const { container } = await renderSection();
    expect(container).toBeEmptyDOMElement();
  });
});
