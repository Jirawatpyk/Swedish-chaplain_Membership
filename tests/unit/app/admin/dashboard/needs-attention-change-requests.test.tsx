/**
 * F114 US6 (T096 / T100; FR-033, FR-039) — the staff dashboard's "Needs
 * attention" list carries a LIVE change-request item: count + the age of
 * the oldest pending request, deep-linking to the queue. Rendered through
 * the page's own returned tree via `renderToStaticMarkup` with the REAL
 * `en.json` (same harness as `dashboard-charts-sections.test.tsx`).
 *
 * Pinned:
 *   - flag ON + count > 0 → the item, its count, its href, and the oldest
 *     age in the label (US6 AS3) as WHOLE DAYS through an ICU plural — never
 *     the relative-time helper, whose >30-day arm renders a calendar date in
 *     exactly the FR-037 one-month window (UX M2); "today" under a day;
 *   - count > 0 with a null age → the label without the age clause, never
 *     "(oldest )" (UX L5);
 *   - count 0 → no item (a "0" with a dead-end link is noise, FR-006);
 *   - flag OFF → no item even with rows waiting, and NO query (FR-039 —
 *     the T118 dashboard half);
 *   - the count read faults → the page still renders, the item is simply
 *     absent, logged once under `M114.dashboard.pending_count_failed`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { DashboardSnapshot } from '@/modules/insights';

// The REAL ICU formatter over the real `en.json` (the age label is a plural
// message); a missing key THROWS instead of rendering a placeholder.
function makeRealTranslator(ns: string) {
  return createTranslator({
    locale: 'en',
    messages: en,
    namespace: ns,
    onError: (e: Error) => {
      throw e;
    },
  } as unknown as Parameters<typeof createTranslator>[0]);
}

const h = vi.hoisted(() => ({
  features: { f9Dashboard: true, f7Broadcasts: true, memberChangeApproval: true },
  count: vi.fn(),
  logError: vi.fn(),
}));

vi.mock('@/lib/env', () => ({
  env: { features: h.features, tenant: { timezone: 'Asia/Bangkok' } },
}));

vi.mock('@/lib/logger', () => ({
  logger: { warn: vi.fn(), error: h.logError, info: vi.fn(), debug: vi.fn() },
}));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', displayName: 'Admin User', role: 'admin' },
  }),
  getCurrentSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', displayName: 'Admin User', role: 'admin' },
  }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

// The members composition root boots infra clients at import; only the two
// seams the page touches are needed here.
vi.mock('@/lib/members-change-request-deps', () => ({
  buildChangeRequestDeps: () => ({ tenant: { slug: 'tenant-a' } }),
}));
vi.mock('@/modules/members', () => ({ countPendingChangeRequests: h.count }));

// Every OTHER attention count is zero so the list is empty unless the
// change-request item is present.
const SNAPSHOT = vi.hoisted(
  (): DashboardSnapshot => ({
    counts: { total: 10, active: 8, atRisk: 0, overdue: 0 },
    ytdPaidRevenueSatang: '500000',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [{ month: '2026-01', satang: '100000' }],
    memberGrowth: [{ month: '2026-01', cumulative: 5 }],
    topInsights: [],
    tierDistribution: [{ tierKey: 'gold-2026', label: { en: 'Gold' }, count: 6 }],
    invoiceStatus: { buckets: [{ bucket: 'paid', satang: '500000', count: 5 }], draftCount: 0 },
    computedAt: '2026-07-16T00:00:00.000Z',
  }),
);

vi.mock('@/modules/insights', async () => ({
  ...(await import('@/modules/insights/application/use-cases/list-dashboard')),
  listDashboard: vi.fn().mockResolvedValue({ ok: true, value: { metrics: SNAPSHOT, computedAt: SNAPSHOT.computedAt } }),
  activityFeedQuery: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  listSmartInsights: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  makeListDashboardDeps: vi.fn(() => ({})),
  makeActivityFeedDeps: vi.fn(() => ({})),
  makeListSmartInsightsDeps: vi.fn(() => ({})),
}));

import StaffHomePage from '@/app/(staff)/admin/(home)/page';

const THREE_DAYS = 3 * 86_400;

async function renderPage(): Promise<string> {
  const tree = await StaffHomePage();
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  h.features.memberChangeApproval = true;
  h.count.mockReset();
  h.logError.mockReset();
});

describe('StaffHomePage — Needs attention: change requests (F114 US6)', () => {
  it('flag ON + pending rows → the item with count, oldest age and the queue href', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: THREE_DAYS } });
    const html = await renderPage();
    expect(html).toContain('href="/admin/change-requests"');
    expect(html).toContain('Change requests waiting (oldest 3 days)');
    expect(html).toContain('<span class="tabular-nums font-medium">3</span>');
    expect(html).not.toContain(en.admin.dashboard.needsAttention.empty);
    expect(h.count).toHaveBeenCalledTimes(1);
  });

  it('45 days → "oldest 45 days", never a calendar date (UX M2 — the FR-037 window)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 2, oldestAgeSeconds: 45 * 86_400 + 3_600 } });
    const html = await renderPage();
    expect(html).toContain('Change requests waiting (oldest 45 days)');
    // the relative-time helper's >30-day fallback: "(oldest Aug 1, 2026)"
    expect(html).not.toMatch(/\(oldest [A-Z][a-z]{2} \d/);
  });

  it('under a day → "today"; exactly one day → "1 day" (UX M2)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 1, oldestAgeSeconds: 5 * 3_600 } });
    expect(await renderPage()).toContain('Change requests waiting (oldest today)');
    h.count.mockResolvedValue({ ok: true, value: { count: 1, oldestAgeSeconds: 86_400 } });
    expect(await renderPage()).toContain('Change requests waiting (oldest 1 day)');
  });

  it('count > 0 with a null age → the label without the age clause (UX L5)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 2, oldestAgeSeconds: null } });
    const html = await renderPage();
    expect(html).toContain('href="/admin/change-requests"');
    expect(html).toContain('Change requests waiting<');
    expect(html).not.toContain('(oldest');
  });

  it('count 0 → no item (the list shows its all-clear state)', async () => {
    h.count.mockResolvedValue({ ok: true, value: { count: 0, oldestAgeSeconds: null } });
    const html = await renderPage();
    expect(html).not.toContain('href="/admin/change-requests"');
    expect(html).toContain(en.admin.dashboard.needsAttention.empty);
  });

  it('flag OFF → no item even with rows waiting, and no query (FR-039, T118 dashboard half)', async () => {
    h.features.memberChangeApproval = false;
    h.count.mockResolvedValue({ ok: true, value: { count: 3, oldestAgeSeconds: THREE_DAYS } });
    const html = await renderPage();
    expect(html).not.toContain('href="/admin/change-requests"');
    expect(html).toContain(en.admin.dashboard.needsAttention.empty);
    expect(h.count).not.toHaveBeenCalled();
  });

  it('the count read faults → the page still renders, the item is absent, logged once', async () => {
    h.count.mockRejectedValue(new Error('neon down'));
    const html = await renderPage();
    expect(html).toContain(en.admin.dashboard.title);
    expect(html).not.toContain('href="/admin/change-requests"');
    expect(html).toContain(en.admin.dashboard.needsAttention.empty);
    expect(h.logError).toHaveBeenCalledTimes(1);
    expect(h.logError.mock.calls[0]![0]).toMatchObject({ errorId: 'M114.dashboard.pending_count_failed' });
  });
});
