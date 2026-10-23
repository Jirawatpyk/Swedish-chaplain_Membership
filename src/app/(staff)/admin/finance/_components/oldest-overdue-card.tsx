/**
 * 124 US1.7 — Oldest overdue: the overdue set longest past due first (the
 * loader orders and limits it: 6 rows; a phone shows the first 3). Each row
 * offers the existing Record payment… dialog only when the loader says the
 * viewer may record payment (US4: a manager's HTML has no button). After a
 * payment the page refreshes and the paid row leaves the list, so focus goes
 * to the next row's button — its id is keyed by invoice, so it is the same
 * element before and after the refresh — or, from the last row, to the
 * "All overdue invoices" link. One table: below 640px its rows lay out as
 * cards, so there is one set of dialog triggers, never two.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import type { InvoiceDashboardOldestOverdue, InvoiceDashboardResult } from '@/modules/insights';
import { RecordPaymentDialog } from '../../invoices/_components/record-payment-dialog';
import { invoiceListHref, type InvoiceListQuery } from '../_lib/dashboard-links';
import { formatAmount, formatDay } from '../_lib/dashboard-format';
import { CardError, NoMatch } from './card-states';

export const OLDEST_OVERDUE_ALL_LINK_ID = 'oldest-overdue-all';

/** Shown on a phone; the rest of the six are hidden there. */
const PHONE_ROWS = 3;

function triggerIdOf(invoiceId: string): string {
  return `oldest-overdue-pay-${invoiceId}`;
}

export async function OldestOverdueCard({
  result,
  overdueCount,
  filtered,
  listFilters,
  locale,
  today,
}: {
  readonly result: Promise<InvoiceDashboardResult<InvoiceDashboardOldestOverdue>> | InvoiceDashboardResult<InvoiceDashboardOldestOverdue>;
  /** The Overdue tile's count, for the footer link; null when the tiles failed. */
  readonly overdueCount: number | null;
  readonly filtered: boolean;
  readonly listFilters: Pick<InvoiceListQuery, 'subject' | 'plan' | 'origin'>;
  readonly locale: string;
  readonly today: string;
}) {
  const t = await getTranslations('admin.invoiceDashboard');
  const loaded = await result;
  const title = t('oldest.title');
  const description = t('oldest.description');
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
  const { rows, canRecordPayment } = loaded.value;
  if (rows.length === 0) {
    return (
      <Card title={title} description={description} headingLevel={2}>
        <NoMatch label={filtered ? t('states.noMatch') : t('oldest.none')} />
      </Card>
    );
  }

  const allHref = invoiceListHref({ status: 'overdue', ...listFilters });
  const footer = (
    <Link id={OLDEST_OVERDUE_ALL_LINK_ID} href={allHref} className="text-sm font-medium">
      {t('oldest.allOverdue', { count: overdueCount ?? rows.length })}
    </Link>
  );
  const th = 'px-3 py-2 text-left font-mono text-xs uppercase tracking-wide text-[var(--aura-fg-secondary)]';

  return (
    <Card title={title} description={description} headingLevel={2} footer={footer}>
      <table className="w-full border-collapse text-sm max-sm:block" data-testid="oldest-overdue-table">
        <caption className="sr-only">{t('oldest.caption')}</caption>
        <thead className="max-sm:sr-only">
          <tr>
            <th scope="col" className={th}>{t('oldest.document')}</th>
            <th scope="col" className={th}>{t('oldest.buyer')}</th>
            <th scope="col" className={th}>{t('oldest.due')}</th>
            <th scope="col" className={`${th} text-right`}>{t('oldest.overdue')}</th>
            <th scope="col" className={`${th} text-right`}>{t('oldest.amount')}</th>
            {canRecordPayment ? (
              <th scope="col" className="sr-only">
                {t('oldest.actions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody className="max-sm:flex max-sm:flex-col max-sm:gap-[var(--aura-space-3)]">
          {rows.map((row, i) => {
            const document = row.documentNumber ?? '—';
            const amount = formatAmount(row.amountSatang);
            const next = rows[i + 1];
            return (
              <tr
                key={row.invoiceId}
                data-testid="oldest-overdue-row"
                className={`border-t border-[var(--aura-border-subtle)] max-sm:grid max-sm:grid-cols-[1fr_max-content] max-sm:gap-x-3 max-sm:gap-y-1 max-sm:rounded-[var(--aura-radius-md)] max-sm:border max-sm:p-3 ${i >= PHONE_ROWS ? 'max-sm:hidden' : ''}`}
              >
                <td className="px-3 py-2 max-sm:p-0">
                  <Link href={`/admin/invoices/${row.invoiceId}`} className="font-medium tabular-nums">
                    {document}
                  </Link>
                </td>
                <td className="px-3 py-2 max-sm:col-span-2 max-sm:row-start-2 max-sm:p-0">{row.buyerName ?? '—'}</td>
                <td className="px-3 py-2 tabular-nums max-sm:row-start-3 max-sm:p-0 max-sm:text-[var(--aura-fg-secondary)]">
                  <span className="sm:hidden">{t('oldest.dueOn', { date: formatDay(row.dueDate, locale) })}</span>
                  <span className="max-sm:hidden">{formatDay(row.dueDate, locale)}</span>
                </td>
                <td
                  className={`px-3 py-2 text-right tabular-nums text-[var(--aura-fg-danger)] max-sm:row-start-3 max-sm:p-0 ${i === 0 ? 'font-semibold' : ''}`}
                >
                  <span className="sm:hidden">{t('oldest.daysOverdue', { days: row.daysPastDue })}</span>
                  <span className="max-sm:hidden">{t('oldest.days', { days: row.daysPastDue })}</span>
                </td>
                <td className="px-3 py-2 text-right tabular-nums max-sm:col-start-2 max-sm:row-start-1 max-sm:p-0 max-sm:font-semibold">
                  {amount}
                </td>
                {canRecordPayment ? (
                  <td className="px-3 py-2 text-right max-sm:col-span-2 max-sm:p-0 max-sm:pt-2">
                    <RecordPaymentDialog
                      invoiceId={row.invoiceId}
                      documentNumber={row.documentNumber}
                      issueDate={null}
                      todayIso={today}
                      {...(row.buyerName ? { memberName: row.buyerName } : {})}
                      totalDisplay={amount}
                      triggerLabel={t('oldest.recordPayment')}
                      triggerAriaLabel={t('oldest.recordPaymentAria', { document })}
                      triggerVariant="ghost"
                      triggerSize="sm"
                      triggerId={triggerIdOf(row.invoiceId)}
                      triggerTestId="oldest-overdue-record-payment"
                      triggerClassName="max-sm:w-full"
                      finalFocusFallbackId={next ? triggerIdOf(next.invoiceId) : OLDEST_OVERDUE_ALL_LINK_ID}
                    />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </Card>
  );
}
