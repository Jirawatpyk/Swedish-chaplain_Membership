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
 * Spec 122 US11 (parity, 17 Oct): the bars are plain grid rows (no recharts
 * canvas, no `next/dynamic` boundary), so a synchronous render sees them.
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

  it('keeps the visual rows aria-hidden, and the table is never aria-hidden', () => {
    // The visual rows are decorative; the accessible table is never hidden.
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
    expect(screen.getByText('Membership by tier', { selector: 'h2.aura-card__title' })).toBeInTheDocument();
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

  // Spec 122 US11 (parity, 17 Oct): the rows follow board `Admin-dashboard` —
  // label column, a track with the bar, then "count (pct)" — drawn as plain
  // rows, not a lazy chart canvas.
  describe('board rows', () => {
    function visualRows(container: HTMLElement) {
      const list = container.querySelector('[data-slot="tier-rows"]');
      expect(list).not.toBeNull();
      return { list: list as HTMLElement, rows: Array.from(list!.querySelectorAll('li')) };
    }

    it('one aria-hidden row per tier with its label and "count (pct)"', () => {
      const { container } = renderChart([GOLD, SILVER]);
      const { list, rows } = visualRows(container);
      expect(list.getAttribute('aria-hidden')).toBe('true');
      expect(rows).toHaveLength(2);
      expect(rows[0]!.textContent).toContain('Gold');
      expect(rows[0]!.textContent).toContain('6 (67%)');
      expect(rows[1]!.textContent).toContain('3 (33%)');
    });

    it('bar width is count over the largest tier, never over the total', () => {
      const { container } = renderChart([GOLD, SILVER]);
      const bars = Array.from(container.querySelectorAll<HTMLElement>('[data-slot="tier-bar"]'));
      expect(bars.map((b) => b.style.width)).toEqual(['100%', '50%']);
    });

    it('every row shares one grid, so the tracks line up', () => {
      const { container } = renderChart([GOLD, SILVER]);
      const { list, rows } = visualRows(container);
      expect(list.className).toContain('grid-cols-');
      rows.forEach((li) => expect(li.className).toContain('sm:contents'));
    });

    it('on phones the track runs full width under the label and count', () => {
      const { container } = renderChart([GOLD]);
      const { rows } = visualRows(container);
      const li = rows[0]!;
      expect(li.className).toContain('grid-cols-[minmax(0,1fr)_auto]');
      const track = li.lastElementChild as HTMLElement;
      expect(track.querySelector('[data-slot="tier-bar"]')).not.toBeNull();
      expect(track.className).toContain('col-span-2');
      expect(track.className).toContain('bg-[var(--aura-border-default)]');
    });

    it('mounts no chart canvas', () => {
      const { container } = renderChart([GOLD, SILVER]);
      expect(container.querySelector('[data-slot="chart"]')).toBeNull();
    });
  });
});
