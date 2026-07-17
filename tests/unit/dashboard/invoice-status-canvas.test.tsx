/**
 * Task 12 (067-dashboard-interactive-charts) — `InvoiceStatusCanvas` render
 * test.
 *
 * Split off from `invoice-status-chart.test.tsx`: `invoice-status-chart.tsx`
 * now mounts this canvas via `next/dynamic(..., { ssr: false })` (bundle-
 * budget constraint — recharts must stay out of `/admin`'s first-load JS),
 * so a synchronous RTL render of `<InvoiceStatusChart>` sees the `loading`
 * fallback, never this component's resolved Recharts markup. The Recharts-
 * primitive assertions that used to live in that file's "renders one
 * <Cell>/sector per bucket" test moved here verbatim (not weakened) —
 * rendered directly, no dynamic boundary in the way.
 *
 * `allowMotion` is a plain prop on this component (the
 * `useSyncExternalStore(subscribeMotionPreference, …)` reduced-motion read
 * now lives in the caller, `invoice-status-chart.tsx`) — so, unlike the
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
import { InvoiceStatusCanvas } from '@/components/dashboard/invoice-status-canvas';
import type { BucketRow } from '@/components/dashboard/invoice-status-chart';

const ROWS: readonly BucketRow[] = [
  {
    bucket: 'paid',
    label: 'Paid',
    satangNumber: 500000,
    amountLabel: 'THB 5,000',
    count: 5,
    countLabel: '5 invoices',
    pctLabel: '50%',
  },
  {
    bucket: 'unpaid',
    label: 'Unpaid',
    satangNumber: 300000,
    amountLabel: 'THB 3,000',
    count: 3,
    countLabel: '3 invoices',
    pctLabel: '30%',
  },
  {
    bucket: 'overdue',
    label: 'Overdue',
    satangNumber: 200000,
    amountLabel: 'THB 2,000',
    count: 2,
    countLabel: '2 invoices',
    pctLabel: '20%',
  },
];

describe('InvoiceStatusCanvas', () => {
  it('renders one <Cell>/sector per bucket with 3 distinct semantic fills', () => {
    const { container } = render(<InvoiceStatusCanvas rows={ROWS} allowMotion={false} />);
    const sectors = container.querySelectorAll('.recharts-pie-sector');
    expect(sectors).toHaveLength(3);
    const fills = Array.from(container.querySelectorAll('.recharts-pie-sector path')).map((p) =>
      p.getAttribute('fill'),
    );
    expect(fills).toEqual(['var(--success)', 'var(--warning)', 'var(--destructive)']);
  });

  it('renders a Recharts responsive container (the real migrated donut, not a hand-rolled <svg>)', () => {
    const { container } = render(<InvoiceStatusCanvas rows={ROWS} allowMotion={false} />);
    expect(container.querySelector('.recharts-responsive-container')).toBeInTheDocument();
  });
});
