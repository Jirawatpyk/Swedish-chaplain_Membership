/**
 * 124 slice 3 — the page view: the four tiles (US1.1–1.5) with their links
 * and captions, Export CSV for the selected FY (US2.6), the "No invoices yet"
 * state (US5.2, New invoice for admins only) and a failed tiles read that
 * leaves the cards standing (US5.3). The cards are async server components
 * with their own tests; here they are stand-ins.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/finance',
  useSearchParams: () => new URLSearchParams(),
}));
// The animated amount reads matchMedia; its own tests cover it.
vi.mock('@/components/dashboard/count-up', () => ({
  CountUp: ({ value }: { value: number }) => <span>{value}</span>,
}));
vi.mock('@/modules/insights', async () => {
  const filters = await import('@/modules/insights/domain/invoice-dashboard-filters');
  const fiscalYear = await import('@/modules/insights/domain/invoice-dashboard-fiscal-year');
  const loaders = await import('@/modules/insights/application/use-cases/load-invoice-dashboard');
  return {
    selectableFiscalYears: filters.selectableFiscalYears,
    fiscalYearDateRange: fiscalYear.fiscalYearDateRange,
    invoiceListFilterQuery: loaders.invoiceListFilterQuery,
  };
});
for (const [file, name] of [
  ['aging-card', 'AgingCard'],
  ['attention-card', 'AttentionCard'],
  ['oldest-overdue-card', 'OldestOverdueCard'],
  ['trend-card', 'TrendCard'],
  ['methods-card', 'MethodsCard'],
] as const) {
  vi.doMock(`@/app/(staff)/admin/finance/_components/${file}`, () => ({
    [name]: () => <section data-testid={`stub-${file}`} />,
  }));
}

const { renderInvoiceDashboardView } = await import('@/app/(staff)/admin/finance/_components/invoice-dashboard-view');
const { fiscalYearDateRange } = await import('@/modules/insights/domain/invoice-dashboard-fiscal-year');
const { formatDay } = await import('@/app/(staff)/admin/finance/_lib/dashboard-format');

const D = enMessages.admin.invoiceDashboard;

const TILES = {
  outstanding: { amountSatang: 110_256_000n, count: 31 },
  overdue: { amountSatang: 27_600_000n, count: 9 },
  collectedThisMonth: { amountSatang: 21_400_000n, invoiceCount: 12, range: { from: '2026-10-01', to: '2026-10-19' }, toDate: true as const },
  collectedInFiscalYear: { amountSatang: 311_000_000n, invoiceCount: 140, range: { from: '2026-01-01', to: '2026-10-19' }, toDate: true },
  anyNonDraftInvoice: true,
};

const pending = <T,>() => Promise.resolve({ ok: true as const, value: {} as T });

async function view(over: { tiles?: unknown; canWrite?: boolean; type?: 'all' | 'membership' | 'event'; fiscalYear?: number } = {}) {
  const fiscalYear = over.fiscalYear ?? 2026;
  const tree = await renderInvoiceDashboardView({
    locale: 'en',
    now: new Date('2026-10-19T02:30:00Z'),
    input: {
      filters: { type: over.type ?? 'all', fiscalYear, planId: null, origin: 'all' },
      today: '2026-10-19',
      now: new Date('2026-10-19T02:30:00Z'),
      fiscalYearRange: fiscalYearDateRange(fiscalYear, 1),
      canWrite: over.canWrite ?? true,
    },
    currentFiscalYear: 2026,
    startMonth: 1,
    autoInvoiceEnabled: true,
    plans: [],
    tiles: (over.tiles ?? { ok: true, value: TILES }) as never,
    aging: pending(),
    attention: pending(),
    oldestOverdue: pending(),
    trend: pending(),
    methods: pending(),
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

describe('renderInvoiceDashboardView — tiles', () => {
  it('Outstanding and Overdue link to the list they count, carrying the filters', async () => {
    await view({ type: 'membership' });
    expect(screen.getByRole('link', { name: new RegExp(D.tiles.outstanding) })).toHaveAttribute(
      'href',
      '/admin/invoices?status=issued&subject=membership',
    );
    expect(screen.getByRole('link', { name: new RegExp(`^${D.tiles.overdue}`) })).toHaveAttribute(
      'href',
      '/admin/invoices?status=overdue&subject=membership',
    );
    expect(screen.getByText('31 unpaid invoices · as of today')).toBeInTheDocument();
  });

  it('Collected this month says it ignores the FY; Collected in FY says “to date” only for the current FY', async () => {
    const { unmount } = await view();
    expect(screen.getByText('October to date · not affected by the fiscal-year filter')).toBeInTheDocument();
    expect(screen.getByText('Collected in FY 2026')).toBeInTheDocument();
    expect(screen.getByText('FY 2026 to date')).toBeInTheDocument();
    unmount();
    await view({
      fiscalYear: 2025,
      tiles: {
        ok: true,
        value: {
          ...TILES,
          collectedInFiscalYear: { ...TILES.collectedInFiscalYear, range: { from: '2025-01-01', to: '2025-12-31' }, toDate: false },
        },
      },
    });
    expect(screen.queryByText('FY 2025 to date')).toBeNull();
    expect(screen.getByText(`${formatDay('2025-01-01', 'en')} – ${formatDay('2025-12-31', 'en')}`)).toBeInTheDocument();
  });

  it('Export CSV covers the selected FY up to today', async () => {
    await view();
    expect(screen.getByTestId('dashboard-export-csv')).toHaveAttribute(
      'href',
      '/api/admin/invoices/export.csv?from=2026-01-01&to=2026-10-19',
    );
  });

  it('a failed tiles read shows its reference id; the cards still render', async () => {
    await view({ tiles: { ok: false, error: { code: 'query_failed', referenceId: 'ab12-cd34' } } });
    expect(screen.getByTestId('dashboard-card-error')).toHaveTextContent('ab12-cd34');
    expect(screen.getByTestId('stub-methods-card')).toBeInTheDocument();
  });
});

describe('renderInvoiceDashboardView — No invoices yet (US5.2)', () => {
  it('one empty state with New invoice for an admin; no tiles, no cards, filters out of reach', async () => {
    await view({ tiles: { ok: true, value: { ...TILES, anyNonDraftInvoice: false } } });
    expect(screen.getByTestId('dashboard-empty')).toHaveTextContent(D.states.emptyTitle);
    expect(screen.getByRole('link', { name: D.states.newInvoice })).toHaveAttribute('href', '/admin/invoices/new');
    expect(screen.queryByTestId('dashboard-tiles')).toBeNull();
    expect(screen.queryByTestId('stub-aging-card')).toBeNull();
    expect(screen.getByTestId('dashboard-filters-disabled')).toHaveAttribute('inert');
  });

  it('a manager gets no New invoice', async () => {
    await view({ canWrite: false, tiles: { ok: true, value: { ...TILES, anyNonDraftInvoice: false } } });
    expect(screen.queryByRole('link', { name: D.states.newInvoice })).toBeNull();
  });
});
