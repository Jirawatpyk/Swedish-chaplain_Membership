/**
 * DV-Wave2 ⑥ — THB money KPI band above the renewals pipeline.
 *
 * Server presentational component. Four tiles answering the treasurer's
 * question "how are we collecting THIS fiscal year's membership dues, and what
 * cash came in this month". Every tile carries a `basis` caption (spec § 5) so
 * a treasurer never mistakes it for F9's all-time overdue or the ภ.พ.30 VAT
 * register — and NEVER a bare "Overdue" (F9 owns another overdue definition).
 *
 * The collection rate is DERIVED (Domain `collectionRatePct`) from the settled
 * + overdue legs — never a stored field, never the banned flow÷stock rate.
 * Money heroes use `formatSatangThb` — the canonical grouped/locale-aware THB
 * formatter every other money surface uses (Fix round 1 #2; the prior
 * `formatSatangAsBaht` had no thousands grouping and was this band's only
 * caller) — + the localised `money.currency` label (ux-standards §1.3,
 * `text-3xl tabular-nums`). `formatSatangThb` bakes in its OWN `'THB'`
 * suffix, so it is called with an explicit empty `currency` + `.trimEnd()`
 * here to avoid double-rendering the unit: this band shows the
 * locale-appropriate `money.currency` word (e.g. Thai "บาท") as a separate
 * muted suffix, not the hardcoded ISO code. Deep-links reuse the EXISTING
 * URL contract only.
 *
 * Fix round 2 — tiles now render via the shared `KpiCard`
 * (`@/components/dashboard/kpi-card.tsx`, F9 admin dashboard) instead of the
 * bespoke `MoneyTile`, so tokens/structure match the rest of the admin
 * surface (Reusable-Components principle); `KpiCard`'s caption already uses
 * `text-muted-foreground` on `bg-card` (measured ≥5.6:1 in both themes — AA
 * 4.5:1-compliant, so the shared component changes nothing here) — the
 * refactor is a structural/tokens win, not a contrast fix. The whole render
 * is also now wrapped in a small `ErrorBoundary`: the page's own try/catch
 * (see `PipelineMoneyBandSection` in `page.tsx`) only covers the DATA fetch —
 * a throw during THIS component's own render must also never crash the
 * pipeline.
 */
import { useLocale, useTranslations } from 'next-intl';
import { formatSatangThb } from '@/lib/format-thb';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { ErrorBoundary } from '@/components/shell/error-boundary';
import { collectionRatePct, type PipelineMoneySummary } from '@/modules/renewals';

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

  const moneyHero = (satang: bigint) => (
    <>
      {formatSatangThb(satang, locale, '').trimEnd()}{' '}
      <span className="text-sm font-normal text-muted-foreground">{currency}</span>
    </>
  );

  // Fix round 2 final-polish #5 (minors) — deep-linked KPI aria-labels now
  // fold in the THB figure itself (`formatSatangThb`'s own `'THB'` suffix is
  // fine here, unlike `moneyHero` above: an aria-label is announced once, not
  // paired with a second visible currency word), so a screen-reader user
  // Tab-navigating by link hears the amount, not only the tile's purpose.
  const pastDueAriaLabel = t('pastDue.ariaLabel', {
    amount: formatSatangThb(money.overdueSatang, locale),
  });
  const collectedAriaLabel = t('collected.ariaLabel', {
    amount: formatSatangThb(money.collectedThisPeriodSatang, locale),
  });

  const rate = collectionRatePct(money.settledDueToDateSatang, money.overdueSatang);
  const rateHero = rate === null ? t('rateNone') : `${rate.toFixed(1)}%`;

  return (
    <section aria-labelledby="pipeline-money-band-heading" className="flex flex-col gap-3">
      {/* Fix round 1 #5 — the title previously existed ONLY as this
          section's `aria-label` (screen-reader-only). Rendered as a visible
          `<h2>` so sighted admins get the same "membership dues — money"
          framing, matching the heading style of the other pipeline sections
          (`renewals-by-month-section.tsx`'s `text-base font-semibold` h2).
          `aria-labelledby` keeps it as the section's accessible name too. */}
      <h2 id="pipeline-money-band-heading" className="text-base font-semibold">
        {t('title')}
      </h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* Display-only — no href, no link, no aria-label (matches the
            original "no <Link> for the rate tile" contract). */}
        <KpiCard
          label={t('collectionRate.label')}
          value={rateHero}
          caption={t('collectionRate.basis')}
        />
        <KpiCard
          label={t('pastDue.label')}
          value={moneyHero(money.overdueSatang)}
          caption={t('pastDue.basis')}
          href="/admin/renewals?month=overdue"
          ariaLabel={pastDueAriaLabel}
        />
        <KpiCard
          label={t('collected.label')}
          value={moneyHero(money.collectedThisPeriodSatang)}
          caption={t('collected.basis')}
          // Fix round 1 #4 — scope the drill-down to membership so it at
          // least matches this tile's subject scope. Residual mismatch
          // (deferred, not fixed here): this tile is BKK-calendar-month +
          // net-of-credits, while the invoice list below is all-time gross
          // — the two numbers will not reconcile 1:1 even after the filter.
          href="/admin/invoices?status=paid&subject=membership"
          ariaLabel={collectedAriaLabel}
        />
        <KpiCard
          label={t('dueSoon.label')}
          value={moneyHero(money.dueSoonSatang)}
          caption={t('dueSoon.basis', { days: windowDays })}
          // Fix round 2 final-polish #1 — this tile is now DISPLAY-ONLY (no
          // `href`/`ariaLabel`), matching the `collectionRate` tile above.
          // It previously linked to `?urgency=t-30` (a narrow 14–30-day
          // CYCLE-EXPIRY band) while the visible caption states a
          // cumulative 0–90-day invoice-DUE-DATE window — a self-
          // contradiction between what a sighted admin reads and where the
          // link actually goes, on a money surface. No pipeline/invoice-list
          // URL param filters by invoice-due-date range today, so no
          // exact-match drill-down target exists to fix the link TO; dropping
          // it removes the contradiction without adding one.
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
 * Suspense fallback (Fix round 1 #1) — reserves the band's exact footprint
 * (heading + 4-tile grid, matching tile padding/typography) so the money
 * band streaming in does NOT push the pipeline card down (CLS 0). The
 * heading is the REAL static title (no data dependency, so no shimmer
 * needed — mirrors how `RenewalsSectionTabs`'s fallback renders the real
 * tab strip and only skeleton-defers the data-dependent badges); only the
 * 4 tiles — whose content depends on `loadPipelineMoney` — show shimmer
 * placeholders. Tile placeholder rows approximate the real 3-line tile
 * (label / hero / 2-line-capable basis caption — several `basis` strings
 * wrap onto 2 lines at narrower breakpoints).
 */
export function PipelineMoneyBandSkeleton() {
  const t = useTranslations('admin.renewals.money');
  return (
    // No `aria-hidden` — the heading is REAL text (mirrors
    // `RenewalsByMonthSectionSkeleton`'s un-hidden fallback); the shimmer
    // bars underneath carry no text for a screen reader to announce.
    <section className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <Card key={i}>
            <CardContent className="py-4">
              <Skeleton className="h-5 w-28" />
              <Skeleton className="mt-2 h-9 w-36" />
              <Skeleton className="mt-2 h-3.5 w-full" />
              <Skeleton className="mt-1 h-3.5 w-2/3" />
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
