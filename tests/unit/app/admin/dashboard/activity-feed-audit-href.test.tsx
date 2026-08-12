/**
 * 016 T058 (US3) — the dashboard activity feed's "related record" link must
 * follow `audit.read`, not appear unconditionally.
 *
 * D4 narrowed `audit.read` to super_admin-only. Every feed row with a
 * `targetUserId` still deep-links to `/admin/audit?targetRef=…`, so on the ON
 * leg an admin, a manager and a marketing operator all see a link that lands on
 * the audit page's own guard — a 403/notFound dead end. This is not a marketing
 * regression introduced by PR 4; it went live the moment the flag flipped, and
 * PR 4 is where the feed's permission story is being written down, so it is
 * fixed here.
 *
 * The OFF leg must keep today's behaviour exactly: `legacySessionOnly` admits
 * every staff role, so the link stays for all of them.
 *
 * Renders the real page tree (same technique as
 * `dashboard-charts-sections.test.tsx`) because the href is assembled in the
 * page's feed→`ActivityFeedEntry` mapping, not inside a component that could be
 * unit-tested on its own.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import type { DashboardSnapshot } from '@/modules/insights';

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
  const t = (key: string, params?: Record<string, unknown>): string => {
    const nsObj = getPath(en as unknown, ns);
    if (!nsObj) return `MISSING_NS:${ns}`;
    const val = getPath(nsObj, key);
    if (val === undefined || val === null) return `MISSING_KEY:${ns}.${key}`;
    if (typeof val !== 'string') return `NOT_STRING:${ns}.${key}`;
    if (!params) return val;
    return val.replace(/\{(\w+)[^}]*\}/g, (_, k: string) =>
      params[k] !== undefined ? String(params[k]) : `{${k}}`,
    );
  };
  // `resolveEventLabel` probes `t.has(code)` before falling back to the timeline
  // catalogue; a translator without it throws before the page ever renders.
  // Backed by the real en.json so the fallback chain behaves as in production.
  t.has = (key: string): boolean => {
    const nsObj = getPath(en as unknown, ns);
    return Boolean(nsObj) && typeof getPath(nsObj, key) === 'string';
  };
  return t;
}

/** Mutable so each test can pick the leg + the viewer without re-mocking. */
const state = vi.hoisted(() => ({ rbacV2: true, role: 'admin' as string }));

vi.mock('@/lib/env', () => ({
  env: {
    features: {
      get f9Dashboard() {
        return true;
      },
      get f7Broadcasts() {
        return true;
      },
      get rbacV2() {
        return state.rbacV2;
      },
    },
    tenant: { timezone: 'Asia/Bangkok' },
  },
}));

vi.mock('@/lib/logger', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@/lib/auth-session', () => ({
  requireSession: vi.fn(async () => ({
    user: { id: 'u1', displayName: 'Admin User', role: state.role },
  })),
  getCurrentSession: vi.fn(async () => ({
    user: { id: 'u1', displayName: 'Admin User', role: state.role },
  })),
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

const SNAPSHOT = vi.hoisted(
  (): DashboardSnapshot => ({
    counts: { total: 3, active: 3, atRisk: 0, overdue: 0 },
    ytdPaidRevenueSatang: '0',
    underDeliveredBenefitCount: 0,
    needsAttention: { broadcastsAwaitingApproval: 0, overdueInvoices: 0, atRiskMembers: 0 },
    revenueTrend: [],
    memberGrowth: [],
    topInsights: [],
    tierDistribution: [],
    invoiceStatus: { buckets: [], draftCount: 0 },
    computedAt: '2026-08-11T00:00:00.000Z',
  }),
);

/** One feed row WITH a `targetUserId` — the only shape that produces an href. */
const TARGET_USER_ID = '11111111-2222-3333-4444-555555555555';
const FEED = vi.hoisted(() => [
  {
    id: 'evt-1',
    eventType: 'member_updated',
    occurredAt: '2026-08-11T00:00:00.000Z',
    actorUserId: 'u1',
    actorLabel: 'Admin User',
    targetUserId: '11111111-2222-3333-4444-555555555555',
    summary: 'member updated',
  },
]);

vi.mock('@/modules/insights', async () => ({
  ...(await import('@/modules/insights/application/use-cases/list-dashboard')),
  listDashboard: vi
    .fn()
    .mockResolvedValue({ ok: true, value: { metrics: SNAPSHOT, computedAt: SNAPSHOT.computedAt } }),
  activityFeedQuery: vi.fn().mockResolvedValue({ ok: true, value: FEED }),
  listSmartInsights: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  makeListDashboardDeps: vi.fn(() => ({})),
  makeActivityFeedDeps: vi.fn(() => ({})),
  makeListSmartInsightsDeps: vi.fn(() => ({})),
}));

/**
 * `src/lib/rbac.ts` snapshots `env.features.rbacV2` into `defaultDeps` at MODULE
 * EVAL — correct for a deploy-time flag, but it means a getter on the env mock
 * is read exactly once per module registry. Switching legs therefore requires
 * resetting the registry and re-importing the page, not just flipping `state`.
 * A static import here would silently pin every case to whichever leg happened
 * to be set first, and the OFF-leg assertions would be vacuous.
 */
async function renderAs(role: string, rbacV2: boolean): Promise<string> {
  state.role = role;
  state.rbacV2 = rbacV2;
  vi.resetModules();
  const { default: StaffHomePage } = await import('@/app/(staff)/admin/(home)/page');
  const tree = await StaffHomePage();
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

const AUDIT_HREF = `/admin/audit?targetRef=${TARGET_USER_ID}`;

describe('dashboard activity feed — audit deep-link follows audit.read (016 T058)', () => {
  beforeEach(() => {
    state.role = 'admin';
    state.rbacV2 = true;
  });

  it('ON leg: super_admin keeps the link', async () => {
    expect(await renderAs('super_admin', true)).toContain(AUDIT_HREF);
  });

  it('ON leg: admin does NOT get a link to a page D4 denies them', async () => {
    expect(await renderAs('admin', true)).not.toContain(AUDIT_HREF);
  });

  it('ON leg: manager does NOT get the link', async () => {
    expect(await renderAs('manager', true)).not.toContain(AUDIT_HREF);
  });

  it('ON leg: marketing does NOT get the link', async () => {
    expect(await renderAs('marketing', true)).not.toContain(AUDIT_HREF);
  });

  it('ON leg: the feed row itself still renders — only the link is dropped', async () => {
    // Guards against "fixing" this by filtering the row out of the feed, which
    // would silently shrink the widget rather than de-link one entry.
    const html = await renderAs('marketing', true);
    expect(html).toContain(en.admin.dashboard.activity.title);
    expect(html).toContain('Admin User');
  });

  it('OFF leg: every role that can open the page keeps the link (byte-identical to pre-016)', async () => {
    // `marketing` is deliberately absent: D16 maps it to no legacy role, so on
    // the OFF leg it is denied the dashboard outright and never reaches the
    // feed. Asserting a link for it here would not be a stricter test — it
    // would fail inside `requirePagePermission`'s denial path, which is the
    // correct behaviour, covered by the OFF-leg role tests.
    for (const role of ['admin', 'manager', 'super_admin']) {
      expect(await renderAs(role, false), `${role} on the OFF leg`).toContain(AUDIT_HREF);
    }
  });
});
