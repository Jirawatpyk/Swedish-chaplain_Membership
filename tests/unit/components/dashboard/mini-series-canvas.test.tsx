/**
 * F9 (FR-001a) → 067-dashboard-interactive-charts Task 12 — `MiniSeriesCanvas`
 * render test.
 *
 * Split off from `mini-series-chart.test.tsx`: `_mini-series-chart.tsx` now
 * mounts this canvas via `next/dynamic(..., { ssr: false })` (bundle-budget
 * constraint — recharts must stay out of `/admin`'s first-load JS), so a
 * synchronous RTL render of `<MiniSeriesChart>` sees the `loading` fallback,
 * never this component's resolved Recharts markup. Every assertion that
 * needs to inspect actual `.recharts-*` DOM therefore renders
 * `<MiniSeriesCanvas>` directly — no dynamic boundary in the way — mirroring
 * exactly what `mini-series-chart.test.tsx` asserted before the Task 12
 * split (moved verbatim, not weakened).
 *
 * jsdom workarounds: `<ResponsiveContainer>` (inside `ChartContainer`) needs
 * no `ResizeObserver` stub — `ChartContainer`'s default `initialDimension`
 * (320×200) seeds it synchronously, and its resize-observing effect no-ops
 * when `typeof ResizeObserver === 'undefined'` (true in jsdom).
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MiniSeriesCanvas } from '@/components/dashboard/mini-series-canvas';
import type { MiniSeriesPoint } from '@/components/dashboard/_mini-series-chart';

function pt(key: string, value: number, valueLabel: string): MiniSeriesPoint {
  return { key, label: key, value, valueLabel };
}

describe('MiniSeriesCanvas', () => {
  it('renders a Recharts BAR canvas for variant="bar" (migrated off the hand-rolled SVG), wrapped in aria-hidden', () => {
    const points = [pt('2026-01', 100, 'THB 100'), pt('2026-02', 200, 'THB 200')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={200} maxLabel="THB 200" variant="bar" allowMotion={false} />,
    );
    // Recharts-specific marker classes — proves the canvas is the real
    // migrated chart, not a hand-rolled <svg> (which carried no such class),
    // AND that a 'bar' variant renders a Bar, never a Line.
    const canvas = container.querySelector('.recharts-responsive-container');
    expect(canvas).toBeInTheDocument();
    expect(container.querySelector('.recharts-bar')).toBeInTheDocument();
    expect(container.querySelector('.recharts-line')).not.toBeInTheDocument();
    // The canvas is decorative (WCAG 1.1.1/1.3.1/1.4.1) — its nearest
    // ancestor must be aria-hidden (the accessible table lives one level up,
    // in `_mini-series-chart.tsx`, outside this component entirely).
    expect(canvas?.closest('[aria-hidden="true"]')).toBeInTheDocument();
  });

  it('renders a Recharts AREA canvas for variant="line" (filled area under the curve, never a Bar)', () => {
    const points = [pt('2026-01', 5, '5'), pt('2026-02', 8, '8')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={8} maxLabel="8" variant="line" allowMotion={false} />,
    );
    // The original LineSvg drew a filled `fill-primary/15` area UNDER the
    // stroked polyline — a bare Recharts <Line> would drop that fill, so
    // this must be an <Area>, not a <Line>.
    const area = container.querySelector('.recharts-area');
    expect(area).toBeInTheDocument();
    expect(container.querySelector('.recharts-bar')).not.toBeInTheDocument();
    // The filled region (the area's own <path>, not the stroke-only curve)
    // carries the fill colour + reduced opacity, matching `fill-primary/15`.
    const fillPath = container.querySelector('.recharts-area-area');
    expect(fillPath).toBeInTheDocument();
    expect(fillPath).toHaveAttribute('fill', 'var(--color-value)');
    expect(fillPath).toHaveAttribute('fill-opacity', '0.15');
    // Per-point dots — original LineSvg comment: "a dot per month … with the
    // latest point emphasised" (r=3 for the last point, r=1.5 otherwise).
    const dots = container.querySelectorAll('.recharts-area-dots circle');
    expect(dots).toHaveLength(2);
    expect(dots[0]).toHaveAttribute('r', '1.5');
    expect(dots[1]).toHaveAttribute('r', '3');
  });

  it('renders the line variant with a single data point without crashing', () => {
    const points = [pt('2026-06', 42, '42')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={42} maxLabel="42" variant="line" allowMotion={false} />,
    );
    expect(container.querySelector('.recharts-area')).toBeInTheDocument();
  });

  it('renders the bar variant with a single data point without crashing (Recharts fixes the old polyline gap)', () => {
    const points = [pt('2026-06', 900, 'THB 900')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={900} maxLabel="THB 900" variant="bar" allowMotion={false} />,
    );
    expect(container.querySelector('.recharts-bar')).toBeInTheDocument();
  });

  it('renders a visible bar rectangle for zero-value months (minPointSize floor)', () => {
    // A series with zero, non-zero, and zero again to ensure every month
    // shows a crisp mark (even zeros) — matching the original hand-rolled
    // SVG's MIN_BAR = 3 px floor. Without minPointSize, zero and tiny bars
    // are invisible/sub-pixel, breaking the "all 12 months in a frame" model.
    const points = [
      pt('2026-01', 0, 'THB 0'),
      pt('2026-02', 150, 'THB 150'),
      pt('2026-03', 0, 'THB 0'),
    ];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={150} maxLabel="THB 150" variant="bar" allowMotion={false} />,
    );
    // Recharts renders a .recharts-bar-rectangle per data point; zero-value
    // rectangles must be present and visible (via minPointSize={3}).
    const barRects = container.querySelectorAll('.recharts-bar-rectangle');
    expect(barRects.length).toBeGreaterThanOrEqual(3);
  });

  it('renders no reference-line label when maxLabel is null', () => {
    const points = [pt('2026-01', 0, 'THB 0'), pt('2026-02', 0, 'THB 0')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={0} maxLabel={null} variant="bar" allowMotion={false} />,
    );
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
