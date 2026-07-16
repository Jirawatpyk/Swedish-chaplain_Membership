/**
 * F9 (067-dashboard-interactive-charts) Task 11 — Invoice-Status donut.
 * Renders the dashboard snapshot's `invoiceStatus` distribution (paid /
 * unpaid / overdue buckets + `draftCount`, already computed net-of-credit,
 * VAT-inclusive per the design doc — this component does no money math of
 * its own beyond satang→THB display formatting) as a Recharts donut, always
 * ordered **paid → unpaid → overdue** (CVD spacing: amber sits between
 * green/red, never adjacent-same-hue).
 *
 * Self-contained i18n: takes ONLY the `distribution` data prop — no title/
 * label props — and resolves all of its own microcopy via `useTranslations`
 * + `useLocale`, the same pattern shipped in `membership-tier-chart.tsx`
 * (Task 10). Safe everywhere (incl. this component's own `next/dynamic`
 * boundary, Task 12) because the root layout wraps the whole app in a
 * single `NextIntlClientProvider` with the full message tree.
 *
 * Title makes the VALUE (not count) basis explicit ("Receivables by
 * value" — design doc requirement #1) — the Pie's numeric value is the
 * satang amount (net-of-credit outstanding balance), never invoice count.
 *
 * Money: `satang` on each bucket is a decimal-free integer string
 * (`bigint.toString()` from `compute-dashboard-snapshot.ts`). `Number(...)`
 * is safe here — THB amounts are far below `Number.MAX_SAFE_INTEGER` (the
 * same reasoning `satangToProcessorAmount` documents in `src/lib/money.ts`).
 * Display formatting mirrors the dashboard's own convention (`page.tsx`'s
 * `thbFmt`: `Intl.NumberFormat(locale, { style: 'currency', currency: 'THB',
 * maximumFractionDigits: 0 })`) for visual consistency with the KPI cards
 * and the revenue-trend/member-growth sparklines on the same page — NOT
 * `formatSatangThb` (the F4/F5/portal suffix-style "1,234.56 THB" formatter,
 * a different visual convention for invoice/receipt line items).
 *
 * A11y (WCAG 1.1.1 / 1.3.1 / 1.4.1 — the same model shared by every 067
 * chart, see `chart-data-table.tsx`'s docblock): the Recharts canvas sits in
 * an `aria-hidden="true"` wrapper with `accessibilityLayer={false}`; the
 * hidden `<ChartDataTable>` is the sole SR/no-JS data path, always ending in
 * a "Total" row. UNLIKE the tier bar / sparklines, this donut ALSO needs its
 * centre total + draftCount caption as **real DOM text outside the
 * aria-hidden wrapper** (design doc: "real DOM, not SVG-only") — an SVG
 * `<Label>` centred in the donut hole would be invisible to screen readers
 * since its containing canvas is aria-hidden, so both are rendered as plain
 * sibling `<div>`/`<p>` markup, visually overlaid via CSS position, not
 * Recharts geometry.
 *
 * Colour is never the sole signal (design doc): `--success`/`--warning`/
 * `--destructive` are near-equal-luminance in this theme (confirmed by
 * running the dataviz skill's `validate_palette.js` on the resolved hex
 * triplet in both themes — it FAILS the CVD-separation check, as the design
 * doc already anticipated), so every bucket also carries a direct text
 * label (the hidden table's row header + the tooltip), and each `<Cell>`
 * gets a `stroke="var(--card)"` (the classic Recharts "gap" technique — the
 * stroke matches the surrounding card background so adjacent slices read as
 * visually separated rather than blending into a single near-equiluminant
 * ring) plus `paddingAngle={2}` for an explicit angular gap on top.
 *
 * Reduced motion: shares `./use-motion-preference` (Task 10) — identical
 * `useSyncExternalStore` triad, explicit boolean `isAnimationActive` (NOT
 * Recharts 3.9's built-in `"auto"` Pie default) so every 067 chart is gated
 * by the SAME app-level media-query subscription.
 */
'use client';

import { useTranslations, useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Cell, Pie, PieChart } from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ChartContainer, ChartTooltip, type ChartConfig } from '@/components/ui/chart';
import type { InvoiceStatusBucket, InvoiceStatusDistribution } from '@/modules/insights';
import { ChartDataTable } from './chart-data-table';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

export interface InvoiceStatusChartProps {
  readonly distribution: InvoiceStatusDistribution;
}

/** Fixed render order (design doc: CVD spacing — amber between green/red),
 * never the raw array order the port happens to return. */
const BUCKET_ORDER = ['paid', 'unpaid', 'overdue'] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

/** Semantic (not categorical) colour — the bucket IS a state, not an
 * arbitrary series identity. */
const BUCKET_FILL: Record<Bucket, string> = {
  paid: 'var(--success)',
  unpaid: 'var(--warning)',
  overdue: 'var(--destructive)',
};

/** Row shape fed to Recharts — `satangNumber` is the Pie's arc-sizing value
 * (VALUE basis, never count); every other field is display-ready text so
 * the tooltip/table need no further formatting. */
interface BucketRow {
  readonly bucket: Bucket;
  readonly label: string;
  readonly satangNumber: number;
  readonly amountLabel: string;
  readonly count: number;
  readonly countLabel: string;
  readonly pctLabel: string;
}

