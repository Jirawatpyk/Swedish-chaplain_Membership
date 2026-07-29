/**
 * DV-Wave2 ⑥ — THB money KPI band above the renewals pipeline.
 *
 * renewals-money-band-compact4 — reverts the brief 2-KPI-strip experiment
 * (`renewals-money-band-slim`) back to all 4 KPIs, but as a COMPACT 4-tile
 * grid rather than the original 4 HERO `KpiCard` tiles: the strip read too
 * sparse for a money surface, and the original hero cards read too tall next
 * to the pipeline table that is this page's actual primary work surface. The
 * compact grid is the middle ground the user picked from a mockup review —
 * every KPI a treasurer needs, in a ~30-35% shorter footprint than the hero
 * version.
 *
 * Tiles render via the shared `KpiCard` (Reusable-Components principle)
 * using its two additive props: `compact` (`Card size="sm"` + a `text-2xl`
 * value instead of the `text-3xl` hero) and `tone` (colours the value only,
 * via the app's semantic success/warning tokens — Collection rate is a "how
 * are we doing" success signal, Past due is the amber "needs attention"
 * signal; Collected + Due soon stay neutral). Both props default to the
 * pre-existing look, so F9's dashboard `KpiCard` call sites are unaffected.
 *
 * Every KPI carries its own `basis` caption again (spec § 5) — the strip's
 * single shared `stripBasis` caption is gone (removed from all 3 locales);
 * each tile states its own scope so a treasurer never mistakes it for F9's
 * all-time overdue or the ภ.พ.30 VAT register.
 *
 * The collection rate is DERIVED (Domain `collectionRatePct`) from the
 * settled + overdue legs — never a stored field, never the banned
 * flow÷stock rate. Money heroes use `formatSatangThb` — the canonical
 * grouped/locale-aware THB formatter every other money surface uses — + the
 * localised `money.currency` label (ux-standards §1.3). `formatSatangThb`
 * bakes in its OWN `'THB'` suffix, so it is called with an explicit empty
 * `currency` + `.trimEnd()` here to avoid double-rendering the unit: the
 * tiles show the locale-appropriate `money.currency` word (e.g. Thai "บาท")
 * as a separate muted suffix, not the hardcoded ISO code. Deep-links reuse
 * the EXISTING URL contracts only (`?month=overdue`,
 * `?status=paid&subject=membership`) — Due soon stays DISPLAY-ONLY per the
 * Wave 2 final review (no invoice-due-date-range filter exists to link it to
 * without contradicting its own 0–90-day caption).
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
import { KpiCard } from '@/components/dashboard/kpi-card';
import { ErrorBoundary } from '@/components/shell/error-boundary';
import { collectionRatePct, type PipelineMoneySummary } from '@/modules/renewals';
import { MoneyBasisHint } from './money-basis-hint';

function PipelineMoneyBandContent({
  money,
  windowDays,
}: {
  readonly money: PipelineMoneySummary;
  readonly windowDays: number;
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

  // The deep-linked KPIs' aria-labels fold in the THB figure itself
  // (`formatSatangThb`'s own `'THB'` suffix is fine here, unlike `moneyHero`
  // above: an aria-label is announced once, not paired with a second visible
  // currency word), so a screen-reader user Tab-navigating by link hears the
  // amount, not only the tile's purpose.
  const pastDueAriaLabel = t('pastDue.ariaLabel', {
    amount: formatSatangThb(money.overdueSatang, locale),
  });
  const collectedAriaLabel = t('collected.ariaLabel', {
    amount: formatSatangThb(money.collectedThisPeriodSatang, locale),
  });

  const rate = collectionRatePct(money.settledDueToDateSatang, money.overdueSatang);
  const rateHero = rate === null ? t('rateNone') : `${rate.toFixed(1)}%`;

  // renewals-overdue-prior-fy-subline — unpaid bills due BEFORE this fiscal
  // year, which the FY-scoped Past-due tile deliberately excludes (its
  // reviewed definition is unchanged). Rendered only when nonzero so the
  // tile is byte-identical for the common no-prior-debt case; the localised
  // `money.currency` word keeps the amount's unit consistent with the hero
  // figure above it. Passed as `subline` (NOT caption/label) so KpiCard
  // keeps it OUTSIDE the tile's deep-link — see the prop's a11y note; that
  // sibling position is also what makes it safe to be a link ITSELF
  // (UX-review follow-up F3) with no nested-interactive risk.
  //
  // Drill-down target: `status=overdue` is the DERIVED invoices-list filter
  // (repo translates it to issued AND BKK-today > due_date — S1-P1-8), the
  // closest expressible superset of "prior-FY overdue membership bills":
  // the list page has no due-date-range/fiscal-year URL param, so the
  // prior-FY rows can't be isolated further without inventing params. The
  // muted colour comes from KpiCard's subline wrapper; hover underline +
  // focus ring keep the affordance subtle but discoverable.
  const priorYearsSubline =
    money.overdueBeforeFySatang > 0n ? (
      <Link
        href="/admin/invoices?status=overdue&subject=membership"
        className="rounded-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      >
        {t('pastDue.priorYears', {
          amount: formatSatangThb(money.overdueBeforeFySatang, locale, currency),
          count: money.overdueBeforeFyCount,
        })}
      </Link>
    ) : undefined;

  return (
    <section aria-labelledby="pipeline-money-band-heading" className="flex flex-col gap-3">
      {/* Visible `<h2>` (not just a screen-reader-only `aria-label`) so
          sighted admins get the same "membership dues — money" framing as
          the other pipeline sections; `aria-labelledby` keeps it as the
          section's accessible name too. */}
      <h2 id="pipeline-money-band-heading" className="text-base font-semibold">
        {t('title')}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Display-only — no href/ariaLabel (matches the original "no
            <Link> for the rate tile" contract). `tone="success"` reads as
            the "how are we doing" signal. `labelHint` explains why this
            tile's settled (due-FY) basis legitimately diverges from the F9
            dashboard's Paid revenue (issue-year) — users compare the two
            pages. Safe here precisely BECAUSE the tile is non-linked (see
            the KpiCard prop doc's nested-interactive warning). */}
        <KpiCard
          compact
          tone="success"
          label={t('collectionRate.label')}
          labelHint={
            <MoneyBasisHint
              ariaLabel={t('collectionRate.hintAriaLabel')}
              tooltipText={t('collectionRate.hint')}
            />
          }
          value={rateHero}
          caption={t('collectionRate.basis')}
        />
        <KpiCard
          compact
          tone="warning"
          label={t('pastDue.label')}
          value={moneyHero(money.overdueSatang)}
          caption={t('pastDue.basis')}
          href="/admin/renewals?month=overdue"
          ariaLabel={pastDueAriaLabel}
          subline={priorYearsSubline}
        />
        <KpiCard
          compact
          label={t('collected.label')}
          value={moneyHero(money.collectedThisPeriodSatang)}
          caption={t('collected.basis')}
          href="/admin/invoices?status=paid&subject=membership"
          ariaLabel={collectedAriaLabel}
        />
        {/* DISPLAY-ONLY (Wave 2 final review) — this tile's own caption
            states a cumulative 0–90-day invoice-due-date window, and no
            pipeline/invoice-list URL param filters by that dimension today;
            linking it anywhere would contradict what the tile visibly says. */}
        <KpiCard
          compact
          label={t('dueSoon.label')}
          value={moneyHero(money.dueSoonSatang)}
          caption={t('dueSoon.basis', { days: windowDays })}
        />
      </div>
    </section>
  );
}

