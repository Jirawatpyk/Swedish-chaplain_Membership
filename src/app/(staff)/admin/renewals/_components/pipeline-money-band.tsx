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
 * 122 US7a (T704): four AURA `Stat` tiles from the server entry, as the
 * `Admin-renewals` board draws them — the figures in the text colour (no
 * success / warning tone on them), each value one string ("500.00 THB",
 * the unit the localised `money.currency` word), the linked tiles marked by
 * AURA's arrow icon and linked through their label (`linkArea="label"`), so
 * the prior-years line under Past due stays its own link in the tile. The
 * shared dashboard `KpiCard` stays for US11.
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
 * tiles show the locale-appropriate `money.currency` word (e.g. Thai "บาท"),
 * not the hardcoded ISO code. Deep-links reuse
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
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { Stat } from '@jirawatpyk/aura-react/server';
import { formatSatangThb } from '@/lib/format-thb';
import { ErrorBoundary } from '@/components/shell/error-boundary';
import { collectionRatePct, type PipelineMoneySummary } from '@/modules/renewals';
import { MoneyBasisHint } from './money-basis-hint';

/** Four across on a desktop, two on a tablet, one on a phone. */
const TILE_GRID = 'grid grid-cols-1 gap-[var(--aura-space-4)] sm:grid-cols-2 lg:grid-cols-4';

/** The band's eyebrow heading ("MEMBERSHIP DUES — MONEY"); Thai keeps its letter spacing. */
function BandHeading({ id }: { readonly id?: string }) {
  const t = useTranslations('admin.renewals.money');
  return (
    <h2
      {...(id !== undefined ? { id } : {})}
      className="font-mono text-xs font-medium uppercase tracking-wider text-[var(--aura-fg-secondary)] [&:lang(th)]:tracking-normal"
    >
      {t('title')}
    </h2>
  );
}

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

  const moneyValue = (satang: bigint): string =>
    `${formatSatangThb(satang, locale, '').trimEnd()} ${currency}`;

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
  // figure above it. Passed as the Stat's `status` line, OUTSIDE the tile's
  // label link (`linkArea="label"`), which is what makes it safe to be a
  // link ITSELF (UX-review follow-up F3) with no nested-interactive risk.
  //
  // Drill-down target (renewals-suspended-visibility-audit Task 3 — the
  // operator rejected the earlier `status=overdue`-only superset landing):
  // `status=overdue` (DERIVED: issued AND BKK-today > due_date, S1-P1-8)
  // PLUS `dueBefore={fyStartDate}` — the SAME fiscal-year boundary the SQL
  // leg counted with, threaded through `PipelineMoneySummary` FROM the SQL
  // expression itself (never recomputed here) — lands on EXACTLY the
  // prior-FY overdue membership cohort this sub-line sums
  // (`due < fyStart` already implies `due < today`). The danger colour is
  // the board's; hover underline keeps the affordance discoverable.
  const priorYearsSubline =
    money.overdueBeforeFySatang > 0n ? (
      <Link
        href={`/admin/invoices?status=overdue&subject=membership&dueBefore=${money.fyStartDate}`}
        className="text-[var(--aura-fg-danger)] underline-offset-2 hover:underline"
      >
        {t('pastDue.priorYears', {
          amount: formatSatangThb(money.overdueBeforeFySatang, locale, currency),
          count: money.overdueBeforeFyCount,
        })}
      </Link>
    ) : undefined;

  return (
    <section aria-labelledby="pipeline-money-band-heading" className="flex flex-col gap-[var(--aura-space-3)]">
      <BandHeading id="pipeline-money-band-heading" />
      <div className={TILE_GRID}>
        {/* Display-only. The hint explains why this tile's settled (due-FY)
            basis diverges from the F9 dashboard's Paid revenue (issue-year);
            safe beside the label because the tile is not a link. */}
        <Stat
          label={
            <span className="inline-flex items-center gap-[var(--aura-space-1)]">
              {t('collectionRate.label')}
              <MoneyBasisHint
                ariaLabel={t('collectionRate.hintAriaLabel')}
                tooltipText={t('collectionRate.hint')}
              />
            </span>
          }
          value={rateHero}
          caption={t('collectionRate.basis')}
        />
        <Stat
          label={t('pastDue.label')}
          value={moneyValue(money.overdueSatang)}
          caption={t('pastDue.basis')}
          status={priorYearsSubline}
          href="/admin/renewals?month=overdue"
          linkArea="label"
          linkComponent={Link}
          icon="arrow-right"
          aria-label={pastDueAriaLabel}
        />
        <Stat
          label={t('collected.label')}
          value={moneyValue(money.collectedThisPeriodSatang)}
          caption={t('collected.basis')}
          href="/admin/invoices?status=paid&subject=membership"
          linkArea="label"
          linkComponent={Link}
          icon="arrow-right"
          aria-label={collectedAriaLabel}
        />
        {/* DISPLAY-ONLY (Wave 2 final review) — this tile's own caption
            states a cumulative 0–90-day invoice-due-date window, and no
            pipeline/invoice-list URL param filters by that dimension today;
            linking it anywhere would contradict what the tile visibly says. */}
        <Stat
          label={t('dueSoon.label')}
          value={moneyValue(money.dueSoonSatang)}
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
  const labels = [
    t('collectionRate.label'),
    t('pastDue.label'),
    t('collected.label'),
    t('dueSoon.label'),
  ];
  return (
    <section className="flex flex-col gap-[var(--aura-space-3)]">
      <BandHeading />
      <div className={TILE_GRID}>
        {labels.map((label) => (
          <Stat key={label} label={label} loading />
        ))}
      </div>
    </section>
  );
}
