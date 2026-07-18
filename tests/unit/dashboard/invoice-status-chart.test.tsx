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
 * **Task 12 split**: the actual `<PieChart>` rendering was extracted into
 * `./invoice-status-canvas.tsx` and is now mounted here via
 * `next/dynamic(..., { ssr: false })`, so recharts stays out of `/admin`'s
 * first-load JS. A synchronous RTL `render()` therefore sees the `loading`
 * fallback, never the resolved Recharts markup — the Recharts-primitive
 * sector/fill assertions moved to `invoice-status-canvas.test.tsx`, which
 * renders `<InvoiceStatusCanvas>` directly. The table, centre-total,
 * legend, draft-caption, and empty-state assertions below are unaffected
 * (they all render outside the dynamic boundary).
 *
 * jsdom workarounds (identical to `membership-tier-chart.test.tsx`):
 *   - `window.matchMedia` stub for `useSyncExternalStore(subscribeMotionPreference, …)`.
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

  it('renders the centre total as REAL DOM text (compact format), outside the aria-hidden canvas', () => {
    renderChart(FULL);
    // Compact ("THB 10K"), not the full "THB 10,000" — the centre overlay
    // must fit the donut hole at any locale's currency-string length; the
    // FULL exact amount stays in the hidden table's Total row (asserted in
    // the first test above) and the tooltip.
    const total = screen.getByText('THB 10K', { selector: 'span' });
    expect(total).toBeInTheDocument();
    expect(total.closest('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  // Bug fix: the centre-total overlay used to be a plain (non-positioned)
  // sibling next to the aria-hidden canvas wrapper, so the browser's default
  // stacking rules (a POSITIONED box always paints above a non-positioned
  // one, regardless of DOM order) made the total win every time — hiding
  // the Recharts hover tooltip behind it, and spilling over the arcs
  // whenever the total's text ran wider than the hole. The fix promotes the
  // canvas wrapper to its own higher-z-index stacking context so the arcs
  // AND the tooltip painted inside it always win over the total underneath.
  it('stacks the canvas wrapper ABOVE the centre-total overlay (z-index) so the hover tooltip is never hidden behind it', () => {
    const { container } = renderChart(FULL);
    const canvasWrapper = container.querySelector('[aria-hidden="true"]');
    expect(canvasWrapper).toHaveClass('relative', 'z-10');
    const total = screen.getByText('THB 10K', { selector: 'span' });
    const totalWrapper = total.closest('div');
    expect(totalWrapper).toHaveClass('absolute', 'z-0');
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

  // The Recharts-primitive "one <Cell>/sector per bucket with 3 distinct
  // semantic fills" assertion moved to `invoice-status-canvas.test.tsx`
  // (Task 12 dynamic(ssr:false) split — a synchronous render here only ever
  // sees the `loading` fallback). The "colour is never the sole signal —
  // every bucket also has a text label" guarantee stays pinned by the
  // rowheader assertions already in the first test above.

  it('wraps the (lazy-loaded) canvas slot in aria-hidden, and the table is never aria-hidden', () => {
    // This test keeps the chart-level guarantee: the wrapper div that will
    // eventually hold the canvas is ALREADY `aria-hidden="true"` from the
    // very first paint, and the accessible table is never hidden either way.
    const { container } = renderChart(FULL);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-hidden');
  });

  it('renders the empty-state text (no chart, no table) when there are no buckets', () => {
    const { container } = renderChart({ buckets: [], draftCount: 0 });
    expect(screen.getByText('No issued invoices yet.')).toBeInTheDocument();
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
    expect(screen.getByText('No issued invoices yet.')).toBeInTheDocument();
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
    expect(screen.getByText('No issued invoices yet.')).toBeInTheDocument();
    expect(screen.getByText('7 draft invoices not shown')).toBeInTheDocument();
  });

  it('renders the chart title (as the CardTitle — also appears as the hidden table caption)', () => {
    renderChart(FULL);
    const matches = screen.getAllByText('Invoice value by status');
    expect(matches).toHaveLength(2);
    expect(
      screen.getByText('Invoice value by status', { selector: '[data-slot="card-title"]' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Invoice value by status')).toBeInTheDocument();
  });

  it('singular draft caption reads naturally for count=1', () => {
    renderChart({ buckets: [PAID, UNPAID, OVERDUE], draftCount: 1 });
    expect(screen.getByText('1 draft invoice not shown')).toBeInTheDocument();
  });

  // WCAG 1.4.1 (Use of Color) — the donut's success/warning/destructive
  // fills are near-equal luminance (fail CVD separation), and until now the
  // only text labels were in the sr-only table + hover-only tooltip: a
  // sighted colour-blind user saw three indistinguishable slices with no
  // persistent on-screen label. Fix: a visible legend row (swatch + label +
  // %) below the donut, `aria-hidden` because it duplicates the sr-only
  // table's data (same double-announce rationale as the aria-hidden canvas).
  it('renders a persistent, visible legend (swatch + label + %) per bucket, hidden from SR', () => {
    const { container } = renderChart(FULL);
    const legend = container.querySelector('ul[aria-hidden="true"]');
    expect(legend).toBeInTheDocument();
    const items = legend?.querySelectorAll('li') ?? [];
    expect(items).toHaveLength(3);
    const texts = Array.from(items).map((li) => li.textContent);
    expect(texts[0]).toContain('Paid');
    expect(texts[0]).toContain('50%');
    expect(texts[1]).toContain('Unpaid');
    expect(texts[1]).toContain('30%');
    expect(texts[2]).toContain('Overdue');
    expect(texts[2]).toContain('20%');
    // Every entry carries its own colour swatch (never colour-only, but the
    // swatch is present alongside the text label).
    items.forEach((li) => {
      expect(li.querySelector('span[style]')).toBeInTheDocument();
    });
    // The sr-only <ChartDataTable> (which already carries this data) must
    // NOT be aria-hidden — only the new visible legend duplicate is.
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-hidden');
  });

  // Minor: naive independent `Math.round(share / total * 100)` per bucket
  // can fail to sum to 100 (e.g. three equal thirds round to 33/33/33 = 99).
  // Largest-remainder allocation must make the displayed bucket %s always
  // sum to exactly 100, matching the Total row.
  it('allocates bucket %s via largest-remainder so they sum to exactly 100 (equal thirds would naively round to 99)', () => {
    const distribution: InvoiceStatusDistribution = {
      buckets: [
        { bucket: 'paid', satang: '100', count: 1 },
        { bucket: 'unpaid', satang: '100', count: 1 },
        { bucket: 'overdue', satang: '100', count: 1 },
      ],
      draftCount: 0,
    };
    const { container } = renderChart(distribution);
    const table = screen.getByRole('table');
    const rowHeaders = within(table)
      .getAllByRole('rowheader')
      .map((el) => el.textContent);
    // First index (Paid) wins the tie-break and gets the extra point: 34%,
    // the rest stay at the floor: 33% each. Total row is still 100%.
    expect(rowHeaders).toEqual(['Paid', 'Unpaid', 'Overdue', 'Total']);
    expect(within(table).getByText('34%')).toBeInTheDocument();
    expect(within(table).getAllByText('33%')).toHaveLength(2);
    expect(within(table).getByText('100%')).toBeInTheDocument(); // Total row
    expect(34 + 33 + 33).toBe(100);
    // The visible legend (Minor fix) shares the SAME computed `pctLabel` —
    // must also read 34/33/33, never an independently-rounded 33/33/33.
    const legend = container.querySelector('ul[aria-hidden="true"]');
    const legendTexts = Array.from(legend?.querySelectorAll('li') ?? []).map((li) => li.textContent);
    expect(legendTexts[0]).toContain('34%');
    expect(legendTexts[1]).toContain('33%');
    expect(legendTexts[2]).toContain('33%');
  });
});
