/**
 * F9 (067-dashboard-interactive-charts) Task 11 — Invoice value by status.
 * Renders the dashboard snapshot's `invoiceStatus` distribution (paid /
 * unpaid / overdue buckets + `draftCount`, already computed net-of-credit,
 * VAT-inclusive per the design doc — this component does no money math of
 * its own beyond satang→THB display formatting), always ordered
 * **paid → unpaid → overdue** (CVD spacing: amber sits between green/red).
 *
 * Spec 122 US11 follow-up (maintainer, 17 Oct): the card follows board
 * `Admin-dashboard` — the exact total as the headline, one stacked bar, and
 * a row per bucket with its amount and percent. It replaces the recharts
 * donut, its compact centre total and its legend. Every figure is one the
 * card already computed for its hidden table and the old tooltip.
 *
 * Money: `satang` on each bucket is a decimal-free integer string
 * (`bigint.toString()` from `compute-dashboard-snapshot.ts`). `Number(...)`
 * is safe here — THB amounts are far below `Number.MAX_SAFE_INTEGER` (the
 * same reasoning `satangToProcessorAmount` documents in `src/lib/money.ts`).
 * This card prints amounts to TWO decimals (financial review, 17 Oct): with
 * whole baht the three rows could miss the headline by ฿1 (12,345.50 +
 * 987.50 + 43.50 shows ฿13,378 against a ฿13,377 total). The other cards on
 * the page keep whole baht; money is never redistributed to make it add up.
 *
 * A11y (WCAG 1.1.1 / 1.3.1 / 1.4.1 — the same model shared by every 067
 * chart, see `chart-data-table.tsx`'s docblock): the bar and the rows are
 * `aria-hidden`; the hidden `<ChartDataTable>` is the SR/no-JS data path,
 * always ending in a "Total" row. The headline total and the draft caption
 * are real DOM text. Colour is never the sole signal: every row and table
 * row carries the bucket's label.
 */
'use client';

import { Fragment, type ReactNode } from 'react';
import { useTranslations, useLocale } from 'next-intl';
import { Card } from '@jirawatpyk/aura-react';
import type { InvoiceStatusBucket, InvoiceStatusDistribution } from '@/modules/insights';
import { CHART_HERO_GROUP, CHART_HERO_ROW, CHART_HERO_VALUE } from './chart-card-type';
import { ChartDataTable } from './chart-data-table';

export interface InvoiceStatusChartProps {
  readonly distribution: InvoiceStatusDistribution;
}

/** Fixed render order (design doc: CVD spacing — amber between green/red),
 * never the raw array order the port happens to return. */
const BUCKET_ORDER = ['paid', 'unpaid', 'overdue'] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

/** Semantic (not categorical) colour — the bucket IS a state, not an
 * arbitrary series identity. Fills the bar segments and the row dots. */
const BUCKET_FILL: Record<Bucket, string> = {
  paid: 'var(--aura-fg-positive)',
  unpaid: 'var(--aura-alert-warning-fg)',
  overdue: 'var(--aura-fg-danger)',
};

/** One bucket — `satangNumber` sizes its bar segment (VALUE basis, never
 * count); every other field is display-ready text for the row and table. */
interface BucketRow {
  readonly bucket: Bucket;
  readonly label: string;
  readonly satangNumber: number;
  readonly amountLabel: string;
  /** `amountLabel` with ordinary spaces, for the visible row. */
  readonly visibleAmount: string;
  readonly count: number;
  readonly pctLabel: string;
}

/** Joins Intl's currency parts with ordinary spaces so a long amount wraps
 * between currency and number at 200% text (the KPI tile does the same). */
function formatWrapping(fmt: Intl.NumberFormat, n: number): string {
  return fmt
    .formatToParts(n)
    .map((p) => (p.type === 'literal' ? p.value.replace(/\u00a0|\u202f/g, ' ') : p.value))
    .join('');
}

/** The headline amount with its only break points: the space before or
 * after the currency, and a `<wbr>` after each thousands group. A long
 * amount at 200% text then wraps as "THB 4,977,<wbr>300.00", never inside
 * a group, which would read as another amount (UX review, 17 Oct). */
