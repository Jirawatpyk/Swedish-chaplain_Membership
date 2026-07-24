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
 *
 * **Lazy canvas boundary (Task 12 — bundle-budget constraint):** the actual
 * `<PieChart>` rendering lives in `./invoice-status-canvas` and is mounted
 * here via `next/dynamic(..., { ssr: false })`, so recharts never lands in
 * `/admin`'s first-load JS. This file still computes `rows` (needed for the
 * canvas, the centre total, the visible legend, AND the accessible table)
 * and renders everything except the donut itself eagerly. `BUCKET_FILL` is
 * declared HERE (not in the canvas) because the eager legend below also
 * needs it as a real runtime value for its swatch colours — see
 * `invoice-status-canvas.tsx`'s docblock for why that import direction is
 * bundle-safe. The donut's aspect is fixed (not data-dependent, unlike the
 * tier bar), so the `loading` skeleton just reuses the same
 * `mx-auto aspect-square max-h-64 w-full` className as the real canvas —
 * no wrapper-height gymnastics needed (contrast `membership-tier-chart.tsx`).
 */
'use client';

import dynamic from 'next/dynamic';
import { useTranslations, useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { InvoiceStatusBucket, InvoiceStatusDistribution } from '@/modules/insights';
import { ChartDataTable } from './chart-data-table';
import { ChartSkeleton } from './chart-skeleton';
import {
  getAllowMotion,
  getServerAllowMotion,
  subscribeMotionPreference,
} from './use-motion-preference';

const InvoiceStatusCanvas = dynamic(
  () => import('./invoice-status-canvas').then((m) => m.InvoiceStatusCanvas),
  { ssr: false, loading: () => <ChartSkeleton className="mx-auto aspect-square max-h-64 w-full" /> },
);

export interface InvoiceStatusChartProps {
  readonly distribution: InvoiceStatusDistribution;
}

/** Fixed render order (design doc: CVD spacing — amber between green/red),
 * never the raw array order the port happens to return. */
const BUCKET_ORDER = ['paid', 'unpaid', 'overdue'] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

/** Semantic (not categorical) colour — the bucket IS a state, not an
 * arbitrary series identity. Exported: the lazy `./invoice-status-canvas`
 * needs this as a real value for its `<Cell fill=…>`s (see that file's
 * docblock for why this import direction — canvas importing FROM the eager
 * chart file — is the bundle-safe one). */
export const BUCKET_FILL: Record<Bucket, string> = {
  paid: 'var(--success)',
  unpaid: 'var(--warning)',
  overdue: 'var(--destructive)',
};

/** Row shape fed to Recharts — `satangNumber` is the Pie's arc-sizing value
 * (VALUE basis, never count); every other field is display-ready text so
 * the tooltip/table need no further formatting. Exported as a type-only
 * dependency for `./invoice-status-canvas` (erased at compile time). */
export interface BucketRow {
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

  // Centre-total ONLY: a compact "฿2.0M"-scale display so the headline
  // number fits the donut hole at any locale/currency-string length (bug:
  // en-US/sv-SE THB has no native "฿" glyph, so the FULL string is
  // "THB 2,000,000" — wide enough to spill past the hole onto the arcs).
  // `minimumFractionDigits: 0` is required alongside `maximumFractionDigits:
  // 1` — currency style otherwise resolves BOTH to the currency's native
  // fraction digits (2 for THB), which get clamped down to
  // `maximumFractionDigits` and render a spurious ".0" even on whole numbers
  // below the compact threshold (e.g. "฿500.0" instead of "฿500"). The FULL
  // exact amount stays everywhere else — the tooltip, the visible legend,
  // and the hidden `<ChartDataTable>`'s Total row — this compacting is
  // cosmetic to the centre overlay alone.
  const compactThbFmt = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'THB',
    notation: 'compact',
    maximumFractionDigits: 1,
    minimumFractionDigits: 0,
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

  const rows: BucketRow[] = BUCKET_ORDER.map((key, i) => {
    const b = bucketsInOrder[i] ?? zeroBucket(key);
    const satangNumber = satangNumbers[i] ?? 0;
    const pct = pctAllocations[i] ?? 0;
    return {
      bucket: key,
      label: t(`bucket.${key}`),
      satangNumber,
      amountLabel: thbFmt.format(satangNumber / 100),
      count: b.count,
      countLabel: t('invoiceCountLabel', { count: b.count }),
      pctLabel: `${pct}%`,
    };
  });

  const totalLabel = thbFmt.format(totalSatangNumber / 100);
  const compactTotalLabel = compactThbFmt.format(totalSatangNumber / 100);
  const totalCount = rows.reduce((sum, r) => sum + r.count, 0);
  const draftCount = distribution.draftCount;

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
              {/* `relative z-10` gives this wrapper its OWN stacking context
                  (position + explicit z-index) so everything painted inside
                  it — the arcs AND, critically, the Recharts hover tooltip —
                  stacks ABOVE the centre-total overlay below (z-0). Before
                  this fix both divs were plain siblings with the centre-total
                  positioned (`absolute`) and this canvas wrapper `static`: a
                  positioned box ALWAYS paints above a non-positioned one
                  regardless of DOM order, so the total silently won every
                  time — hiding the tooltip on hover (bug) and, wherever the
                  total's text ran wider than the hole, drawing over the arcs
                  too (bug). The hole stays transparent outside the ring, so
                  the total still shows through at rest — this only changes
                  who wins where the two would otherwise collide. */}
              <div aria-hidden="true" className="relative z-10">
                <InvoiceStatusCanvas rows={rows} allowMotion={allowMotion} />
              </div>
              {/* Real DOM (design doc: "real DOM, not SVG-only") — a sibling
                  of the aria-hidden canvas div, NOT inside it, so screen
                  readers reach it in normal reading order. Visually overlaid
                  on the donut hole via CSS position, not Recharts geometry.
                  Label BEFORE value (not value-then-label) so SR/reading
                  order says "Total invoiced. THB 10K." rather than the
                  bare amount followed by an unattached caption.
                  `z-0` pairs with the canvas's `z-10` above; `px-6` + the
                  compact `compactTotalLabel` (vs. the full `totalLabel`)
                  keep this comfortably inside the donut hole
                  (`innerRadius="65%"` in `invoice-status-canvas.tsx`)
                  instead of spilling onto the ring — the exact amount is
                  never lost, it's still the tooltip/legend/table's value. */}
              <div className="pointer-events-none absolute inset-0 z-0 flex flex-col items-center justify-center gap-0.5 px-6 text-center">
                <span className="text-caption text-muted-foreground">{t('totalLabel')}</span>
                <span className="text-xl font-semibold leading-tight tabular-nums">
                  {compactTotalLabel}
                </span>
              </div>
            </div>
            {/* Persistent, VISIBLE legend (WCAG 1.4.1 — colour is never the
                sole signal): the donut's semantic success/warning/destructive
                fills fail CVD separation (near-equal luminance in this
                theme), and without this row the only text labels live in the
                sr-only table + the hover-only tooltip, leaving a sighted
                colour-blind user unable to tell paid/unpaid/overdue apart.
                `aria-hidden` because its data 100% duplicates the sr-only
                `<ChartDataTable>` below — same double-announce rationale as
                the aria-hidden canvas. */}
            <ul
              aria-hidden="true"
              className="mt-3 flex flex-wrap justify-center gap-x-4 gap-y-1 text-caption text-muted-foreground"
            >
              {rows.map((r) => (
                <li key={r.bucket} className="flex items-center gap-1.5">
                  <span
                    className="h-2.5 w-2.5 rounded-full"
                    style={{ backgroundColor: BUCKET_FILL[r.bucket] }}
                  />
                  {r.label} · {r.pctLabel}
                </li>
              ))}
            </ul>
            {draftCaption}
            {/* States this chart's measurement basis, which differs from every
                other money figure on the page: all-time (the port is never
                given a fiscal year) and VAT-INCLUSIVE (`total_satang` less
                credits), where the revenue KPI and the trend sparkline are
                fiscal-year/rolling-window and ex-VAT. Two honest numbers on
                one screen that don't tie out read as a broken system unless
                each says what it measures. */}
            <p className="mt-1 text-center text-caption text-muted-foreground">
              {t('basisCaption')}
            </p>
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
