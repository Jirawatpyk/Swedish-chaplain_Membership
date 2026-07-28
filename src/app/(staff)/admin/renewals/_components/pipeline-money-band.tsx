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
 * Money heroes use `formatSatangAsBaht(asSatang(…))` + the THB currency label
 * (ux-standards §1.3, `text-3xl tabular-nums`). Deep-links reuse the EXISTING
 * URL contract only.
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { asSatang, formatSatangAsBaht } from '@/lib/money';
import { Card, CardContent } from '@/components/ui/card';
import { collectionRatePct, type PipelineMoneySummary } from '@/modules/renewals';

function MoneyTile({
  label,
  hero,
  basis,
  href,
}: {
  readonly label: string;
  readonly hero: ReactNode;
  readonly basis: string;
  readonly href?: string;
}) {
  const body = (
    <>
      <p className="text-sm font-medium text-muted-foreground">{label}</p>
      <p className="text-3xl font-semibold tabular-nums">{hero}</p>
      <p className="text-sm text-muted-foreground">{basis}</p>
    </>
  );
  return (
    <Card>
      <CardContent className="py-4">
        {href ? (
          <Link
            href={href}
            className="block rounded-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            {body}
          </Link>
        ) : (
          body
        )}
      </CardContent>
    </Card>
  );
}

export function PipelineMoneyBand({
  money,
  windowDays,
}: {
  readonly money: PipelineMoneySummary;
  readonly windowDays: number;
}) {
  const t = useTranslations('admin.renewals.money');
  const currency = t('currency');

  const moneyHero = (satang: bigint) => (
    <>
      {formatSatangAsBaht(asSatang(satang))}{' '}
      <span className="text-sm font-normal text-muted-foreground">{currency}</span>
    </>
  );

  const rate = collectionRatePct(money.settledDueToDateSatang, money.overdueSatang);
  const rateHero = rate === null ? t('rateNone') : `${rate.toFixed(1)}%`;

  return (
    <section
      aria-label={t('title')}
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
    >
      <MoneyTile
        label={t('collectionRate.label')}
        hero={rateHero}
        basis={t('collectionRate.basis')}
      />
      <MoneyTile
        label={t('pastDue.label')}
        hero={moneyHero(money.overdueSatang)}
        basis={t('pastDue.basis')}
        href="/admin/renewals?month=overdue"
      />
      <MoneyTile
        label={t('collected.label')}
        hero={moneyHero(money.collectedThisPeriodSatang)}
        basis={t('collected.basis')}
        href="/admin/invoices?status=paid"
      />
      <MoneyTile
        label={t('dueSoon.label')}
        hero={moneyHero(money.dueSoonSatang)}
        basis={t('dueSoon.basis', { days: windowDays })}
        href="/admin/renewals?urgency=t-30"
      />
    </section>
  );
}