function zeroBucket(bucket: Bucket): InvoiceStatusBucket {
  return { bucket, satang: '0', count: 0 };
}

interface BucketTooltipPayloadEntry {
  readonly payload?: BucketRow;
}

/** Custom tooltip — reads the ORIGINAL `BucketRow` off the hovered payload
 * entry directly (its resolved `label`/`amountLabel`/`countLabel`/
 * `pctLabel`), mirroring `membership-tier-chart.tsx`'s `TierTooltipContent`:
 * shadcn's config/nameKey-driven `ChartTooltipContent` is built for multi-
 * series/legend charts, not this single-series donut. Never the sole way to
 * read a value — the hidden `<ChartDataTable>` below is. */
function BucketTooltipContent({
  active,
  payload,
}: {
  readonly active?: boolean;
  readonly payload?: readonly BucketTooltipPayloadEntry[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  return (
    <div className="grid gap-0.5 rounded-lg border border-border/50 bg-background px-2.5 py-1.5 text-xs shadow-xl">
      <span className="font-medium text-foreground">{row.label}</span>
      <span className="text-muted-foreground">{row.amountLabel}</span>
      <span className="text-muted-foreground">
        {row.countLabel} · {row.pctLabel}
      </span>
    </div>
  );
}

export function InvoiceStatusChart({ distribution }: InvoiceStatusChartProps) {
  const t = useTranslations('admin.dashboard.invoiceStatus');
  const locale = useLocale();
  const allowMotion = useSyncExternalStore(
    subscribeMotionPreference,
    getAllowMotion,
    getServerAllowMotion,
  );

  // Dashboard's own THB convention (page.tsx's `thbFmt`) — NOT the F4/F5
  // suffix-style `formatSatangThb` (a different visual convention for
  // invoice/receipt line items). Visual parity with the KPI cards + the
  // revenue-trend/member-growth sparklines on the same page.
  const thbFmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    maximumFractionDigits: 0,
  });

  const byBucket = new Map(distribution.buckets.map((b) => [b.bucket, b] as const));

  const totalSatangNumber = BUCKET_ORDER.reduce((sum, key) => {
    const b = byBucket.get(key) ?? zeroBucket(key);
    return sum + Number(b.satang);
  }, 0);
  const hasData = totalSatangNumber > 0;

  const pctOf = (n: number): string =>
    totalSatangNumber <= 0 ? '0%' : `${Math.round((n / totalSatangNumber) * 100)}%`;

  const rows: BucketRow[] = BUCKET_ORDER.map((key) => {
    const b = byBucket.get(key) ?? zeroBucket(key);
    const satangNumber = Number(b.satang);
    return {
      bucket: key,
      label: t(`bucket.${key}`),
      satangNumber,
      amountLabel: thbFmt.format(satangNumber / 100),
      count: b.count,
      countLabel: t('invoiceCountLabel', { count: b.count }),
      pctLabel: pctOf(satangNumber),
    };
  });

  const totalLabel = thbFmt.format(totalSatangNumber / 100);
  const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
  const draftCount = distribution.draftCount;

  const chartConfig = {
    paid: { label: t('bucket.paid') },
    unpaid: { label: t('bucket.unpaid') },
    overdue: { label: t('bucket.overdue') },
  } satisfies ChartConfig;

  const draftCaption =
    draftCount > 0 ? (
      <p className="mt-2 text-center text-caption text-muted-foreground">
        {t('draftCaption', { count: draftCount })}
      </p>
    ) : null;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {!hasData ? (
          <>
            <p className="text-body text-muted-foreground">{t('empty')}</p>
            {draftCaption}
          </>
        ) : (
          <>
            <div className="relative">
              <div aria-hidden="true">
                <ChartContainer config={chartConfig} className="mx-auto aspect-square max-h-64 w-full">
                  <PieChart accessibilityLayer={false}>
                    <ChartTooltip cursor={false} content={<BucketTooltipContent />} />
                    <Pie
                      data={rows}
                      dataKey="satangNumber"
                      nameKey="label"
                      innerRadius="60%"
                      outerRadius="100%"
                      paddingAngle={2}
                      isAnimationActive={allowMotion}
                    >
                      {rows.map((r) => (
                        <Cell key={r.bucket} fill={BUCKET_FILL[r.bucket]} stroke="var(--card)" strokeWidth={3} />
                      ))}
                    </Pie>
                  </PieChart>
                </ChartContainer>
              </div>
              {/* Real DOM (design doc: "real DOM, not SVG-only") — a sibling
                  of the aria-hidden canvas div, NOT inside it, so screen
                  readers reach it in normal reading order. Visually overlaid
                  on the donut hole via CSS position, not Recharts geometry. */}
              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
                <span className="text-2xl font-semibold tabular-nums">{totalLabel}</span>
                <span className="text-caption text-muted-foreground">{t('totalLabel')}</span>
              </div>
            </div>
            {draftCaption}
            {/* Accessible equivalent (WCAG 1.1.1 / 1.3.1 / 1.4.1) — the sole
                SR/no-JS data path; visually hidden when data is present, the
                empty-state paragraph above is the SR equivalent otherwise.
                Always ends in a "Total" row (design doc requirement). */}
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
      </CardContent>
    </Card>
  );
}
