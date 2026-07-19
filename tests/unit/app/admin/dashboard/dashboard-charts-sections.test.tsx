/**
 * Task 12 (067-dashboard-interactive-charts) — page-level render test for
 * `(staff)/admin/(home)/page.tsx`'s new Trends + Breakdown wiring.
 *
 * Every chart component already has thorough unit coverage in isolation
 * (`tests/unit/dashboard/*`, `tests/unit/components/dashboard/*`); this test
 * exists to pin the ONE thing component-level tests structurally cannot: that
 * `StaffHomePage` actually mounts `<MembershipTierChart>` +
 * `<InvoiceStatusChart>` with the snapshot's real `tierDistribution` /
 * `invoiceStatus` fields, inside the two correctly-`aria-label`led landmark
 * sections, and that the whole tree still server-renders cleanly.
 *
 * Renders the page's OWN returned element tree via `renderToStaticMarkup`
 * (same technique as `tests/unit/app/portal/dashboard-page-first-run.test.tsx`)
 * rather than RTL — `StaffHomePage` is an async Server Component with heavy
 * infra deps (session, tenant context, `@/modules/insights`), all mocked
 * below; RTL/jsdom `render()` has no meaningful advantage here since nothing
 * in this test needs user interaction. `MembershipTierChart` /
 * `InvoiceStatusChart` are self-contained-i18n `'use client'` components
 * (`useTranslations` internally, no title props) — since `page.tsx` itself
 * does not provide a `NextIntlClientProvider` (that's the root layout's job,
 * a level above what's under test), the returned tree is wrapped in one here
 * with the REAL `en.json`, so a dangling `t()` key ref surfaces as a real
 * `MISSING_KEY:`/`MISSING_NS:` string in the output rather than silently
 * rendering the raw key or throwing "no context found".
 *
 * **Confirms the Task 12 SSR/lazy-canvas split for real** (not just by
 * reasoning): every chart's decorative Recharts canvas sits behind
 * `next/dynamic(..., { ssr: false })` — a synchronous render (this test's
 * single `renderToStaticMarkup` pass never waits on the dynamic `import()`)
 * shows each canvas's `loading` fallback, so the output must contain ZERO
 * `.recharts-*` class names anywhere, while the accessible
 * `<ChartDataTable>` for the two new Breakdown charts (server-rendered
 * markup, unaffected by the dynamic boundary) IS present — i.e. this is a
 * direct executable proof of "ChartDataTable in SSR output, recharts only in
 * the ssr:false canvas chunk", not an assumption.
 */
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { DashboardSnapshot } from '@/modules/insights';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined), obj);
}

/** Real-en.json-backed translator (same technique as
 * `dashboard-page-first-run.test.tsx`) — a dangling `t()` ref renders as a
 * `MISSING_KEY:`/`MISSING_NS:` string instead of throwing or silently
 * rendering the raw key, so the assertions below catch it directly. */
function makeRealTranslator(ns: string) {
  return (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) => (params[k] !== undefined ? String(params[k]) : `{${k}}`));
  };
}

vi.mock('@/lib/env', () => ({
  env: {
    features: { f9Dashboard: true, f7Broadcasts: true },
    tenant: { timezone: 'Asia/Bangkok' },
  },
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn().mockResolvedValue({
    user: { id: 'u1', displayName: 'Admin User', role: 'admin' },
  }),
}));

vi.mock('@/lib/tenant-context', () => ({
  resolveTenantFromRequest: () => ({ slug: 'tenant-a' }),
}));

// InsightsPanel / ActivityFeedRefresh / DashboardErrorState all call
// `useRouter()` — `renderToStaticMarkup` has no real Next.js App Router
// context mounted, so this must be stubbed (same pattern as
// `pay-sheet.test.tsx`'s `next/navigation` mock).
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => makeRealTranslator(ns)),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

// A representative post-F9 snapshot: non-empty tierDistribution +
// invoiceStatus so both new Breakdown charts render their real (non-empty)
// branch, not the empty state. `vi.hoisted` because `vi.mock(...)` factories
// below are hoisted above this file's top-level statements — a plain
// `const` here would be a temporal-dead-zone reference error inside them.
const SNAPSHOT = vi.hoisted(
  (): DashboardSnapshot => ({
    counts: { total: 10, active: 8, atRisk: 2, overdue: 1 },
    ytdPaidRevenueSatang: '500000',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [{ month: '2026-01', satang: '100000' }],
    memberGrowth: [{ month: '2026-01', cumulative: 5 }],
    topInsights: [],
    tierDistribution: [
      { tierKey: 'gold-2026', label: { en: 'Gold' }, count: 6 },
      { tierKey: 'unassigned', label: { en: 'unassigned' }, count: 1 },
    ],
    invoiceStatus: {
      buckets: [
        { bucket: 'paid', satang: '500000', count: 5 },
        { bucket: 'unpaid', satang: '300000', count: 3 },
        { bucket: 'overdue', satang: '200000', count: 2 },
      ],
      draftCount: 2,
    },
    computedAt: '2026-07-16T00:00:00.000Z',
  }),
);

