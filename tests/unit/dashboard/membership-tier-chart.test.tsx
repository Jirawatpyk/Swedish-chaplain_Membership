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
 * **Task 12 split**: the actual `<BarChart>` rendering was extracted into
 * `./membership-tier-canvas.tsx` and is now mounted here via
 * `next/dynamic(..., { ssr: false })`, so recharts stays out of `/admin`'s
 * first-load JS. A synchronous RTL `render()` therefore sees the `loading`
 * fallback, never the resolved Recharts markup — the Recharts-primitive
 * assertions moved to `membership-tier-canvas.test.tsx`, which renders
 * `<MembershipTierCanvas>` directly. The table + empty-state assertions
 * below are unaffected (they render outside the dynamic boundary).
 *
 * jsdom workarounds (identical to `mini-series-chart.test.tsx`):
 *   - `window.matchMedia` — jsdom has no implementation at all; every test
 *     stubs it so `useSyncExternalStore(subscribeMotionPreference, …)` can
 *     read a `MediaQueryList`-shaped value instead of throwing.
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

const GOLD: TierDistributionSlice = { tierKey: 'gold-2026', label: { en: 'Gold' }, count: 6 };
const SILVER: TierDistributionSlice = { tierKey: 'silver-2026', label: { en: 'Silver' }, count: 3 };
const UNASSIGNED: TierDistributionSlice = { tierKey: UNASSIGNED_TIER_KEY, label: { en: 'unassigned' }, count: 1 };

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

  // Enterprise-detail pass: the tier bar previously had no KPI-sized
  // headline (unlike the sparklines' summary stat) — this pins the fix.
  it('renders a headline stat (active-member total, KPI/dashboard-hero scale) above the bar chart', () => {
    renderChart([GOLD, SILVER]);
    expect(screen.getByText('9', { selector: 'span' })).toBeInTheDocument();
    expect(screen.getByText('Active members')).toBeInTheDocument();
  });

  it('highlights the top (most populous) tier next to the headline stat', () => {
    renderChart([GOLD, SILVER]);
    // Gold = 6/9 ≈ 67% and sorts first (design doc: count-desc) → top tier.
    expect(screen.getByText('Top: Gold · 67%')).toBeInTheDocument();
  });

  it('omits the top-tier chip when the only slice is the unassigned bucket (never highlights "No plan assigned" as the top tier)', () => {
    renderChart([UNASSIGNED]);
    expect(screen.queryByText(/^Top:/)).not.toBeInTheDocument();
    // The headline stat itself still renders (1 active member, unassigned).
    expect(screen.getByText('1', { selector: 'span' })).toBeInTheDocument();
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

  it('wraps the (lazy-loaded) canvas slot in aria-hidden, and the table is never aria-hidden', () => {
    // The Recharts-primitive "wraps the canvas in aria-hidden" assertion
    // (querying `.recharts-responsive-container`) moved to
    // `membership-tier-canvas.test.tsx` — a synchronous render here only
    // ever sees the `loading` fallback (Task 12 dynamic(ssr:false) split).
    // This test keeps the chart-level guarantee: the definite-height
    // wrapper div that will eventually hold the canvas is ALREADY
    // `aria-hidden="true"` from the very first paint, and the accessible
    // table is never hidden either way.
    const { container } = renderChart([GOLD]);
    expect(container.querySelector('[aria-hidden="true"]')).toBeInTheDocument();
    expect(screen.getByRole('table')).not.toHaveAttribute('aria-hidden');
  });

  it('renders the empty-state text (no chart, no table) when there are no slices', () => {
    const { container } = renderChart([]);
    expect(screen.getByText('No active members yet.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(container.querySelector('.recharts-responsive-container')).not.toBeInTheDocument();
  });

  it('renders the empty-state text when every slice has a zero count', () => {
    renderChart([{ tierKey: 'gold-2026', label: { en: 'Gold' }, count: 0 }]);
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

  it('renders each plan label in the viewer locale (TH), falling back to EN when that locale is missing', () => {
    const thSlice: TierDistributionSlice = {
      tierKey: 'regular-corporate-2026',
      label: { en: 'Regular Corporate', th: 'สมาชิกองค์กรทั่วไป' },
      count: 4,
    };
    const enOnlySlice: TierDistributionSlice = {
      tierKey: 'startup-2026',
      label: { en: 'Start-up' }, // no TH variant → must fall back to EN
      count: 1,
    };
    // locale="th" drives the LocaleText pick; `messages={en}` only backs the
    // static microcopy (the label itself is tenant data, not an i18n key).
    render(
      <NextIntlClientProvider locale="th" messages={en}>
        <MembershipTierChart slices={[thSlice, enOnlySlice]} />
      </NextIntlClientProvider>,
    );
    const table = screen.getByRole('table');
    expect(within(table).getByRole('rowheader', { name: 'สมาชิกองค์กรทั่วไป' })).toBeInTheDocument();
    // The localised plan's EN name is NOT shown when TH is present.
    expect(within(table).queryByRole('rowheader', { name: 'Regular Corporate' })).not.toBeInTheDocument();
    // The EN-only plan falls back to its EN name (never blank, never the key).
    expect(within(table).getByRole('rowheader', { name: 'Start-up' })).toBeInTheDocument();
  });
});
