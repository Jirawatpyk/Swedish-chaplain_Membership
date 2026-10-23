/**
 * 124 US1.7 — Oldest overdue: the overdue set longest past due first (the
 * loader orders and limits it: 6 rows; a phone shows the first 3). Each row
 * offers the existing Record payment… dialog only when the loader says the
 * viewer may record payment (US4: a manager's HTML has no button).
 *
 * After a payment the page refreshes and the paid row leaves the list. Focus
 * goes to the next row's button — its id is keyed by invoice, so it is the
 * same element before and after the refresh — unless that row is hidden on a
 * phone (rows 4–6) or there is none: then to the card title, which renders in
 * every state of the card, so it is still there when the list empties.
 *
 * AURA's Table, stacked as cards below 640px, so a phone keeps the table's
 * row and cell semantics and one set of dialog triggers.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import type { InvoiceDashboardOldestOverdue, InvoiceDashboardResult } from '@/modules/insights';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import { RecordPaymentDialog } from '../../invoices/_components/record-payment-dialog';
import { invoiceListHref, type InvoiceListQuery } from '../_lib/dashboard-links';
import { formatAmount, formatDay } from '../_lib/dashboard-format';
import { CardError, NoMatch } from './card-states';

/** The card title's focus target (see the docblock). */
export const OLDEST_OVERDUE_TITLE_ID = 'oldest-overdue-title';

/** Shown on a phone; the rest of the six are hidden there. */
const PHONE_ROWS = 3;

/** 44px on a phone, where these links stand alone (US6.2). */
const PHONE_TARGET = 'max-sm:inline-flex max-sm:min-h-11 max-sm:items-center';

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
  const titleText = t('oldest.title');
  const title = (
    <span id={OLDEST_OVERDUE_TITLE_ID} tabIndex={-1} className="outline-none">
      {titleText}
    </span>
  );
  const description = t('oldest.description');
  if (!loaded.ok) {
    return (
      <Card title={title} description={description} headingLevel={2}>
        <CardError
          copy={{
            title: t('states.cardError', { card: titleText }),
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

  const footer = (
    <Link href={invoiceListHref({ status: 'overdue', ...listFilters })} className={`text-sm font-medium ${PHONE_TARGET}`}>
      {t('oldest.allOverdue', { count: overdueCount ?? rows.length })}
    </Link>
  );

  return (
    <Card title={title} description={description} headingLevel={2} footer={footer}>
      <Table
        data-testid="oldest-overdue-table"
        caption={t('oldest.caption')}
        captionHidden
        stackBelow="sm"
        stackStyle="cards"
        align="middle"
        bleed
      >
        <THead>
          <Tr>
            <Th>{t('oldest.document')}</Th>
            <Th>{t('oldest.buyer')}</Th>
            <Th>{t('oldest.due')}</Th>
            <Th numeric>{t('oldest.overdue')}</Th>
            <Th numeric>{t('oldest.amount')}</Th>
            {canRecordPayment ? <Th className="sr-only">{t('oldest.actions')}</Th> : null}
          </Tr>
        </THead>
        <TBody>
          {rows.map((row, i) => {
            const document = row.documentNumber ?? '—';
            const amount = formatAmount(row.amountSatang);
            const next = rows[i + 1];
            // The next row's button, while a phone shows it too; else the title.
            const fallback = next && i < PHONE_ROWS - 1 ? triggerIdOf(next.invoiceId) : OLDEST_OVERDUE_TITLE_ID;
            return (
              <Tr key={row.invoiceId} data-testid="oldest-overdue-row" className={i >= PHONE_ROWS ? 'max-sm:hidden' : undefined}>
                <Td card="title" mono>
                  <Link href={`/admin/invoices/${row.invoiceId}`} className={`font-medium ${PHONE_TARGET}`}>
                    {document}
                  </Link>
                </Td>
                <Td label={t('oldest.buyer')}>{row.buyerName ?? '—'}</Td>
                <Td label={t('oldest.due')} className="whitespace-nowrap">
                  {formatDay(row.dueDate, locale)}
                </Td>
                <Td
                  label={t('oldest.overdue')}
                  numeric
                  className={`text-[var(--aura-fg-danger)] ${i === 0 ? 'font-semibold' : ''}`}
                >
                  {t('oldest.days', { days: row.daysPastDue })}
                </Td>
                <Td label={t('oldest.amount')} numeric>
                  {amount}
                </Td>
                {canRecordPayment ? (
                  <Td card="action">
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
                      finalFocusFallbackId={fallback}
                    />
                  </Td>
                ) : null}
              </Tr>
            );
          })}
        </TBody>
      </Table>
    </Card>
  );
}
