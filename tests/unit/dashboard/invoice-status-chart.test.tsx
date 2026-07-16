/**
 * Task 11 (067-dashboard-interactive-charts) — `InvoiceStatusChart` render
 * test.
 *
 * A11y model (shared with every 067 chart, see `chart-data-table.tsx`): the
 * Recharts canvas sits in an `aria-hidden="true"` wrapper; the shared
 * `<ChartDataTable>` is the sole SR/no-JS data path — a bucket row per
 * paid/unpaid/overdue + a "Total" row (design doc: "hidden table: bucket →
 * THB, count, %"). ADDITIONALLY (design doc's donut-specific requirement):
 * the donut's centre total and the draftCount caption must be **real DOM**
 * text, OUTSIDE the aria-hidden canvas — not an SVG `<Label>` — or SR users
 * lose them entirely (unlike the table, which is merely visually hidden).
 *
 * This component is self-contained i18n (`useTranslations` +  `useLocale`,
 * no title/label props — same pattern as `membership-tier-chart.tsx`, Task
 * 10), so it needs a real `NextIntlClientProvider` wrapped with the REAL
 * `en.json` (not a stub) so a dangling `t()` key reference surfaces as a
 * real `MISSING_MESSAGE` failure rather than silently rendering the raw key.
 *
 * jsdom workarounds (identical to `membership-tier-chart.test.tsx`):
 *   - `window.matchMedia` stub for `useSyncExternalStore(subscribeMotionPreference, …)`.
 *   - `<ResponsiveContainer>` needs no `ResizeObserver` stub — `ChartContainer`'s
 *     default `initialDimension` (320×200) seeds it synchronously.
 *   - Reduced motion is forced (`stubMatchMedia(true)`) for the ONE assertion
 *     that inspects a painted `<path fill>` attribute on a pie sector — the
 *     same react-smooth/rAF timing gap documented in Task 10's report
 *     (motion=on renders the sector group but defers the actual shape paint
 *     past a synchronous RTL render).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { InvoiceStatusChart } from '@/components/dashboard/invoice-status-chart';
import type { InvoiceStatusBucket, InvoiceStatusDistribution } from '@/modules/insights';

function stubMatchMedia(matches = false) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

beforeEach(() => {
  stubMatchMedia();
});

function renderChart(distribution: InvoiceStatusDistribution) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <InvoiceStatusChart distribution={distribution} />
    </NextIntlClientProvider>,
  );
}

// Round-number fixture (50% / 30% / 20% of a THB 10,000 total; 10 invoices) —
// deterministic percentages, no rounding ambiguity in assertions.
const PAID: InvoiceStatusBucket = { bucket: 'paid', satang: '500000', count: 5 };
const UNPAID: InvoiceStatusBucket = { bucket: 'unpaid', satang: '300000', count: 3 };
const OVERDUE: InvoiceStatusBucket = { bucket: 'overdue', satang: '200000', count: 2 };
const FULL: InvoiceStatusDistribution = {
  buckets: [PAID, UNPAID, OVERDUE],
  draftCount: 4,
};

describe('InvoiceStatusChart', () => {
  it('renders the hidden data table with one row per bucket + a Total row, % of the amount total', () => {
    renderChart(FULL);
    const table = screen.getByRole('table');
    // header + Paid + Unpaid + Overdue + Total = 5
    expect(within(table).getAllByRole('row')).toHaveLength(5);
    expect(within(table).getByRole('rowheader', { name: 'Paid' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Unpaid' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Overdue' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    // THB amounts (satang -> THB, no decimals, dashboard convention).
    expect(within(table).getByText('THB 5,000')).toBeInTheDocument();
    expect(within(table).getByText('THB 3,000')).toBeInTheDocument();
    expect(within(table).getByText('THB 2,000')).toBeInTheDocument();
    expect(within(table).getByText('THB 10,000')).toBeInTheDocument(); // Total row
    // Counts.
    expect(within(table).getByText('5')).toBeInTheDocument();
    expect(within(table).getByText('3')).toBeInTheDocument();
    expect(within(table).getByText('2')).toBeInTheDocument();
    expect(within(table).getByText('10')).toBeInTheDocument(); // Total row count
    // % is of the AMOUNT total (10,000), never the count total.
    expect(within(table).getByText('50%')).toBeInTheDocument();
    expect(within(table).getByText('30%')).toBeInTheDocument();
    expect(within(table).getByText('20%')).toBeInTheDocument();
    expect(within(table).getByText('100%')).toBeInTheDocument();
  });

  it('orders rows paid -> unpaid -> overdue (CVD spacing: amber between green/red)', () => {
    renderChart(FULL);
    const table = screen.getByRole('table');
    const rowHeaders = within(table)
      .getAllByRole('rowheader')
      .map((el) => el.textContent);
    expect(rowHeaders).toEqual(['Paid', 'Unpaid', 'Overdue', 'Total']);
  });

  it('renders the centre total as REAL DOM text, outside the aria-hidden canvas', () => {
    renderChart(FULL);
    const total = screen.getByText('THB 10,000', { selector: 'span' });
    expect(total).toBeInTheDocument();
    expect(total.closest('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it('renders the draftCount caption as real DOM text when draftCount > 0', () => {
    renderChart(FULL);
    const caption = screen.getByText('4 draft invoices not shown');
    expect(caption.closest('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it('renders no draftCount caption when draftCount is 0', () => {
    renderChart({ buckets: [PAID, UNPAID, OVERDUE], draftCount: 0 });
    expect(screen.queryByText(/draft invoice/)).not.toBeInTheDocument();
  });

  it('renders one <Cell>/sector per bucket with 3 distinct semantic fills, each also text-labelled', () => {
    // Force reduced-motion so the pie sector <path fill> is painted
    // synchronously (see module docblock / Task 10's report).
    stubMatchMedia(true);
    const { container } = renderChart(FULL);
    const sectors = container.querySelectorAll('.recharts-pie-sector');
    expect(sectors).toHaveLength(3);
    const fills = Array.from(container.querySelectorAll('.recharts-pie-sector path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(fills).toEqual(['var(--success)', 'var(--warning)', 'var(--destructive)']);
    // Colour is never the sole signal — every bucket also has a text label
    // in the hidden table (never colour-only).
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'Paid' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Unpaid' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Overdue' })).toBeInTheDocument();
  });

  it('wraps the canvas in aria-hidden, and the table is never aria-hidden', () => {
    const { container } = renderChart(FULL);
    const canvas = container.querySelector('.recharts-responsive-container');
    expect(canvas).toBeInTheDocument();
    expect(canvas?.closest('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-hidden');
  });

  it('renders the empty-state text (no chart, no table) when there are no buckets', () => {
    const { container } = renderChart({ buckets: [], draftCount: 0 });
    expect(screen.getByText('No outstanding receivables yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.querySelector('.recharts-responsive-container')).not.toBeInTheDocument();
  });

  it('renders the empty-state text when every bucket amount is zero (all-draft tenant)', () => {
    renderChart({
      buckets: [
        { bucket: 'paid', satang: '0', count: 0 },
        { bucket: 'unpaid', satang: '0', count: 0 },
        { bucket: 'overdue', satang: '0', count: 0 },
      ],
      draftCount: 0,
    });
    expect(screen.getByText('No outstanding receivables yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('shows the draftCount caption even in the empty (all-draft) case', () => {
    renderChart({
      buckets: [
        { bucket: 'paid', satang: '0', count: 0 },
        { bucket: 'unpaid', satang: '0', count: 0 },
        { bucket: 'overdue', satang: '0', count: 0 },
      ],
      draftCount: 7,
    });
    expect(screen.getByText('No outstanding receivables yet.')).toBeInTheDocument();
    expect(screen.getByText('7 draft invoices not shown')).toBeInTheDocument();
  });

  it('renders the chart title (as the CardTitle — also appears as the hidden table caption)', () => {
    renderChart(FULL);
    const matches = screen.getAllByText('Receivables by value');
    expect(matches).toHaveLength(2);
    expect(
      screen.getByText('Receivables by value', { selector: '[data-slot="card-title"]' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Receivables by value')).toBeInTheDocument();
  });

  it('singular draft caption reads naturally for count=1', () => {
    renderChart({ buckets: [PAID, UNPAID, OVERDUE], draftCount: 1 });
    expect(screen.getByText('1 draft invoice not shown')).toBeInTheDocument();
  });
});
