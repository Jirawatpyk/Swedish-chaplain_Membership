/**
 * F9 (FR-001a) → 067-dashboard-interactive-charts Task 9 — `MiniSeriesChart`
 * render test, extended for the Recharts migration (review-gap: the
 * self-built SVG redesign had zero behavioural coverage at any layer).
 *
 * `_mini-series-chart.tsx` is now `'use client'` (Recharts is client-only)
 * and swaps the hand-rolled `<svg>` for a Recharts chart — `variant="bar"`
 * (revenue trend) renders a `<BarChart><Bar/></BarChart>`, `variant="line"`
 * (member growth) renders a `<LineChart><Line/></LineChart>` — preserving
 * each caller's original chart TYPE (the old `BarSvg` drew `<rect>` bars,
 * `LineSvg` drew a `<polyline>`; a bar series rendered as a line would be a
 * visual regression). Every existing annotation living OUTSIDE the chart
 * canvas is kept:
 *   - empty state (all-zero points → emptyLabel, no chart/table)
 *   - full series (summary stat + accessible <table> equivalent + range labels)
 *   - sparse hint (< SPARSE_THRESHOLD non-zero months)
 *   - single-point series for BOTH variants (no crash — the old hand-rolled
 *     'bar' variant had no special-case guard for a length-1 series; Recharts
 *     handles it natively)
 *   - delta chip (▲/▼ glyph + text, not colour-only — WCAG 1.4.1)
 *
 * A11y model (shared with every 067 chart, see `chart-data-table.tsx`): the
 * Recharts canvas sits in an `aria-hidden="true"` wrapper; the shared
 * `<ChartDataTable>` is the sole SR/no-JS data path — asserted directly by
 * row count here (not by the SVG's internal geometry, which jsdom can't lay
 * out).
 *
 * **Task 12 split**: the actual Recharts canvas (`<BarChart>`/`<AreaChart>`)
 * was extracted into `./mini-series-canvas.tsx` and is now mounted here via
 * `next/dynamic(..., { ssr: false })` so recharts stays out of `/admin`'s
 * first-load JS. A synchronous RTL `render()` therefore sees the `loading`
 * fallback (`<ChartSkeleton>`), never the resolved Recharts markup — so
 * every assertion that used to inspect `.recharts-*` DOM here moved to
 * `mini-series-canvas.test.tsx`, which renders `<MiniSeriesCanvas>` directly
 * (no dynamic boundary in the way). Everything that renders OUTSIDE that
 * boundary (summary stat, delta chip, range labels, sparse hint, empty
 * state, the accessible `<ChartDataTable>`) is unaffected and stays here.
 *
 * jsdom workarounds:
 *   - `window.matchMedia` — the component reads `prefers-reduced-motion` via
 *     `useSyncExternalStore`; jsdom has NO `matchMedia` implementation at
 *     all (throws `TypeError: … is not a function`), so every test stubs it.
 *
 * The `max === 0` division guard in the old BarSvg/LineSvg is moot post-
 * migration (Recharts owns the scale math); the all-zero case is still the
 * empty state, asserted below.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import {
  MiniSeriesChart,
  type MiniSeriesPoint,
} from '@/components/dashboard/_mini-series-chart';

function pt(key: string, value: number, valueLabel: string): MiniSeriesPoint {
  return { key, label: key, value, valueLabel };
}

const BASE = {
  title: 'Revenue trend',
  emptyLabel: 'No paid revenue recorded yet.',
  labelHeader: 'Month',
  valueHeader: 'Amount',
  variant: 'bar' as const,
  summary: { value: 'THB 1,200', label: '12-month total' },
};

/** jsdom has no `matchMedia` at all — stub it so
 * `useSyncExternalStore(subscribeMotionPreference, getAllowMotion, …)` can
 * read a `MediaQueryList`-shaped value instead of throwing. Defaults to
 * "does not prefer reduced motion" (`matches: false`); no test in this file
 * needs to flip it — that's the E2E reduced-motion spec's job (Task 14). */
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

