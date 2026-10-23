/**
 * 124 — the client edge of the Billed vs collected chart: the recharts canvas
 * behind `next/dynamic(..., { ssr: false })` (recharts out of first-load JS),
 * with a same-height skeleton until it loads.
 */
'use client';

import dynamic from 'next/dynamic';
import { ChartSkeleton } from '@/components/dashboard/chart-skeleton';
import type { TrendChartPoint } from './trend-chart-canvas';

const TrendChartCanvas = dynamic(() => import('./trend-chart-canvas').then((m) => m.TrendChartCanvas), {
  ssr: false,
  loading: () => <ChartSkeleton className="h-56" />,
});

export function TrendChart(props: {
  readonly points: readonly TrendChartPoint[];
  readonly locale: string;
  readonly billedName: string;
  readonly collectedName: string;
}) {
  return <TrendChartCanvas {...props} />;
}
