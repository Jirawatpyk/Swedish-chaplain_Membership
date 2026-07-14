/**
 * 059-membership-suspension Task 9 item 6 — Benefits page "paused" banner.
 *
 * The Benefits page stays OPEN while a member is `suspended` (design doc §
 * User-facing surfaces): quotas render unchanged, and a banner names every
 * paused benefit (including the ones the platform can't technically gate —
 * event tickets, banner, website logo). This test drives the real page body
 * with `loadMembershipAccess` mocked per-scenario and asserts the banner's
 * presence/absence + that the quota card itself is untouched either way.
 *
 * Harness mirrors `benefits-f7-gate.test.tsx` (real-en.json translator, all
 * server-only infra stubbed).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(enMessages as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/portal/benefits',
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', email: 'jane@example.com', role: 'member' },
  }),
}));
vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 't1' }),
}));
vi.mock('@/lib/env', () => ({
  env: { features: { f7Broadcasts: true, f9Dashboard: true } },
}));
vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/log-id', () => ({ errKind: () => 'err' }));
vi.mock('@/lib/metrics', () => ({ insightsMetrics: { benefitViewed: vi.fn() } }));

const findByLinkedUserId = vi.hoisted(() =>
  vi.fn().mockResolvedValue({ ok: true, value: { memberId: 'm1' } }),
);
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId } }),
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

vi.mock('@/modules/broadcasts', () => ({
  computeQuotaCounter: vi.fn(),
  listMemberBroadcasts: vi.fn(),
  makeComputeQuotaDeps: () => ({}),
  makeListMemberBroadcastsDeps: () => ({}),
  nextResetAtFor: () => '2027-01-01T00:00:00.000Z',
}));

vi.mock('@/app/(member)/portal/benefits/_components/broadcasts-panel', () => ({
  BroadcastsPanel: () => <div data-testid="broadcasts-panel-stub">broadcasts panel</div>,
}));

// THE system-under-test dependency: the raw access tri-state.
const loadMembershipAccess = vi.hoisted(() => vi.fn());
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess }));

import PortalBenefitsPage from '@/app/(member)/portal/benefits/page';

async function renderPage() {
  const ui = await PortalBenefitsPage({ searchParams: Promise.resolve({}) });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('PortalBenefitsPage — suspended "benefits paused" banner (059-membership-suspension)', () => {
  beforeEach(() => {
    findByLinkedUserId.mockResolvedValue({ ok: true, value: { memberId: 'm1' } });
  });
  afterEach(() => vi.clearAllMocks());

  it('renders the paused banner + role=status when suspended', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await renderPage();
    expect(screen.getByText(enMessages.portal.dashboard.membership.suspended.benefitsPausedTitle)).toBeInTheDocument();
    const banner = screen.getByRole('status');
    expect(banner).toBeInTheDocument();
  });

  it('does NOT render the paused banner when full', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'full', reason: 'in_good_standing' });
    await renderPage();
    expect(
      screen.queryByText(enMessages.portal.dashboard.membership.suspended.benefitsPausedTitle),
    ).toBeNull();
  });

  it('does NOT grey the quota to zero when suspended — the entitlement is untouched', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    await renderPage();
    // "3 of 10 used" per the mocked usage above — unaffected by suspension.
    expect(screen.getByText('3 of 10 used')).toBeInTheDocument();
  });

  it('renders no MISSING_KEY/MISSING_NS/NOT_STRING sentinels when suspended', async () => {
    loadMembershipAccess.mockResolvedValue({ access: 'suspended', reason: 'unpaid' });
    const { container } = await renderPage();
    expect(container.textContent ?? '').not.toMatch(/MISSING_KEY|MISSING_NS|NOT_STRING/);
  });
});