function formatHeadline(fmt: Intl.NumberFormat, n: number): ReactNode {
  return fmt.formatToParts(n).map((p, i) =>
    p.type === 'literal' ? (
      <Fragment key={i}>{p.value.replace(/\u00a0|\u202f/g, ' ')}</Fragment>
    ) : p.type === 'group' ? (
      <Fragment key={i}>
        {p.value}
        <wbr />
      </Fragment>
    ) : (
      <Fragment key={i}>{p.value}</Fragment>
    ),
  );
}

function zeroBucket(bucket: Bucket): InvoiceStatusBucket {
  return { bucket, satang: '0', count: 0 };
}

/** Largest-remainder ("Hare quota") allocation — NOT independent
 * `Math.round(n / total * 100)` per bucket. Three shares rounded
 * independently can land on e.g. 33/33/33 (sum 99) or 34/34/34 (sum 101)
 * for a total that isn't a clean multiple of the bucket count, which then
 * contradicts the hard-coded "100%" Total row. This guarantees the returned
 * integers always sum to exactly 100 whenever `total > 0`: floor every raw
 * share, then hand the leftover percentage points (an integer, since it's
 * 100 minus a sum of integers) one-by-one to the buckets with the largest
 * fractional remainder, tie-broken by original index for determinism. */
