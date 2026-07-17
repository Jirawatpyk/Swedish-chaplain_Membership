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
 *
 * **Lazy canvas boundary (Task 12 — bundle-budget constraint):** the actual
 * `<BarChart>` rendering lives in `./membership-tier-canvas` and is mounted
 * here via `next/dynamic(..., { ssr: false })`, so recharts never lands in
 * `/admin`'s first-load JS. This file still computes `rows` (needed for
 * both the canvas AND the accessible table below) and renders the table +
 * empty state eagerly. CLS: the canvas's height is DATA-DEPENDENT (scales
 * with tier count), so the definite-height wrapper div lives HERE (computed
 * synchronously from `rows.length`, known before the dynamic import ever
 * resolves) — both the `loading` skeleton and the resolved canvas simply
 * fill `h-full w-full` of that wrapper, so the height never changes across
 * the swap.
 */
'use client';

import dynamic from 'next/dynamic';
import { useTranslations, useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { TierDistributionSlice } from '@/modules/insights';
import { ChartDataTable } from './chart-data-table';
import { ChartSkeleton } from './chart-skeleton';
import type { TierRow } from './membership-tier-canvas';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

const MembershipTierCanvas = dynamic(
  () => import('./membership-tier-canvas').then((m) => m.MembershipTierCanvas),
  { ssr: false, loading: () => <ChartSkeleton className="h-full" /> },
);

export interface MembershipTierChartProps {
  /** Already sorted count-desc with `unassigned` forced last (Task 3's
   * `groupActiveMembersByTier`) — this component renders them in the given
   * order and does NOT re-sort. */
  readonly slices: readonly TierDistributionSlice[];
}

/** % is always of the ACTIVE TOTAL (sum of every slice's count) — never a
 * per-bar-relative-to-max reading, which would misrepresent composition. */
function formatPct(count: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((count / total) * 100)}%`;
}

/** Per-row plot height (px) — a horizontal bar list scales with the number of
 * tiers (up to ~9 per the design doc), unlike the sparklines' fixed height. */
const ROW_HEIGHT_PX = 36;
const MIN_CHART_HEIGHT_PX = 120;

export function MembershipTierChart({ slices }: MembershipTierChartProps) {
  const t = useTranslations('admin.dashboard.membershipTier');
  const locale = useLocale();
  const allowMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getAllowMotion,
    getServerAllowMotion,
  );

  const total = slices.reduce((sum, s) => sum + s.count, 0);
  const hasData = slices.length > 0 && total > 0;

  // next-intl locale → LocaleText key (this app's locales are exactly en/th/sv).
  const localeKey = locale === 'th' || locale === 'sv' ? locale : 'en';

  const rows: TierRow[] = slices.map((s) => {
    // 'unassigned' === UNASSIGNED_TIER_KEY (insights domain). Compared as a
    // literal because a client component cannot runtime-import the insights
    // barrel — it pulls server-only infra (revalidateTag) into the client
    // bundle. The domain constant's value is pinned by its own unit test
    // (tests/unit/insights/domain/tier-distribution.test.ts) as the drift
    // guard, so this literal cannot silently go stale.
    //
    // `label` is the plan name in every stored locale (F2 `plan_name`); pick
    // the viewer's, falling back to the always-present `en`. Inlined rather
    // than `@/modules/plans`'s `pickLocaleText` for the same bundle reason —
    // that helper is a runtime value in the plans module graph.
    const localized = s.label[localeKey];
    const displayLabel =
      s.tierKey === 'unassigned'
        ? t('unassignedTier')
        : localized && localized.trim().length > 0
          ? localized
          : s.label.en;
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
  const chartHeightPx = Math.max(MIN_CHART_HEIGHT_PX, rows.length * ROW_HEIGHT_PX);

  // Headline stat (enterprise-detail parity with the sparklines' KPI-sized
  // summary stat — see `_mini-series-chart.tsx`) — locale-aware count, the
  // same convention as the KPI cards / `InvoiceStatusChart`'s `thbFmt`.
  const numberFmt = new Intl.NumberFormat(locale);
  // Secondary chip next to the headline: the top REAL tier (never the
  // `unassigned` sentinel — see the literal-comparison note above; a
  // "Top: No plan assigned" chip would read as noise, not insight).
  // `noUncheckedIndexedAccess` makes `rows[0]` possibly `undefined`; folding
  // the whole check + the label build into one expression (rather than a
  // separate boolean flag consulted later) lets TS narrow `topSlice` here.
  const topSlice = rows[0];
  const topTierChipLabel =
    topSlice && topSlice.tierKey !== 'unassigned'
      ? t('topTier', { tier: topSlice.displayLabel, pct: topSlice.pctLabel })
      : null;

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
            {/* Headline stat (enterprise-detail parity with the sparklines'
                KPI-sized summary stat) — the active-member total the bars
                sum to, at the SAME `text-3xl` "dashboard hero number" scale
                as `KpiCard`/`MiniSeriesChart`'s summary (ux-standards.md's
                type-scale table), plus the top tier as a secondary chip —
                mirrors the summary+chip+label layout used there. */}
            <div className="flex items-baseline justify-between gap-2">
              <span className="flex items-baseline gap-2">
                <span className="text-3xl tabular-nums">{numberFmt.format(total)}</span>
                {topTierChipLabel ? (
                  <span className="text-caption font-medium text-muted-foreground">
                    {topTierChipLabel}
                  </span>
                ) : null}
              </span>
              <span className="text-right text-caption text-muted-foreground">
                {t('activeMembersLabel')}
              </span>
            </div>
            <div aria-hidden="true" className="mt-3" style={{ height: chartHeightPx }}>
              <MembershipTierCanvas
                rows={rows}
                max={max}
                allowMotion={allowMotion}
                countColumnHeader={t('countColumnHeader')}
              />
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
