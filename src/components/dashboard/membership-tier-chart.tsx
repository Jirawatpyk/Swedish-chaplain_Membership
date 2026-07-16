/**
 * F9 (067-dashboard-interactive-charts) Task 10 — Membership-by-Tier
 * horizontal bar. Renders the dashboard snapshot's `tierDistribution` slices
 * (already sorted count-desc with `unassigned` forced last by
 * `groupActiveMembersByTier` — this component does NOT re-sort) as a
 * single-colour (`--chart-1` navy) Recharts horizontal bar, with an
 * end-of-bar count+% label and a hover tooltip.
 *
 * Self-contained i18n: takes ONLY the `slices` data prop — no title/label
 * props — and resolves all of its own microcopy via `useTranslations`, the
 * same pattern already shipped in `components/renewals/month-bar-chart.tsx`
 * (a `'use client'` chart with zero i18n props). This is safe everywhere
 * (incl. this component's own `next/dynamic` boundary, Task 12) because the
 * root layout wraps the whole app in a single `NextIntlClientProvider` with
 * the full message tree.
 *
 * The ONE domain-owned sentinel (`tierKey === UNASSIGNED_TIER_KEY`) is
 * special-cased to a translated label (`t('unassignedTier')`); every other
 * slice's `label` is a stored plan name shown VERBATIM (design doc decision —
 * tier labels are tenant data, not translatable strings).
 *
 * A11y (WCAG 1.1.1 / 1.3.1 / 1.4.1 — the same model shared by every 067
 * chart, see `chart-data-table.tsx`'s docblock): the Recharts canvas sits in
 * an `aria-hidden="true"` wrapper with `accessibilityLayer={false}`; the real
 * data path is the shared `<ChartDataTable>`, which always includes a
 * "Total" row (design doc: "hidden table: tier → count, % (+ total row)").
 *
 * Reduced motion: shares `./use-motion-preference` with `_mini-series-chart`
 * (same SSR-safe `useSyncExternalStore` triad, extracted in this task so
 * neither chart file duplicates the `matchMedia` idiom).
 */
'use client';

import { useTranslations } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Bar, BarChart, LabelList, XAxis, YAxis } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { TierDistributionSlice } from '@/modules/insights/domain/dashboard-snapshot';
import { UNASSIGNED_TIER_KEY } from '@/modules/insights/domain/tier-distribution';
import { ChartDataTable } from './chart-data-table';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

export interface MembershipTierChartProps {
  /** Already sorted count-desc with `unassigned` forced last (Task 3's
   * `groupActiveMembersByTier`) — this component renders them in the given
   * order and does NOT re-sort. */
  readonly slices: readonly TierDistributionSlice[];
}

/** Row shape fed to Recharts — `displayLabel` is the (possibly translated)
 * text shown on the Y axis + tooltip; `barLabel` is the pre-formatted
 * "count (pct%)" end-of-bar label (a plain data field, not a Recharts
 * `formatter`, so `<LabelList>` needs no canvas-measuring render function). */
interface TierRow {
  readonly tierKey: string;
  readonly displayLabel: string;
  readonly count: number;
  readonly pctLabel: string;
  readonly barLabel: string;
}

/** % is always of the ACTIVE TOTAL (sum of every slice's count) — never a
 * per-bar-relative-to-max reading, which would misrepresent composition. */
function formatPct(count: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

interface TierTooltipPayloadEntry {
  readonly payload?: TierRow;
}

/** Custom tooltip — reads the ORIGINAL `TierRow` off the hovered payload
 * entry directly (its resolved `displayLabel` + pre-formatted `barLabel`),
 * mirroring `_mini-series-chart.tsx`'s `SeriesTooltipContent`: shadcn's
 * config/nameKey-driven `ChartTooltipContent` is built for multi-series/
 * legend charts, not this single-series bar. Never the sole way to read a
 * value — the hidden `<ChartDataTable>` below is. */
function TierTooltipContent({
  active,
  payload,
}: {
  readonly active?: boolean;
  readonly payload?: readonly TierTooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{row.displayLabel}</span>
      <span className="text-muted-foreground">{row.barLabel}</span>
    </div>
  );
}

const CHART_MARGIN = { top: 4, right: 44, bottom: 4, left: 4 };
/** Per-row plot height (px) — a horizontal bar list scales with the number of
 * tiers (up to ~9 per the design doc), unlike the sparklines' fixed height. */
const ROW_HEIGHT_PX = 36;
const MIN_CHART_HEIGHT_PX = 120;

export function MembershipTierChart({ slices }: MembershipTierChartProps) {
  const t = useTranslations('admin.dashboard.membershipTier');
  const allowMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getAllowMotion,
    getServerAllowMotion,
  );

  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const hasData = slices.length > 0 && total > 0;

  const rows: TierRow[] = slices.map((s) => {
    const displayLabel = s.tierKey === UNASSIGNED_TIER_KEY ? t('unassignedTier') : s.label;
    const pctLabel = formatPct(s.count, total);
    return {
      tierKey: s.tierKey,
      displayLabel,
      count: s.count,
      pctLabel,
      barLabel: `${s.count} (${pctLabel})`,
    };
  });

  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);
  const chartConfig = {
    count: { label: t('countColumnHeader') },
  } satisfies ChartConfig;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <p className="text-body text-muted-foreground">{t('empty')}</p>
        ) : (
          <>
            <div aria-hidden="true">
              <ChartContainer
                config={chartConfig}
                className="aspect-auto w-full"
                style={{ height: Math.max(MIN_CHART_HEIGHT_PX, rows.length * ROW_HEIGHT_PX) }}
              >
                <BarChart layout="vertical" accessibilityLayer={false} data={rows} margin={CHART_MARGIN}>
                  <YAxis
                    type="category"
                    dataKey="displayLabel"
                    width={110}
                    tickLine={false}
                    axisLine={false}
                    tick={{ fontSize: 12 }}
                  />
                  <XAxis type="number" hide domain={[0, max]} />
                  <ChartTooltip cursor={false} content={<TierTooltipContent />} />
                  {/* Single colour, single <Bar> — never one <Cell>/colour per
                      slice (the design doc rejects per-tier hue: only 5 chart
                      tokens across 2 lightness clusters can't distinguish up
                      to 9 tiers, a CVD fail). */}
                  <Bar
                    dataKey="count"
                    fill="var(--chart-1)"
                    radius={[0, 4, 4, 0]}
                    minPointSize={2}
                    isAnimationActive={allowMotion}
                  >
                    <LabelList dataKey="barLabel" position="right" className="fill-foreground" fontSize={12} />
                  </Bar>
                </BarChart>
              </ChartContainer>
            </div>
            {/* Accessible equivalent (WCAG 1.1.1 / 1.3.1 / 1.4.1) — the sole
                SR/no-JS data path; visually hidden when data is present, the
                empty-state paragraph above is the SR equivalent otherwise.
                Always ends in a "Total" row (design doc requirement). */}
            <ChartDataTable
              caption={t('title')}
              columns={[t('tierColumnHeader'), t('countColumnHeader'), t('pctColumnHeader')]}
              rows={[
                ...rows.map((r) => [r.displayLabel, r.count, r.pctLabel] as const),
                [t('totalRowLabel'), total, '100%'] as const,
              ]}
            />
          </>
        )}
      </CardContent>
    </Card>
  );
}