export function PipelineMoneyBand(props: {
  readonly money: PipelineMoneySummary;
  readonly windowDays: number;
}) {
  return (
    <ErrorBoundary>
      <PipelineMoneyBandContent {...props} />
    </ErrorBoundary>
  );
}

/**
 * Suspense fallback — reserves the compact 4-tile grid's footprint (heading +
 * one row of 4 `Card size="sm"` tiles) so the money band streaming in does
 * NOT push the pipeline card down. CLS 0 holds for the no-prior-FY-debt case;
 * when the "+ overdue from prior years" sub-line renders (prod's CURRENT
 * state — see renewals-overdue-prior-fy-subline), the real band is ~20px
 * taller than this fallback, a known small shift accepted at UX review:
 * always over-reserving the sub-line's row would leave a permanent hole under
 * the Past-due tile in the common zero case, which was judged worse than a
 * one-time ~20px settle for tenants that DO carry prior-FY debt. The heading
 * is the REAL static title (no data dependency, so no shimmer needed —
 * mirrors how `RenewalsSectionTabs`'s fallback renders the real tab strip and
 * only skeleton-defers the data-dependent badges); only the 4 tiles' content
 * — which depends on `loadPipelineMoney` — show shimmer placeholders.
 */
export function PipelineMoneyBandSkeleton() {
  const t = useTranslations('admin.renewals.money');
  // Slightly varied placeholder widths per tile so the skeleton reads as 4
  // distinct labels/values, not one bar repeated 4×.
  const shapes = [
    { label: 'h-4 w-28', value: 'h-7 w-16' }, // Collection rate — short "NN.N%"
    { label: 'h-4 w-20', value: 'h-7 w-28' }, // Past due
    { label: 'h-4 w-32', value: 'h-7 w-28' }, // Collected this month
    { label: 'h-4 w-20', value: 'h-7 w-24' }, // Due soon
  ] as const;
  return (
    // No `aria-hidden` — the heading is REAL text (mirrors
    // `RenewalsByMonthSectionSkeleton`'s un-hidden fallback); the shimmer
    // bars underneath carry no text for a screen reader to announce.
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {shapes.map((shape, i) => (
          <Card key={i} size="sm">
            <CardContent className="flex flex-col gap-1.5">
              <Skeleton className={shape.label} />
              <Skeleton className={shape.value} />
              <Skeleton className="h-3.5 w-full" />
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
