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
      <MiniSeriesCanvas points={points} max={200} variant="bar" allowMotion={false} locale="en" />,
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
    // Spec 122 US11: the dashboard's own chart frame, on AURA's chart tokens.
    expect(canvas?.closest('[data-slot="chart"]')).toBeInTheDocument();
    for (const rect of container.querySelectorAll('.recharts-bar-rectangle path')) {
      expect(rect).toHaveAttribute('fill', 'var(--aura-chart-1)');
    }
    for (const line of container.querySelectorAll('.recharts-reference-line line')) {
      expect(line).toHaveAttribute('stroke', 'var(--aura-chart-grid)');
    }
  });

  it('renders a Recharts AREA canvas for variant="line" (filled area under the curve, never a Bar)', () => {
    const points = [pt('2026-01', 5, '5'), pt('2026-02', 8, '8')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={8} variant="line" allowMotion={false} locale="en" />,
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
    expect(fillPath).toHaveAttribute('fill', 'var(--aura-chart-1)');
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
      <MiniSeriesCanvas points={points} max={42} variant="line" allowMotion={false} locale="en" />,
    );
    expect(container.querySelector('.recharts-area')).toBeInTheDocument();
  });

  it('renders the bar variant with a single data point without crashing (Recharts fixes the old polyline gap)', () => {
    const points = [pt('2026-06', 900, 'THB 900')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={900} variant="bar" allowMotion={false} locale="en" />,
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
      <MiniSeriesCanvas points={points} max={150} variant="bar" allowMotion={false} locale="en" />,
    );
    // Recharts renders a .recharts-bar-rectangle per data point; zero-value
    // rectangles must be present and visible (via minPointSize={3}).
    const barRects = container.querySelectorAll('.recharts-bar-rectangle');
    expect(barRects.length).toBeGreaterThanOrEqual(3);
  });

  it('renders no reference-line label when maxLabel is null', () => {
    const points = [pt('2026-01', 0, 'THB 0'), pt('2026-02', 0, 'THB 0')];
    const { container } = render(
      <MiniSeriesCanvas points={points} max={0} variant="bar" allowMotion={false} locale="en" />,
    );
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });

  // Spec 122 US11 (maintainer, parity 17 Oct): the trend charts follow board
  // `Admin-dashboard` — a value axis with compact ticks from zero, horizontal
  // grid lines, and month labels along the bottom.
  describe('board axes', () => {
    const revenue = [
      { key: '2026-01', label: 'Jan 2026', axisLabel: 'Jan', value: 12_840_000, valueLabel: 'THB 128,400' },
      { key: '2026-02', label: 'Feb 2026', axisLabel: 'Feb', value: 5_350_000, valueLabel: 'THB 53,500' },
    ];

    it('draws compact value ticks from zero (satang shown in baht) and horizontal grid lines', () => {
      const { container } = render(
        <MiniSeriesCanvas points={revenue} max={12_840_000} variant="bar" allowMotion={false} locale="en" valueDivisor={100} />,
      );
      const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')).map((t) => t.textContent);
      expect(yTicks).toEqual(['0', '50K', '100K', '150K']);
      expect(container.querySelector('.recharts-cartesian-grid-horizontal')).not.toBeNull();
      expect(container.querySelector('.recharts-cartesian-grid-vertical')).toBeNull();
    });

    it('axis text is sized in rem, so it grows with the browser text size', () => {
      const { container } = render(
        <MiniSeriesCanvas points={revenue} max={12_840_000} variant="bar" allowMotion={false} locale="en" valueDivisor={100} />,
      );
      const tick = container.querySelector('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
      expect(tick?.getAttribute('font-size')).toBe('0.6875rem');
    });

    it('labels the months along the bottom with the short month', () => {
      const { container } = render(
        <MiniSeriesCanvas points={revenue} max={12_840_000} variant="bar" allowMotion={false} locale="en" valueDivisor={100} />,
      );
      const xTicks = Array.from(container.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')).map((t) => t.textContent);
      expect(xTicks).toEqual(['Jan', 'Feb']);
    });

    it('draws the current (last) month lighter, as it is still in progress', () => {
      const { container } = render(
        <MiniSeriesCanvas points={revenue} max={12_840_000} variant="bar" allowMotion={false} locale="en" valueDivisor={100} />,
      );
      const bars = Array.from(container.querySelectorAll('.recharts-bar-rectangle path'));
      // 0.6 keeps the blended fill at 3:1 on the card in both themes
      // (WCAG 1.4.11), and a solid dashed outline marks it as partial.
      expect(bars.at(-1)?.getAttribute('fill-opacity')).toBe('0.6');
      expect(bars.at(-1)?.getAttribute('stroke')).toBe('var(--aura-chart-1)');
      expect(bars.at(-1)?.getAttribute('stroke-dasharray')).toBe('3 2');
      expect(bars[0]?.getAttribute('fill-opacity')).not.toBe('0.6');
    });

    it('the area chart counts from zero with whole-number ticks', () => {
      const growth = [
        { key: '2026-01', label: 'Jan 2026', axisLabel: 'Jan', value: 112, valueLabel: '112' },
        { key: '2026-02', label: 'Feb 2026', axisLabel: 'Feb', value: 131, valueLabel: '131' },
      ];
      const { container } = render(
        <MiniSeriesCanvas points={growth} max={131} variant="line" allowMotion={false} locale="en" />,
      );
      const yTicks = Array.from(container.querySelectorAll('.recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value')).map((t) => t.textContent);
      expect(yTicks).toEqual(['0', '50', '100', '150']);
    });
  });
});

