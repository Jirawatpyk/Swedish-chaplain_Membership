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
    // THB amounts to two decimals in this card (spec 122 US11 follow-up,
    // financial review 17 Oct): rows then always add up to the total.
    expect(within(table).getByText('THB 5,000.00')).toBeInTheDocument();
    expect(within(table).getByText('THB 3,000.00')).toBeInTheDocument();
    expect(within(table).getByText('THB 2,000.00')).toBeInTheDocument();
    expect(within(table).getByText('THB 10,000.00')).toBeInTheDocument(); // Total row
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

  it('renders the draftCount caption as real DOM text when draftCount > 0', () => {
    renderChart(FULL);
    const caption = screen.getByText('4 draft invoices not shown');
    expect(caption.closest('[aria-hidden="true"]')).not.toBeInTheDocument();
  });

  it('renders no draftCount caption when draftCount is 0', () => {
    renderChart({ buckets: [PAID, UNPAID, OVERDUE], draftCount: 0 });
    expect(screen.queryByText(/draft invoice/)).not.toBeInTheDocument();
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
      screen.getByText('Invoice value by status', { selector: 'h2.aura-card__title' }),
    ).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Invoice value by status')).toBeInTheDocument();
  });

  it('singular draft caption reads naturally for count=1', () => {
    renderChart({ buckets: [PAID, UNPAID, OVERDUE], draftCount: 1 });
    expect(screen.getByText('1 draft invoice not shown')).toBeInTheDocument();
  });

  it('states the measurement basis so it is not confused with the ex-VAT/fiscal-year KPIs', () => {
    // This donut is all-time + VAT-inclusive; the revenue KPI beside it is
    // fiscal-year + ex-VAT. The basis caption is what stops two legitimately
    // different totals from reading as a broken system, so it must render
    // whenever the chart has data.
    // Since the board redesign it is the card description, and it says the
    // figure is net of credit notes and refunds (financial review, 17 Oct).
    renderChart(FULL);
    expect(
      screen.getByText('All fiscal years · includes VAT · net of credit notes and refunds', {
        selector: '.aura-card__desc',
      }),
    ).toBeInTheDocument();
  });

  // Track B — `allocatePercentages` had no negative contract. `total <= 0`
  // returns zeros, but MIXED signs slip through: [-100, 500, 0] sums to 400, so
  // the shares compute as −25% and 125% and render beside a hard-coded "100%"
  // Total row.
  //
  // The F9 adapter clamps both netting helpers at 0n, so today nothing can feed
  // this a negative. That is exactly why the guard belongs here too: the clamp
  // is one edit away from being removed by someone who "verified the scenario
  // cannot happen", and this component is shared. A percentage outside 0–100 in
  // a finance donut is a number a chamber officer would act on.
  it('never renders a percentage outside 0-100, even if a bucket arrives negative', () => {
    const distribution: InvoiceStatusDistribution = {
      buckets: [
        { bucket: 'paid', satang: '-100', count: 1 },
        { bucket: 'unpaid', satang: '500', count: 1 },
        { bucket: 'overdue', satang: '0', count: 0 },
      ],
      draftCount: 0,
    };
    renderChart(distribution);
    const table = screen.getByRole('table');
    const pcts = within(table)
      .getAllByRole('cell')
      .map((el) => el.textContent ?? '')
      .filter((txt) => txt.trim().endsWith('%'))
      .map((txt) => Number(txt.trim().replace('%', '')));

    expect(pcts.length).toBeGreaterThan(0);
    for (const pct of pcts) {
      expect(Number.isFinite(pct)).toBe(true);
      expect(pct).toBeGreaterThanOrEqual(0);
      expect(pct).toBeLessThanOrEqual(100);
    }
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
    // The visible rows share the SAME computed `pctLabel` — 34/33/33, never
    // an independently-rounded 33/33/33.
    const rowTexts = Array.from(
      container.querySelectorAll('[data-slot="status-rows"] li'),
    ).map((li) => li.textContent);
    expect(rowTexts[0]).toContain('34%');
    expect(rowTexts[1]).toContain('33%');
    expect(rowTexts[2]).toContain('33%');
  });

  // Spec 122 US11 follow-up (maintainer, 17 Oct): the card follows board
  // `Admin-dashboard` — the exact total, one stacked bar and three rows.
  describe('board layout', () => {
    it('shows the exact total (two decimals) with its label; no compact figure', () => {
      renderChart(FULL);
      const total = screen.getByText('THB 10,000.00', { selector: '[data-slot="status-total"]' });
      expect(total.closest('[aria-hidden="true"]')).toBeNull();
      expect(screen.getByText('Total invoiced')).toBeInTheDocument();
      expect(screen.queryByText('THB 10K')).toBeNull();
    });

    it('draws one stacked bar, segments sized by the exact amount share, in paid/unpaid/overdue order', () => {
      const { container } = renderChart(FULL);
      const bar = container.querySelector('[data-slot="status-bar"]');
      expect(bar?.getAttribute('aria-hidden')).toBe('true');
      const segs = Array.from(bar?.querySelectorAll<HTMLElement>('[data-bucket]') ?? []);
      expect(segs.map((s) => s.dataset.bucket)).toEqual(['paid', 'unpaid', 'overdue']);
      expect(segs.map((s) => s.style.flexGrow)).toEqual(['50', '30', '20']);
      expect(segs[0]!.style.backgroundColor).toBe('var(--aura-fg-positive)');
    });

    it('a zero bucket draws no segment', () => {
      const { container } = renderChart({ buckets: [PAID, UNPAID], draftCount: 0 });
      const segs = container.querySelectorAll('[data-slot="status-bar"] [data-bucket]');
      expect(segs).toHaveLength(2);
    });

    it('lists each bucket with its label, amount and percent, hidden from screen readers', () => {
      const { container } = renderChart(FULL);
      const list = container.querySelector('[data-slot="status-rows"]');
      expect(list?.getAttribute('aria-hidden')).toBe('true');
      const rows = Array.from(list?.querySelectorAll('li') ?? []).map((li) => li.textContent ?? '');
      expect(rows).toHaveLength(3);
      expect(rows[0]).toContain('Paid');
      expect(rows[0]).toContain('THB 5,000.00');
      expect(rows[0]).toContain('50%');
      expect(rows[2]).toContain('Overdue');
      expect(rows[2]).toContain('THB 2,000.00');
    });

    it('rows add up to the total, even where whole-baht rounding would not', () => {
      const { container } = renderChart({
        buckets: [
          { bucket: 'paid', satang: '1234550', count: 1 },
          { bucket: 'unpaid', satang: '98750', count: 1 },
          { bucket: 'overdue', satang: '4350', count: 1 },
        ],
        draftCount: 0,
      });
      const rows = Array.from(container.querySelectorAll('[data-slot="status-rows"] li')).map((li) => li.textContent ?? '');
      expect(rows[0]).toContain('THB 12,345.50');
      expect(rows[1]).toContain('THB 987.50');
      expect(rows[2]).toContain('THB 43.50');
      expect(screen.getByText('THB 13,376.50', { selector: '[data-slot="status-total"]' })).toBeInTheDocument();
    });

    it('a non-zero bucket that rounds to 0% reads "<1%"', () => {
      const { container } = renderChart({
        buckets: [
          { bucket: 'paid', satang: '100000000', count: 1 },
          { bucket: 'unpaid', satang: '0', count: 0 },
          { bucket: 'overdue', satang: '10000', count: 1 },
        ],
        draftCount: 0,
      });
      const rows = Array.from(container.querySelectorAll('[data-slot="status-rows"] li')).map((li) => li.textContent ?? '');
      expect(rows[2]).toContain('<1%');
      expect(within(screen.getByRole('table')).getByText('<1%')).toBeInTheDocument();
    });

    it('mounts no chart canvas', () => {
      const { container } = renderChart(FULL);
      expect(container.querySelector('[data-slot="chart"]')).toBeNull();
    });
  });
});

