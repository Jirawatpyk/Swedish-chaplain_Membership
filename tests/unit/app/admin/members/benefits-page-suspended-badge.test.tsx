/**
 * Task 18 (059-membership-suspension) — admin dedicated benefits page
 * (`/admin/members/[memberId]/benefits`) wires the viewed member's derived
 * membership access into `BenefitUsageCard`'s `suspended` prop.
 *
 * `BenefitUsageCard` gained the `suspended` prop + amber "Suspended" badge in
 * this same task (see benefit-usage-card.test.tsx), but nothing on this admin
 * surface computed the access or passed the prop — so the badge never
 * actually showed here. This test drives the real page body with
 * `loadMembershipAccess` mocked per-scenario (mirrors the member-portal
 * precedent, tests/unit/app/portal/benefits-suspended-banner.test.tsx) and
 * asserts the badge renders exactly when access resolves to `suspended`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async () => {
    const t = (key: string, params?: Record<string, unknown>): string => {
      // Minimal real-namespace passthrough is unnecessary here — the page's
      // OWN t() calls only feed plain layout copy (title/back link/reminder
      // action); the thing under test is the CHILD BenefitUsageCard, which
      // gets its own live `useTranslations('benefits')` via
      // NextIntlClientProvider below. Returning a readable stub keeps the
      // page body's own copy inert without masking a real i18n gap in the
      // child component (which uses full enMessages).
      if (!params) return key;
      return `${key}:${JSON.stringify(params)}`;
    };
    return t;
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));

vi.mock('next/headers', () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'staff-1', email: 'staff@example.com', role: 'admin' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/request-id', () => ({
  requestIdFromHeaders: () => 'req-1',
}));

const getMember = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    ok: true,
    value: {
      member: { memberId: 'm1', companyName: 'Acme Co' },
      contacts: [],
    },
  }),
);
vi.mock('@/modules/members', () => ({ getMember }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({}),
}));

const recordStaffBenefitView = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
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
  recordStaffBenefitView,
}));

// THE system-under-test dependency: the raw access tri-state.
const loadMembershipAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess }));

import MemberBenefitsPage from '@/app/(staff)/admin/members/[memberId]/benefits/page';

const MEMBER_ID = 'aaaaaaaa-1111-2222-3333-444444444444';

async function renderPage() {
  const ui = await MemberBenefitsPage({
    params: Promise.resolve({ memberId: MEMBER_ID }),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('Admin MemberBenefitsPage — suspended badge wiring (059-membership-suspension Task 18)', () => {
  afterEach(() => vi.clearAllMocks());

  it('calls loadMembershipAccess with the resolved tenant + member and renders the Suspended badge when access is suspended', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await renderPage();
    expect(loadMembershipAccess).toHaveBeenCalledWith('t1', 'm1');
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(
      screen.getByText('Membership suspended — benefits paused'),
    ).toBeInTheDocument();
  });

  it('does NOT render the Suspended badge when access is full', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    await renderPage();
    expect(screen.queryByText('Suspended')).toBeNull();
  });

  it('does NOT render the Suspended badge when access is terminated (distinct state, no badge here)', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'terminated', reason: 'lapsed' });
    await renderPage();
    expect(screen.queryByText('Suspended')).toBeNull();
  });
});