describe('MiniSeriesChart', () => {
  it('renders the empty state (no chart, no table) when every point is zero', () => {
    const points = [pt('2026-01', 0, 'THB 0'), pt('2026-02', 0, 'THB 0')];
    render(<MiniSeriesChart {...BASE} points={points} />);
    expect(screen.getByText('No paid revenue recorded yet.')).toBeInTheDocument();
    // No accessible data-table + no summary stat + no chart canvas when there is no data.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('THB 1,200')).not.toBeInTheDocument();
  });

  it('renders the accessible table (never aria-hidden) for a real series, regardless of the canvas dynamic-loading state', () => {
    // Task 12: the canvas is now a `next/dynamic(..., { ssr: false })`
    // boundary (`./mini-series-canvas`) — a synchronous RTL render sees its
    // `loading` fallback, not the resolved Recharts markup (see
    // `mini-series-canvas.test.tsx` for the recharts-primitive assertions).
    // The accessible table renders OUTSIDE that boundary and must be
    // unaffected either way.
    const points = [pt('2026-01', 100, 'THB 100'), pt('2026-02', 200, 'THB 200')];
    render(<MiniSeriesChart {...BASE} variant="bar" points={points} />);
    const table = screen.getByRole('table');
    expect(table).not.toHaveAttribute('aria-hidden');
    expect(within(table).getAllByRole('row')).toHaveLength(3); // header + 2 data
  });

  it('renders the summary stat + accessible <table> equivalent for a full series', () => {
    const points = Array.from({ length: 12 }, (_, i) =>
      pt(`2026-${String(i + 1).padStart(2, '0')}`, (i + 1) * 100, `THB ${(i + 1) * 100}`),
    );
    render(<MiniSeriesChart {...BASE} caption="Per month" points={points} />);
    expect(screen.getByText('THB 1,200')).toBeInTheDocument(); // summary
    expect(screen.getByText('Per month')).toBeInTheDocument(); // caption
    expect(screen.queryByText(BASE.emptyLabel)).not.toBeInTheDocument();
    // Accessible equivalent present with a row per data point.
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    // header row + 12 data rows = 13.
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    // Scope to the table — the max-value label may also appear on the
    // Recharts reference-line inside the (separately asserted) aria-hidden canvas.
    expect(within(table).getByText('THB 1200')).toBeInTheDocument();
    // First→last range labels (also appear as table-row headers → ≥1 match).
    expect(screen.getAllByText('2026-01').length).toBeGreaterThan(0);
    expect(screen.getAllByText('2026-12').length).toBeGreaterThan(0);
  });

  it('shows the sparse hint when fewer than 3 months carry data', () => {
    const points = [
      pt('2026-01', 0, 'THB 0'),
      pt('2026-02', 500, 'THB 500'),
      pt('2026-03', 0, 'THB 0'),
    ];
    render(
      <MiniSeriesChart {...BASE} sparseLabel="Limited history — builds up over time." points={points} />,
    );
    expect(screen.getByText('Limited history — builds up over time.')).toBeInTheDocument();
  });

  it('does NOT show the sparse hint once 3+ months carry data', () => {
    const points = [
      pt('2026-01', 100, 'THB 100'),
      pt('2026-02', 200, 'THB 200'),
      pt('2026-03', 300, 'THB 300'),
    ];
    render(
      <MiniSeriesChart {...BASE} sparseLabel="Limited history — builds up over time." points={points} />,
    );
    expect(screen.queryByText('Limited history — builds up over time.')).not.toBeInTheDocument();
  });

  it('renders the line variant with a single data point without crashing', () => {
    // The Recharts-primitive assertion (`.recharts-area` presence) for this
    // exact single-point fixture moved to `mini-series-canvas.test.tsx` —
    // the canvas is behind a dynamic(ssr:false) boundary here (Task 12).
    const points = [pt('2026-06', 42, '42')];
    render(
      <MiniSeriesChart
        {...BASE}
        variant="line"
        summary={{ value: '42', label: 'Total members' }}
        points={points}
      />,
    );
    // '42' appears as both the summary stat and the single table-row cell.
    expect(screen.getAllByText('42').length).toBeGreaterThan(0);
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(2); // header + 1 datum
  });

  it('renders the bar variant with a single data point without crashing', () => {
    // The Recharts-primitive assertion (`.recharts-bar` presence) for this
    // exact single-point fixture moved to `mini-series-canvas.test.tsx`.
    const points = [pt('2026-06', 900, 'THB 900')];
    render(
      <MiniSeriesChart
        {...BASE}
        variant="bar"
        summary={{ value: 'THB 900', label: '12-month total' }}
        points={points}
      />,
    );
    expect(screen.getAllByText('THB 900').length).toBeGreaterThan(0);
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('includes zero-value months in the accessible table alongside non-zero ones', () => {
    // The Recharts-primitive assertion (`.recharts-bar-rectangle` / the
    // minPointSize floor that keeps zero-value bars visible) moved to
    // `mini-series-canvas.test.tsx`. This test keeps the chart-level
    // guarantee: the table must never silently drop a zero-value point.
    const points = [
      pt('2026-01', 0, 'THB 0'),
      pt('2026-02', 150, 'THB 150'),
      pt('2026-03', 0, 'THB 0'),
    ];
    render(
      <MiniSeriesChart
        {...BASE}
        variant="bar"
        summary={{ value: 'THB 150', label: '12-month total' }}
        points={points}
      />,
    );
    const table = screen.getByRole('table');
    expect(table).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(4); // header + 3 data
  });

  it('renders an up delta chip with a ▲ glyph + label (not colour-only)', () => {
    const points = [pt('2026-01', 10, '10'), pt('2026-02', 20, '20')];
    render(
      <MiniSeriesChart
        {...BASE}
        variant="line"
        summary={{ value: '20', label: 'Total members' }}
        delta={{ direction: 'up', label: '+10 this year' }}
        points={points}
      />,
    );
    expect(screen.getByText(/▲\s*\+10 this year/)).toBeInTheDocument();
  });

  it('renders a down delta chip with a ▼ glyph + label (not colour-only)', () => {
    const points = [pt('2026-01', 20, '20'), pt('2026-02', 10, '10')];
    render(
      <MiniSeriesChart
        {...BASE}
        variant="line"
        summary={{ value: '10', label: 'Total members' }}
        delta={{ direction: 'down', label: '-10 this year' }}
        points={points}
      />,
    );
    expect(screen.getByText(/▼\s*-10 this year/)).toBeInTheDocument();
  });
});