vi.mock('@/modules/insights', () => ({
  listDashboard: vi.fn().mockResolvedValue({ ok: true, value: { metrics: SNAPSHOT, computedAt: SNAPSHOT.computedAt } }),
  activityFeedQuery: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  listSmartInsights: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  makeListDashboardDeps: vi.fn(() => ({})),
  makeActivityFeedDeps: vi.fn(() => ({})),
  makeListSmartInsightsDeps: vi.fn(() => ({})),
}));

import StaffHomePage from '@/app/(staff)/admin/(home)/page';
import { listDashboard } from '@/modules/insights';

/** A fresh-tenant / no-activity snapshot — empty tierDistribution + all-zero
 * invoiceStatus so BOTH new Breakdown charts must render their empty branch. */
const EMPTY_SNAPSHOT: DashboardSnapshot = {
  counts: { total: 0, active: 0, atRisk: 0, overdue: 0 },
  ytdPaidRevenueSatang: '0',
  underDeliveredBenefitCount: 0,
  needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
  revenueTrend: [],
  memberGrowth: [],
  topInsights: [],
  tierDistribution: [],
  invoiceStatus: { buckets: [], draftCount: 0 },
  computedAt: '2026-07-16T00:00:00.000Z',
};

async function renderPage(): Promise<string> {
  const tree = await StaffHomePage();
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

describe('StaffHomePage — Trends + Breakdown chart sections (Task 12)', () => {
  it('renders both landmark sections with the correct aria-labels', async () => {
    const html = await renderPage();
    expect(html).toContain(`aria-label="${en.admin.dashboard.trends.sectionLabel}"`);
    expect(html).toContain(`aria-label="${en.admin.dashboard.breakdown.sectionLabel}"`);
  });

  it('mounts MembershipTierChart + InvoiceStatusChart with the snapshot data (real titles present)', async () => {
    const html = await renderPage();
    expect(html).toContain(en.admin.dashboard.membershipTier.title); // 'Membership by tier'
    expect(html).toContain(en.admin.dashboard.invoiceStatus.title); // 'Invoice value by status'
    // Tier data actually reached the component (not an empty-state render).
    expect(html).toContain('Gold');
    expect(html).not.toContain(en.admin.dashboard.membershipTier.empty);
    expect(html).not.toContain(en.admin.dashboard.invoiceStatus.empty);
  });

  it('server-renders the accessible <ChartDataTable> for both new charts, with zero recharts DOM anywhere', async () => {
    const html = await renderPage();
    // The hidden tables' <caption> text — proves ChartDataTable made it into
    // the SSR HTML even though the decorative canvas is client-lazy.
    // (CardTitle also renders this text — 2 occurrences each is expected.)
    const tierTitleCount = html.split(en.admin.dashboard.membershipTier.title).length - 1;
    const invoiceTitleCount = html.split(en.admin.dashboard.invoiceStatus.title).length - 1;
    expect(tierTitleCount).toBeGreaterThanOrEqual(2);
    expect(invoiceTitleCount).toBeGreaterThanOrEqual(2);
    // Recharts is behind `next/dynamic(..., { ssr: false })` for every chart
    // on this page — a synchronous render must never contain its markup.
    expect(html).not.toMatch(/recharts-/);
  });

  it('renders with no dangling i18n key references (MISSING_KEY / MISSING_NS)', async () => {
    const html = await renderPage();
    expect(html).not.toContain('MISSING_KEY:');
    expect(html).not.toContain('MISSING_NS:');
  });

  it('renders both new charts empty-state (no crash) when the snapshot has no tier/invoice data', async () => {
    // Override only this render — `mockResolvedValueOnce` falls back to the
    // persistent non-empty SNAPSHOT for every other test.
    vi.mocked(listDashboard).mockResolvedValueOnce({
      ok: true,
      value: { metrics: EMPTY_SNAPSHOT, computedAt: EMPTY_SNAPSHOT.computedAt },
    } as Awaited<ReturnType<typeof listDashboard>>);

    const html = await renderPage();
    expect(html).toContain(en.admin.dashboard.membershipTier.empty);
    expect(html).toContain(en.admin.dashboard.invoiceStatus.empty);
    // Still server-renders cleanly: no dangling i18n, no recharts in SSR.
    expect(html).not.toContain('MISSING_KEY:');
    expect(html).not.toContain('MISSING_NS:');
    expect(html).not.toMatch(/recharts-/);
  });
});
