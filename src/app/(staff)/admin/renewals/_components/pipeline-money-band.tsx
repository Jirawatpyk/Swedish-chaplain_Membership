/**
 * DV-Wave2 ⑥ — THB money KPI band above the renewals pipeline.
 *
 * renewals-money-band-slim — slimmed from 4 hero `KpiCard` tiles down to a
 * compact 2-KPI strip: **Collection rate** (derived, display-only) and
 * **Past due** (deep-links to the overdue bucket) — the two KPIs a treasurer
 * actually acts on. Collected-this-month and Due-soon are dropped from the
 * RENDER only; `PipelineMoneySummary` still carries all 4 legs (the query in
 * `page.tsx`'s `PipelineMoneyBandSection` is untouched) so those tiles can be
 * restored later without a query change. A lone 2-tile grid reads as sparse
 * on a page whose primary work surface is the pipeline table below it — an
 * inline summary strip reads as an intentional "at a glance" header instead.
 *
 * Every KPI still carries a `basis` (spec § 5) so a treasurer never mistakes
 * it for F9's all-time overdue or the ภ.พ.30 VAT register — collapsed here
 * into ONE shared strip caption (`money.stripBasis`) since both remaining
 * KPIs share the same basis (membership · this fiscal year · incl. VAT).
 *
 * The collection rate is DERIVED (Domain `collectionRatePct`) from the
 * settled + overdue legs — never a stored field, never the banned
 * flow÷stock rate. The past-due hero uses `formatSatangThb` — the canonical
 * grouped/locale-aware THB formatter every other money surface uses — +
 * the localised `money.currency` label (ux-standards §1.3). `formatSatangThb`
 * bakes in its OWN `'THB'` suffix, so it is called with an explicit empty
 * `currency` + `.trimEnd()` here to avoid double-rendering the unit: the
 * strip shows the locale-appropriate `money.currency` word (e.g. Thai
 * "บาท") as a separate muted suffix, not the hardcoded ISO code. The
 * deep-link reuses the EXISTING `?month=overdue` URL contract only.
 *
 * `Card size="sm"` (the shadcn/ui compact-card variant: `py-3`/`gap-3`/
 * `px-3` instead of the default `py-6`/`gap-4`/`px-6`) is reused rather than
 * a bespoke borderless block — it gives the "slim strip" footprint for free
 * while keeping the same bordered-Card chrome every other pipeline
 * sub-section uses (`renewals-by-month-section.tsx`, the at-risk widget,
 * `LoadErrorCard`), so the strip reads as one more section in a consistent
 * page, not a one-off treatment.
 *
 * The whole render stays wrapped in a small `ErrorBoundary`: the page's own
 * try/catch (see `PipelineMoneyBandSection` in `page.tsx`) only covers the
 * DATA fetch — a throw during THIS component's own render must also never
 * crash the pipeline.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorBoundary } from '@/components/shell/error-boundary';
import { collectionRatePct, type PipelineMoneySummary } from '@/modules/renewals';

function PipelineMoneyBandContent({
  money,
}: {
  readonly money: PipelineMoneySummary;
  /**
   * Kept for call-site/API stability and for a future restore of the
   * dropped Due-soon tile (its `basis` caption interpolates this) — the
   * slimmed strip's shared `stripBasis` caption does not need it, so it is
   * intentionally not destructured/read below. `PipelineMoneyBandSection`
   * in `page.tsx` still computes and passes `WINDOW_DAYS = 90` unchanged.
   */
  readonly windowDays?: number;
}) {
  const t = useTranslations('admin.renewals.money');
  const locale = useLocale();
  const currency = t('currency');

  const moneyHero = (satang: bigint): ReactNode => (
    <>
      {formatSatangThb(satang, locale, '').trimEnd()}{' '}
      <span className="text-sm font-normal text-muted-foreground">{currency}</span>
    </>
  );

  // The deep-linked KPI's aria-label folds in the THB figure itself
  // (`formatSatangThb`'s own `'THB'` suffix is fine here, unlike `moneyHero`
  // above: an aria-label is announced once, not paired with a second
  // visible currency word), so a screen-reader user Tab-navigating by link
  // hears the amount, not only the strip's purpose.
  const pastDueAriaLabel = t('pastDue.ariaLabel', {
    amount: formatSatangThb(money.overdueSatang, locale),
  });

  const rate = collectionRatePct(money.settledDueToDateSatang, money.overdueSatang);
  const rateHero = rate === null ? t('rateNone') : `${rate.toFixed(1)}%`;

  return (
    <section aria-labelledby="pipeline-money-band-heading" className="flex flex-col gap-3">
      {/* Visible `<h2>` (not just a screen-reader-only `aria-label`) so
          sighted admins get the same "membership dues — money" framing as
          the other pipeline sections; `aria-labelledby` keeps it as the
          section's accessible name too. */}
      <h2 id="pipeline-money-band-heading" className="text-base font-semibold">
        {t('title')}
      </h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            {/* Display-only — no href, no link, no aria-label (matches the
                original "no <Link> for the rate tile" contract). */}
            <div className="flex items-baseline gap-2">
              <span className="text-sm text-muted-foreground">
                {t('collectionRate.label')}
              </span>
              <span className="text-2xl font-semibold tabular-nums">{rateHero}</span>
            </div>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <Link
              href="/admin/renewals?month=overdue"
              aria-label={pastDueAriaLabel}
              className="flex items-baseline gap-2 rounded-sm text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              <span className="text-sm text-muted-foreground">{t('pastDue.label')}</span>
              <span className="text-2xl font-semibold tabular-nums">
                {moneyHero(money.overdueSatang)}
              </span>
            </Link>
          </div>
          {/* One shared basis caption for the whole strip — both remaining
              KPIs are on the same basis, so a per-tile caption each (the
              4-tile predecessor's design) would just repeat itself. */}
          <p className="text-caption text-muted-foreground">{t('stripBasis')}</p>
        </CardContent>
      </Card>
    </section>
  );
}

export function PipelineMoneyBand(props: {
  readonly money: PipelineMoneySummary;
  readonly windowDays?: number;
}) {
  return (
    <ErrorBoundary>
      <PipelineMoneyBandContent {...props} />
    </ErrorBoundary>
  );
}

/**
 * Suspense fallback — reserves the strip's exact footprint (heading + the
 * compact `Card size="sm"` KPI row + caption line) so the money band
 * streaming in does NOT push the pipeline card down (CLS 0). The heading is
 * the REAL static title (no data dependency, so no shimmer needed — mirrors
 * how `RenewalsSectionTabs`'s fallback renders the real tab strip and only
 * skeleton-defers the data-dependent badges); only the KPI values + basis
 * caption — which depend on `loadPipelineMoney` — show shimmer placeholders.
 */
export function PipelineMoneyBandSkeleton() {
  const t = useTranslations('admin.renewals.money');
  return (
    // No `aria-hidden` — the heading is REAL text (mirrors
    // `RenewalsByMonthSectionSkeleton`'s un-hidden fallback); the shimmer
    // bars underneath carry no text for a screen reader to announce.
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <Card size="sm">
        <CardContent className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1.5">
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-7 w-16" />
            </div>
            <div className="flex items-baseline gap-2">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-7 w-28" />
            </div>
          </div>
          <Skeleton className="h-3.5 w-56" />
        </CardContent>
      </Card>
    </section>
  );
}