function allocatePercentages(values: readonly number[]): number[] {
  // Track B — a NEGATIVE input must yield all-zeros, not a negative share.
  // `total <= 0` alone does not cover it: mixed signs can sum positive, and
  // [-100, 500, 0] then allocates −25% and 125% beside a hard-coded "100%"
  // Total row. There is no meaningful part-to-whole reading of a negative
  // slice, so refusing the whole allocation is the only honest answer —
  // clamping just the negative bucket would silently inflate its siblings'
  // shares to fill the gap.
  //
  // Unreachable from F9 today (both netting helpers clamp at 0n), and kept
  // anyway: this component is shared, and that clamp is one edit away from
  // someone removing it after "verifying" a negative cannot occur.
  if (values.some((v) => !Number.isFinite(v) || v < 0)) {
    return values.map(() => 0);
  }
  const total = values.reduce((sum, v) => sum + v, 0);
  if (total <= 0) return values.map(() => 0);

  const raw = values.map((v) => (v / total) * 100);
  const floors = raw.map((r) => Math.floor(r));
  const leftover = 100 - floors.reduce((sum, f) => sum + f, 0);

  const byRemainderDesc = raw
    .map((r, index) => ({ index, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);

  const result = [...floors];
  for (const { index } of byRemainderDesc.slice(0, leftover)) {
    result[index] = (result[index] ?? 0) + 1;
  }
  return result;
}

export function InvoiceStatusChart({ distribution }: InvoiceStatusChartProps) {
  const t = useTranslations('admin.dashboard.invoiceStatus');
  const locale = useLocale();

  // Two decimals in this card only (see the docblock): rows always add up to
  // the headline, and both tie to the register to the satang.
  const thbFmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const byBucket = new Map(distribution.buckets.map((b) => [b.bucket, b] as const));
  const bucketsInOrder = BUCKET_ORDER.map((key) => byBucket.get(key) ?? zeroBucket(key));
  const satangNumbers = bucketsInOrder.map((b) => Number(b.satang));

  const totalSatangNumber = satangNumbers.reduce((sum, n) => sum + n, 0);
  const hasData = totalSatangNumber > 0;

  // Largest-remainder allocation (see `allocatePercentages` doc) so the
  // displayed bucket %s always sum to exactly 100 — keeping the hard-coded
  // Total row's "100%" honest.
  const pctAllocations = allocatePercentages(satangNumbers);
  // False when the allocation refused its input (a negative bucket) and
  // returned all zeros: then "0%" is the honest reading, never "<1%".
  const allocated = pctAllocations.some((p) => p > 0);

  const rows: BucketRow[] = BUCKET_ORDER.map((key, i) => {
    const b = bucketsInOrder[i] ?? zeroBucket(key);
    const satangNumber = satangNumbers[i] ?? 0;
    const pct = pctAllocations[i] ?? 0;
    return {
      bucket: key,
      label: t(`bucket.${key}`),
      satangNumber,
      amountLabel: thbFmt.format(satangNumber / 100),
      visibleAmount: formatWrapping(thbFmt, satangNumber / 100),
      count: b.count,
      // A real amount that rounds to 0% reads "<1%", never a bare "0%"
      // beside a non-zero amount (financial review, 17 Oct).
      pctLabel: allocated && pct === 0 && satangNumber > 0 ? '<1%' : `${pct}%`,
    };
  });

  const totalLabel = thbFmt.format(totalSatangNumber / 100);
  const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
  const draftCount = distribution.draftCount;

  const draftCaption =
    draftCount > 0 ? (
      <p className="mt-[var(--aura-space-2)] aura-text-caption text-[var(--aura-fg-secondary)]">
        {t('draftCaption', { count: draftCount })}
      </p>
    ) : null;

  return (
    <Card title={t('title')} {...(hasData ? { description: t('basisCaption') } : {})} headingLevel={2}>
      {!hasData ? (
        <>
          <p className="aura-text-body text-[var(--aura-fg-secondary)]">{t('empty')}</p>
          {draftCaption}
        </>
      ) : (
        <>
          <div className={CHART_HERO_ROW}>
            <span className={CHART_HERO_GROUP}>
              {/* `anywhere` dropped from the hero class: the <wbr>s give the
                  only places this amount may break. */}
              <span
                data-slot="status-total"
                className={CHART_HERO_VALUE.replace('[overflow-wrap:anywhere] ', '')}
              >
                {formatHeadline(thbFmt, totalSatangNumber / 100)}
              </span>
              <span className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('totalLabel')}</span>
            </span>
          </div>
          {/* One stacked bar; each segment grows by its exact satang share
              (not the rounded %), and a non-zero bucket keeps 2px while the
              others shrink, so the bar never runs past its track. */}
          <div
            aria-hidden="true"
            data-slot="status-bar"
            className="mt-[var(--aura-space-4)] flex h-2.5 gap-0.5 overflow-hidden rounded-full"
          >
            {rows
              .filter((r) => r.satangNumber > 0)
              .map((r) => (
                <span
                  key={r.bucket}
                  data-bucket={r.bucket}
                  className="h-full first:rounded-l-full last:rounded-r-full"
                  style={{
                    flexGrow: (r.satangNumber / totalSatangNumber) * 100,
                    flexShrink: 1,
                    flexBasis: 0,
                    minWidth: 2,
                    backgroundColor: BUCKET_FILL[r.bucket],
                  }}
                />
              ))}
          </div>
          {/* A row per bucket (WCAG 1.4.1 — colour is never the sole
              signal). `aria-hidden` because it duplicates the hidden table. */}
          <ul
            aria-hidden="true"
            data-slot="status-rows"
            className="mt-[var(--aura-space-3)] divide-y divide-[var(--aura-border-default)] border-t border-[var(--aura-border-default)] aura-text-body"
          >
            {rows.map((r) => (
              <li
                key={r.bucket}
                className="flex flex-wrap items-center gap-x-[var(--aura-space-3)] py-[var(--aura-space-2)]"
              >
                <span className="flex flex-1 items-center gap-[var(--aura-space-2)] text-[var(--aura-fg-primary)]">
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: BUCKET_FILL[r.bucket] }}
                  />
                  {r.label}
                </span>
                {/* Amount and percent move as one unit when the row wraps. */}
                <span
                  data-slot="status-figures"
                  className="ml-auto flex flex-wrap items-baseline justify-end gap-x-[var(--aura-space-3)]"
                >
                  <span className="whitespace-nowrap text-right tabular-nums text-[var(--aura-fg-primary)]">
                    {r.visibleAmount}
                  </span>
                  <span className="w-10 text-right aura-text-caption tabular-nums text-[var(--aura-fg-secondary)]">
                    {r.pctLabel}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {draftCaption}
          {/* Accessible equivalent (WCAG 1.1.1 / 1.3.1 / 1.4.1) — the sole
              SR/no-JS data path for the bar and rows; always ends in a
              "Total" row (design doc requirement). */}
          <ChartDataTable
            caption={t('title')}
            columns={[
              t('statusColumnHeader'),
              t('amountColumnHeader'),
              t('countColumnHeader'),
              t('pctColumnHeader'),
            ]}
            rows={[
              ...rows.map((r) => [r.label, r.amountLabel, r.count, r.pctLabel] as const),
              [t('totalRowLabel'), totalLabel, totalCount, '100%'] as const,
            ]}
          />
        </>
      )}
    </Card>
  );
}
