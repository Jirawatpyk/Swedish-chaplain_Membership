/**
 * Task 10 (067-dashboard-interactive-charts) — `MembershipTierChart` render
 * test.
 *
 * A11y model (shared with every 067 chart, see `chart-data-table.tsx`): the
 * Recharts canvas sits in an `aria-hidden="true"` wrapper; the shared
 * `<ChartDataTable>` is the sole SR/no-JS data path — including a "Total"
 * row (design doc: "hidden table: tier → count, % (+ total row)").
 *
 * This component is self-contained i18n (`useTranslations`, no title/label
 * props — same pattern as `components/renewals/month-bar-chart.tsx`), so it
 * needs a real `NextIntlClientProvider` — wrapped with the REAL `en.json`
 * (not a stub), matching `tests/unit/components/renewals/month-bar-chart.test.tsx`'s
 * convention, so a dangling `t()` key reference surfaces as a real
 * `MISSING_MESSAGE` failure rather than silently rendering the raw key.
 *
 * jsdom workarounds (identical to `mini-series-chart.test.tsx`):
 *   - `window.matchMedia` — jsdom has no implementation at all; every test
 *     stubs it so `useSyncExternalStore(subscribeMotionPreference, …)` can
 *     read a `MediaQueryList`-shaped value instead of throwing.
 *   - Recharts' `<ResponsiveContainer>` needs no `ResizeObserver` stub:
 *     `ChartContainer`'s default `initialDimension` (320×200) seeds it
 *     synchronously, and its resize-observing effect no-ops when
 *     `typeof ResizeObserver === 'undefined'` (true in jsdom).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { MembershipTierChart } from '@/components/dashboard/membership-tier-chart';
import { UNASSIGNED_TIER_KEY, type TierDistributionSlice } from '@/modules/insights';

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

function renderChart(slices: readonly TierDistributionSlice[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MembershipTierChart slices={slices} />
    </NextIntlClientProvider>,
  );
}

const GOLD: TierDistributionSlice = { tierKey: 'gold-2026', label: 'Gold', count: 6 };
const SILVER: TierDistributionSlice = { tierKey: 'silver-2026', label: 'Silver', count: 3 };
const UNASSIGNED: TierDistributionSlice = { tierKey: UNASSIGNED_TIER_KEY, label: 'unassigned', count: 1 };

describe('MembershipTierChart', () => {
  it('renders the hidden data table with one row per tier + a Total row', () => {
    renderChart([GOLD, SILVER]);
    const table = screen.getByRole('table');
    // header + Gold + Silver + Total = 4
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByRole('rowheader', { name: 'Gold' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Silver' })).toBeInTheDocument();
    expect(within(table).getByRole('rowheader', { name: 'Total' })).toBeInTheDocument();
    // total count (6+3=9) and 100% on the Total row.
    expect(within(table).getByText('9')).toBeInTheDocument();
    expect(within(table).getByText('100%')).toBeInTheDocument();
    // % is of the ACTIVE TOTAL (9), not of the max bar (6): Gold is 6/9 ≈ 67%.
    expect(within(table).getByText('67%')).toBeInTheDocument();
    // Silver is 3/9 = 33%.
    expect(within(table).getByText('33%')).toBeInTheDocument();
  });

  it('renders the unassigned slice with a translated sentinel label, never the literal "unassigned"', () => {
    renderChart([GOLD, UNASSIGNED]);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'No plan assigned' })).toBeInTheDocument();
    expect(within(table).queryByText('unassigned')).not.toBeInTheDocument();
  });

  it('shows a stored plan label verbatim (not translated) for a resolved tier', () => {
    renderChart([GOLD]);
    expect(screen.getByRole('rowheader', { name: 'Gold' })).toBeInTheDocument();
  });

  it('renders a single, single-colour <Bar> — not one <Cell>/colour per slice', () => {
    // Force reduced-motion (allowMotion=false → isAnimationActive=false) for
    // THIS assertion only: react-smooth's `Animate` wrapper (engaged when
    // isAnimationActive=true) defers the actual `<path>` paint past this
    // synchronous render — a jsdom/rAF timing gap, not a component bug (the
    // fill/single-Bar structure is identical either way; verified empirically
    // that motion=on renders 3 real `.recharts-bar-rectangle` GROUPS with an
    // empty `.recharts-inactive-bar` child, motion=off paints the `<path>`).
    stubMatchMedia(true);
    const { container } = renderChart([GOLD, SILVER, UNASSIGNED]);
    const bars = container.querySelectorAll('.recharts-bar');
    expect(bars).toHaveLength(1);
    // No per-slice <Cell> children (that would be the multi-colour pattern
    // this design doc explicitly rejects for up to 9 tiers).
    expect(container.querySelectorAll('.recharts-bar .recharts-layer.recharts-bar-rectangle')).toHaveLength(3);
    expect(container.querySelectorAll('.recharts-pie-sector, [class*="cell-"]')).toHaveLength(0);
    // Every rectangle shares the single navy chart token, not a per-index hue.
    const rects = container.querySelectorAll('.recharts-bar-rectangle path');
    expect(rects.length).toBe(3);
    rects.forEach((rect) => {
      expect(rect).toHaveAttribute('fill', 'var(--chart-1)');
    });
    // End-of-bar "count (pct%)" labels (design doc: "count + % end-labels"),
    // % of the ACTIVE TOTAL (10): Gold 6/10=60%, Silver 3/10=30%, unassigned 1/10=10%.
    const labelTexts = Array.from(container.querySelectorAll('.recharts-label-list text')).map(
      (n) => n.textContent,
    );
    expect(labelTexts).toEqual(['6 (60%)', '3 (30%)', '1 (10%)']);
  });

  it('wraps the canvas in aria-hidden, and the table is never aria-hidden', () => {
    const { container } = renderChart([GOLD]);
    const canvas = container.querySelector('.recharts-responsive-container');
    expect(canvas).toBeInTheDocument();
    expect(canvas?.closest('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-hidden');
  });

  it('renders the empty-state text (no chart, no table) when there are no slices', () => {
    const { container } = renderChart([]);
    expect(screen.getByText('No active members yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.querySelector('.recharts-responsive-container')).not.toBeInTheDocument();
  });

  it('renders the empty-state text when every slice has a zero count', () => {
    renderChart([{ tierKey: 'gold-2026', label: 'Gold', count: 0 }]);
    expect(screen.getByText('No active members yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('renders the chart title (as the CardTitle — also appears as the hidden table caption)', () => {
    renderChart([GOLD]);
    // Two matches by design: the visible CardTitle + the hidden <table>'s
    // <caption> (ChartDataTable's `caption` prop) share the same title text.
    const matches = screen.getAllByText('Membership by tier');
    expect(matches).toHaveLength(2);
    expect(screen.getByText('Membership by tier', { selector: '[data-slot="card-title"]' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Membership by tier')).toBeInTheDocument();
  });
});
