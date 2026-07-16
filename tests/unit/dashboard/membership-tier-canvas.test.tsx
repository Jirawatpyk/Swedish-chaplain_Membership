/**
 * Task 12 (067-dashboard-interactive-charts) — `MembershipTierCanvas` render
 * test.
 *
 * Split off from `membership-tier-chart.test.tsx`: `membership-tier-chart.tsx`
 * now mounts this canvas via `next/dynamic(..., { ssr: false })` (bundle-
 * budget constraint — recharts must stay out of `/admin`'s first-load JS),
 * so a synchronous RTL render of `<MembershipTierChart>` sees the `loading`
 * fallback, never this component's resolved Recharts markup. The Recharts-
 * primitive assertion that used to live in that file's "renders a single,
 * single-colour <Bar>" test moved here verbatim (not weakened) — rendered
 * directly, no dynamic boundary in the way.
 *
 * `allowMotion` is a plain prop on this component (the
 * `useSyncExternalStore(subscribeMotionPreference, …)` reduced-motion read
 * now lives in the caller, `membership-tier-chart.tsx`) — so, unlike the
 * pre-split test, no `window.matchMedia` stub is needed here at all; the
 * react-smooth/rAF timing gap the original test's `stubMatchMedia(true)`
 * worked around is achieved simply by passing `allowMotion={false}` directly.
 *
 * jsdom workarounds: `<ResponsiveContainer>` needs no `ResizeObserver` stub —
 * `ChartContainer`'s default `initialDimension` (320×200) seeds it
 * synchronously.
 */
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MembershipTierCanvas, type TierRow } from '@/components/dashboard/membership-tier-canvas';

const GOLD: TierRow = { tierKey: 'gold-2026', displayLabel: 'Gold', count: 6, pctLabel: '60%', barLabel: '6 (60%)' };
const SILVER: TierRow = {
  tierKey: 'silver-2026',
  displayLabel: 'Silver',
  count: 3,
  pctLabel: '30%',
  barLabel: '3 (30%)',
};
const UNASSIGNED: TierRow = {
  tierKey: 'unassigned',
  displayLabel: 'No plan assigned',
  count: 1,
  pctLabel: '10%',
  barLabel: '1 (10%)',
};

describe('MembershipTierCanvas', () => {
  it('renders a single, single-colour <Bar> — not one <Cell>/colour per slice', () => {
    const rows = [GOLD, SILVER, UNASSIGNED];
    const { container } = render(
      <MembershipTierCanvas rows={rows} max={6} allowMotion={false} countColumnHeader="Members" />,
    );
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
    // End-of-bar "count (pct%)" labels (design doc: "count + % end-labels").
    const labelTexts = Array.from(container.querySelectorAll('.recharts-label-list text')).map(
      (n) => n.textContent,
    );
    expect(labelTexts).toEqual(['6 (60%)', '3 (30%)', '1 (10%)']);
  });

  it('renders a Recharts responsive container (the real migrated chart, not a hand-rolled <svg>)', () => {
    const { container } = render(
      <MembershipTierCanvas rows={[GOLD]} max={6} allowMotion={false} countColumnHeader="Members" />,
    );
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
