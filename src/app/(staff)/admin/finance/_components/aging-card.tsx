/**
 * 124 US1.3 / US2.2 — Unpaid invoices by age. Five rows (Not yet due, 1–30,
 * 31–60, 61–90, Over 90 days) adding up to Outstanding; each row with any
 * invoice is one link named "{bucket}: {amount}, {count} invoices" to the
 * invoice list for exactly that range and the active filters (the loader's
 * `listQuery`), so the list shows the same count. Shares are of AMOUNT; a
 * non-zero share under 1% reads `<1%`.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { formatSharePercentages } from '@/lib/allocate-percentages';
import type { AgingBucket, InvoiceDashboardAging, InvoiceDashboardResult } from '@/modules/insights';
import { invoiceListHref } from '../_lib/dashboard-links';
import { formatAmount } from '../_lib/dashboard-format';
import { CardError, NoMatch } from './card-states';

/** Bar colour per bucket, as the boards draw them (chart tokens, AA in both themes). */
const BAR: Record<AgingBucket, string> = {
  not_yet_due: 'var(--aura-chart-2)',
  days_1_30: 'var(--aura-chart-7)',
  days_31_60: 'var(--aura-chart-3)',
  days_61_90: 'var(--aura-chart-8)',
  over_90: 'var(--aura-fg-danger)',
};

const ROW = 'grid min-h-11 grid-cols-[6.5rem_1fr_max-content_5.5rem] items-center gap-x-3 text-sm max-sm:grid-cols-[1fr_max-content_5rem] max-sm:gap-y-1.5';

export async function AgingCard({
  result,
  filtered,
}: {
  readonly result: Promise<InvoiceDashboardResult<InvoiceDashboardAging>> | InvoiceDashboardResult<InvoiceDashboardAging>;
  readonly filtered: boolean;
}) {
  const t = await getTranslations('admin.invoiceDashboard');
  const loaded = await result;
  const title = t('aging.title');
  const description = t('aging.description');
  if (!loaded.ok) {
    return (
      <Card title={title} description={description} headingLevel={2}>
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
  const aging = loaded.value;
  if (aging.count === 0 && filtered) {
    return (
      <Card title={title} description={description} headingLevel={2}>
        <NoMatch label={t('states.noMatch')} />
      </Card>
    );
  }

  const shares = formatSharePercentages(aging.buckets.map((b) => Number(b.amountSatang)));
  const overdue = aging.buckets.filter((b) => b.bucket !== 'not_yet_due');
  const overduePercent = overdue.reduce((sum, b) => sum + b.sharePercent, 0);
  const overdueCount = overdue.reduce((sum, b) => sum + b.count, 0);

  return (
    <Card
      title={title}
      description={description}
      headingLevel={2}
      footer={<p className="m-0 text-sm text-[var(--aura-fg-secondary)]">{t('aging.footer', { amount: formatAmount(aging.totalSatang) })}</p>}
    >
      <p className="m-0 mb-[var(--aura-space-3)] text-sm">
        <span className="font-semibold text-[var(--aura-fg-danger)]">{t('aging.lead', { percent: overduePercent })}</span>
        <span className="text-[var(--aura-fg-secondary)]">
          {' · '}
          {t('aging.leadOf', { overdue: overdueCount, total: aging.count })}
        </span>
      </p>
      <ul aria-label={t('aging.listLabel')} className="m-0 list-none p-0" data-testid="aging-rows">
        {aging.buckets.map((row, i) => {
          const label = t(`aging.bucket.${row.bucket}`);
          const amount = formatAmount(row.amountSatang);
          const cells = (
            <>
              <span className={row.bucket === 'over_90' ? 'font-medium text-[var(--aura-fg-danger)]' : undefined}>{label}</span>
              <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-[var(--aura-bg-surface-hover)] max-sm:col-span-3 max-sm:row-start-2">
                <span className="block h-full rounded-full" style={{ width: `${row.sharePercent}%`, background: BAR[row.bucket] }} />
              </span>
              <span className="text-right tabular-nums">{amount}</span>
              <span className="whitespace-nowrap text-right tabular-nums text-[var(--aura-fg-secondary)]">
                {row.count} · {shares[i]}
              </span>
            </>
          );
          return (
            <li key={row.bucket} className="border-t border-[var(--aura-border-subtle)] first:border-t-0">
              {row.count > 0 ? (
                <Link
                  href={invoiceListHref(row.listQuery)}
                  aria-label={t('aging.rowName', { bucket: label, amount, count: row.count })}
                  className={`${ROW} -mx-2 rounded-[var(--aura-radius-sm)] px-2 py-1.5 text-[var(--aura-fg-primary)] no-underline hover:bg-[var(--aura-bg-surface-hover)] focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]`}
                >
                  {cells}
                </Link>
              ) : (
                <div className={`${ROW} py-1.5 text-[var(--aura-fg-secondary)]`}>{cells}</div>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
