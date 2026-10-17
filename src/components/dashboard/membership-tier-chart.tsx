/**
 * F9 (067-dashboard-interactive-charts) Task 10 — Membership-by-Tier
 * horizontal bar. Renders the dashboard snapshot's `tierDistribution` slices
 * (already sorted count-desc with `unassigned` forced last by
 * `groupActiveMembersByTier` — this component does NOT re-sort) as a
 * single-colour (`--aura-chart-1`) horizontal bar list, with an end-of-row
 * count+% label.
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
 * chart, see `chart-data-table.tsx`'s docblock): the visual rows are
 * `aria-hidden="true"`; the real data path is the shared `<ChartDataTable>`,
 * which always includes a "Total" row (design doc: "hidden table: tier →
 * count, % (+ total row)").
 *
 * Spec 122 US11 (parity, 17 Oct): the rows follow board `Admin-dashboard` —
 * a label column, a track holding the bar, then "count (pct)" in a fixed end
 * column — drawn as plain grid rows rather than a recharts canvas. The bars
 * are still horizontal and single-colour, the count and percent are printed
 * on every row (so the old hover tooltip carried nothing extra), and the
 * card no longer loads recharts at all.
 */
'use client';

import { useTranslations, useLocale } from 'next-intl';
import { Card } from '@jirawatpyk/aura-react';
import { CHART_HERO_GROUP, CHART_HERO_ROW, CHART_HERO_VALUE } from './chart-card-type';
import type { TierDistributionSlice } from '@/modules/insights';
import { ChartDataTable } from './chart-data-table';

/** One visual row: `displayLabel` is the (possibly translated) tier name,
 * `barLabel` the pre-formatted "count (pct%)" end label. */
interface TierRow {
  readonly tierKey: string;
  readonly displayLabel: string;
  readonly count: number;
  readonly pctLabel: string;
  readonly barLabel: string;
}

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

export function MembershipTierChart({ slices }: MembershipTierChartProps) {
  const t = useTranslations('admin.dashboard.membershipTier');
  const locale = useLocale();

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

  // Bar length is relative to the LARGEST tier (the longest bar fills the
  // track); the printed percent stays of the active total (`formatPct`).
  const max = rows.reduce((m, r) => Math.max(m, r.count), 0);

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
    <Card title={t('title')} headingLevel={2}>
      {!hasData ? (
        <p className="aura-text-body text-[var(--aura-fg-secondary)]">{t('empty')}</p>
      ) : (
        <>
          {/* Headline stat: the active-member total the bars sum to, at the
              KPI tiles' scale (`CHART_HERO_VALUE`), plus the top tier as a
              secondary chip — the same summary+chip+label layout as
              `MiniSeriesChart`. */}
          <div className={CHART_HERO_ROW}>
            <span className={CHART_HERO_GROUP}>
              <span className={CHART_HERO_VALUE}>{numberFmt.format(total)}</span>
              {topTierChipLabel ? (
                <span className="aura-text-caption font-medium text-[var(--aura-fg-secondary)]">
                  {topTierChipLabel}
                </span>
              ) : null}
            </span>
            <span className="text-right aura-text-caption text-[var(--aura-fg-secondary)]">
              {t('activeMembersLabel')}
            </span>
          </div>
          <ol
            aria-hidden="true"
            data-slot="tier-rows"
            className="mt-[var(--aura-space-4)] grid gap-[var(--aura-space-3)] aura-text-body"
          >
            {rows.map((r) => (
              <li
                key={r.tierKey}
                className="grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)_auto] items-center gap-[var(--aura-space-3)]"
              >
                <span className="min-w-0 text-[var(--aura-fg-primary)] [overflow-wrap:anywhere]">
                  {r.displayLabel}
                </span>
                <span className="h-2 overflow-hidden rounded-full bg-[var(--aura-bg-canvas)]">
                  <span
                    data-slot="tier-bar"
                    className="block h-full min-w-0.5 rounded-full bg-[var(--aura-chart-1)]"
                    style={{ width: `${max > 0 ? Math.round((r.count / max) * 100) : 0}%` }}
                  />
                </span>
                <span className="whitespace-nowrap text-right tabular-nums text-[var(--aura-fg-primary)]">
                  {r.barLabel}
                </span>
              </li>
            ))}
          </ol>
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
    </Card>
  );
}
