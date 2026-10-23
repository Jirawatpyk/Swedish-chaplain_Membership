/**
 * 124 US1.5 — Collected by payment method over the selected FY (to today in
 * the current one): six rows adding up to the Collected in FY tile. A share is
 * of the positive rows' total; a non-zero share under 1% reads `<1%`, a
 * negative or zero row 0%.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { formatSharePercentages } from '@/lib/allocate-percentages';
import type { InvoiceDashboardMethods, InvoiceDashboardResult } from '@/modules/insights';
import { formatAmount } from '../_lib/dashboard-format';
import { CardError, NoMatch } from './card-states';

export async function MethodsCard({
  result,
  filtered,
  fiscalYearShort,
}: {
  readonly result: Promise<InvoiceDashboardResult<InvoiceDashboardMethods>> | InvoiceDashboardResult<InvoiceDashboardMethods>;
  readonly filtered: boolean;
  readonly fiscalYearShort: string;
}) {
  const t = await getTranslations('admin.invoiceDashboard');
  const loaded = await result;
  const title = t('methods.title');
  if (!loaded.ok) {
    return (
      <Card title={title} description={t('methods.descriptionToDate', { fiscalYear: fiscalYearShort })} headingLevel={2}>
        <CardError
          copy={{
            title: t('states.cardError', { card: title }),
            description: t('states.cardErrorDescription', { referenceId: loaded.error.referenceId }),
            tryAgain: t('states.tryAgain'),
          }}
        />
      </Card>
    );
  }
  const methods = loaded.value;
  const description = methods.toDate
    ? t('methods.descriptionToDate', { fiscalYear: fiscalYearShort })
    : t('methods.descriptionWhole', { fiscalYear: fiscalYearShort });
  const empty = methods.rows.every((r) => r.amountSatang === 0n);
  if (empty && filtered) {
    return (
      <Card title={title} description={description} headingLevel={2}>
        <NoMatch label={t('states.noMatch')} />
      </Card>
    );
  }
  const shares = formatSharePercentages(methods.rows.map((r) => (r.amountSatang > 0n ? Number(r.amountSatang) : 0)));

  return (
    <Card
      title={title}
      description={description}
      headingLevel={2}
      footer={
        <p className="m-0 text-sm text-[var(--aura-fg-secondary)]">
          {t('methods.footer', { amount: formatAmount(methods.totalSatang) })}
        </p>
      }
    >
      <ul aria-label={t('methods.listLabel')} className="m-0 list-none p-0" data-testid="method-rows">
        {methods.rows.map((row, i) => (
          <li
            key={row.method}
            className="grid min-h-9 grid-cols-[6.5rem_1fr_max-content_2.5rem] items-center gap-x-3 text-sm max-sm:grid-cols-[1fr_max-content_2.5rem] max-sm:gap-y-1.5 max-sm:py-1"
          >
            <span>{t(`methods.method.${row.method}`)}</span>
            <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-[var(--aura-bg-surface-hover)] max-sm:col-span-3 max-sm:row-start-2">
              <span className="block h-full rounded-full bg-[var(--aura-chart-1)]" style={{ width: `${row.sharePercent}%` }} />
            </span>
            <span className="text-right tabular-nums">{formatAmount(row.amountSatang)}</span>
            <span className="text-right tabular-nums text-[var(--aura-fg-secondary)]">{shares[i]}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
