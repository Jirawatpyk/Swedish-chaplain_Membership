/**
 * F9 (FR-001a) — `MiniSeriesChart` render test (review-gap: the self-built SVG
 * redesign had zero behavioural coverage at any layer).
 *
 * Pure presentational server component (no client hooks), so a jsdom render
 * exercises every branch the e2e structural smoke test can't drive:
 *   - empty state (all-zero points → emptyLabel, no chart table)
 *   - full series (summary stat + accessible <table> equivalent + range labels)
 *   - sparse hint (< SPARSE_THRESHOLD non-zero months)
 *   - single-point line variant (no polyline / no crash)
 *   - delta chip (▲/▼ glyph + text, not colour-only — WCAG 1.4.1)
 *
 * The `max === 0` division guard in BarSvg/LineSvg is unreachable once rendered
 * (`hasData` requires some `value > 0`, which forces `max > 0`); the all-zero
 * case is the empty state, asserted below.
 */
import { describe, expect, it } from 'vitest';
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

describe('MiniSeriesChart', () => {
  it('renders the empty state (no chart table) when every point is zero', () => {
    const points = [pt('2026-01', 0, 'THB 0'), pt('2026-02', 0, 'THB 0')];
    render(<MiniSeriesChart {...BASE} points={points} />);
    expect(screen.getByText('No paid revenue recorded yet.')).toBeInTheDocument();
    // No accessible data-table + no summary stat when there is no data.
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByText('THB 1,200')).not.toBeInTheDocument();
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
    // Scope to the table — 'THB 1200' is also the SVG max-gridline label.
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
    expect(screen.getByRole('table')).toBeInTheDocument();
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
});
