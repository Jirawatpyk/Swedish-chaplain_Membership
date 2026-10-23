/**
 * 124 slice 3 — `/admin/finance` page gate and request chain.
 *
 * The gate (US4.3): `requirePagePermission('invoicing.read')` (the one call
 * the staff-page-guard gate allows), then the flag, then `insights.finance`;
 * either refusal is `notFound()` (the admin shell's "Page not available").
 *
 * The chain (one `today` per request): the tenant's fiscal start month
 * (null → January) gives the current FY, the URL is parsed against it, and
 * every loader gets the same input; `canWrite` is `invoicing.write`. Aging is
 * read once and handed to the tiles, so Outstanding equals the aging total.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => {
    throw new Error('NEXT_NOT_FOUND');
  }),
}));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Headers()) }));
vi.mock('next-intl/server', () => ({ getLocale: vi.fn(async () => 'en') }));
const flags = vi.hoisted(() => ({ invoiceDashboard: true, autoInvoice: true }));
vi.mock('@/lib/env', () => ({ env: { features: flags, tenant: { timezone: 'Asia/Bangkok' } } }));
const role = vi.hoisted(() => ({ current: 'admin' }));
vi.mock('@/lib/rbac', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/rbac')>()),
  requirePagePermission: vi.fn(async () => ({
    user: { id: 'staff-1', email: 'a@example.com', role: role.current },
  })),
}));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromHeaders: () => ({ slug: 'swecham' }) }));
vi.mock('@/lib/db', () => ({ runInTenant: vi.fn(async (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({})) }));
const startMonth = vi.hoisted(() => ({ current: 1 as number | null }));
vi.mock('@/modules/invoicing', () => ({
  readFiscalYearStartMonthInTx: vi.fn(async () => startMonth.current),
}));
vi.mock('@/modules/plans', () => ({
  asPlanYear: (y: number) => y,
  listPlanNames: vi.fn(async () => ({ ok: true, value: [] })),
}));
vi.mock('@/modules/plans/plans-deps', () => ({ buildPlansDeps: vi.fn(() => ({})) }));

const loaders = vi.hoisted(() => {
  const aging = { totalSatang: 0n, count: 0, buckets: [] };
  return {
    aging,
    loadInvoiceDashboardAging: vi.fn(async () => ({ ok: true, value: aging })),
    loadInvoiceDashboardTiles: vi.fn(async () => ({ ok: true, value: { anyNonDraftInvoice: true } })),
    loadInvoiceDashboardAttention: vi.fn(async () => ({ ok: true, value: {} })),
    loadInvoiceDashboardOldestOverdue: vi.fn(async () => ({ ok: true, value: { rows: [], canRecordPayment: false } })),
    loadInvoiceDashboardTrend: vi.fn(async () => ({ ok: true, value: {} })),
    loadInvoiceDashboardMethods: vi.fn(async () => ({ ok: true, value: {} })),
  };
});
vi.mock('@/modules/insights', async (importActual) => {
  const actual = await importActual<typeof import('@/modules/insights')>();
  return {
    parseInvoiceDashboardFilters: actual.parseInvoiceDashboardFilters,
    selectableFiscalYears: actual.selectableFiscalYears,
    fiscalYearDateRange: actual.fiscalYearDateRange,
    makeLoadInvoiceDashboardDeps: () => ({ source: {}, newReferenceId: () => 'ref' }),
    loadInvoiceDashboardAging: loaders.loadInvoiceDashboardAging,
    loadInvoiceDashboardTiles: loaders.loadInvoiceDashboardTiles,
    loadInvoiceDashboardAttention: loaders.loadInvoiceDashboardAttention,
    loadInvoiceDashboardOldestOverdue: loaders.loadInvoiceDashboardOldestOverdue,
    loadInvoiceDashboardTrend: loaders.loadInvoiceDashboardTrend,
    loadInvoiceDashboardMethods: loaders.loadInvoiceDashboardMethods,
  };
});
const renderView = vi.hoisted(() => vi.fn(() => null));
vi.mock('@/app/(staff)/admin/finance/_components/invoice-dashboard-view', () => ({
  renderInvoiceDashboardView: renderView,
}));

const { default: InvoiceDashboardPage } = await import('@/app/(staff)/admin/finance/page');

function open(params: Record<string, string> = {}) {
  return InvoiceDashboardPage({ searchParams: Promise.resolve(params) });
}

type LoaderInput = {
  filters: { type: string; fiscalYear: number; planId: string | null; origin: string };
  today: string;
  now: Date;
  fiscalYearRange: { fiscalYear: number; from: string; to: string };
  canWrite: boolean;
};

function inputOf(loader: typeof loaders.loadInvoiceDashboardAging): LoaderInput {
  return (loader.mock.calls[0] as unknown as [unknown, LoaderInput])[1];
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // 09:30 in Bangkok on 19 Oct 2026.
  vi.setSystemTime(new Date('2026-10-19T02:30:00Z'));
  flags.invoiceDashboard = true;
  role.current = 'admin';
  startMonth.current = 1;
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('/admin/finance — gate (US4.3)', () => {
  it('flag off → notFound, and no figure is read', async () => {
    flags.invoiceDashboard = false;
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loaders.loadInvoiceDashboardAging).not.toHaveBeenCalled();
  });

  it('a role without insights.finance → notFound, and no figure is read', async () => {
    role.current = 'marketing';
    await expect(open()).rejects.toThrow('NEXT_NOT_FOUND');
    expect(loaders.loadInvoiceDashboardTiles).not.toHaveBeenCalled();
  });

  it('a manager reads every card without write (canWrite false)', async () => {
    role.current = 'manager';
    await open();
    for (const loader of Object.values(loaders)) {
      if (typeof loader !== 'function') continue;
      expect(loader).toHaveBeenCalledTimes(1);
      expect(inputOf(loader as typeof loaders.loadInvoiceDashboardAging).canWrite).toBe(false);
    }
  });

  it('an admin may act (canWrite true)', async () => {
    await open();
    expect(inputOf(loaders.loadInvoiceDashboardAttention).canWrite).toBe(true);
  });
});

describe('/admin/finance — one request, one input', () => {
  it('today and now are Bangkok, taken once; the FY follows the tenant start month', async () => {
    startMonth.current = 4;
    await open({ fy: '2025' });
    const input = inputOf(loaders.loadInvoiceDashboardTrend);
    expect(input.today).toBe('2026-10-19');
    expect(input.now.toISOString()).toBe('2026-10-19T02:30:00.000Z');
    expect(input.filters.fiscalYear).toBe(2025);
    expect(input.fiscalYearRange).toMatchObject({ from: '2025-04-01', to: '2026-03-31' });
    // Every loader gets the very same input object.
    expect(inputOf(loaders.loadInvoiceDashboardMethods)).toBe(input);
  });

  it('no stored start month → January; an FY outside the list → the current FY', async () => {
    startMonth.current = null;
    await open({ fy: '1999' });
    const input = inputOf(loaders.loadInvoiceDashboardTrend);
    expect(input.filters.fiscalYear).toBe(2026);
    expect(input.fiscalYearRange).toMatchObject({ from: '2026-01-01', to: '2026-12-31' });
  });

  it('aging is read once and its result handed to the tiles', async () => {
    await open();
    expect(loaders.loadInvoiceDashboardAging).toHaveBeenCalledTimes(1);
    const tilesCall = loaders.loadInvoiceDashboardTiles.mock.calls[0] as unknown as unknown[];
    expect(tilesCall[3]).toBe(loaders.aging);
  });
});
