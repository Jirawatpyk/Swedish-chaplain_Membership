/**
 * Spec 122 US8c (T846) — the tax-document registers page body, rendered by the
 * page and by the no-DB preview route (`/test-fixtures/aura-admin?view=
 * registers`), boards `Admin-invoice-registers` (+ `-mobile`) and
 * `Admin-registers-*` (spec Session 2026-10-03):
 *
 *   the header with Back to invoices → one card: the register form, then the
 *   period output VAT box, the summary line and the register (or the empty
 *   state / the error).
 *
 * Every figure is the use case's output put through the page's own
 * `formatSatangThb`; the only sum here is the gross (RC + RE), as before.
 * User story 8: the row count and totals must equal `main` exactly.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Alert, Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import type { ListTaxDocumentRegisterError, ListTaxDocumentRegisterOutput } from '@/modules/invoicing';
import type { Result } from '@/lib/result';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { formatSatangThb } from '@/lib/format-thb';
import { PageHeader } from '@/components/layout/page-header';
import { TaxRegisterForm } from './tax-register-form';
import { TaxRegisterTable, type TaxRegisterRowView } from './tax-register-table';

export type RegisterKind = 'rc_register' | 'zero_rate_sales' | 're_register';

export interface TaxRegisterViewProps {
  readonly kind: RegisterKind;
  readonly from: string;
  readonly to: string;
  readonly result: Result<ListTaxDocumentRegisterOutput, ListTaxDocumentRegisterError>;
}

export async function renderTaxRegisterView({ kind, from, to, result }: TaxRegisterViewProps) {
  const t = await getTranslations('admin.invoices.registers');
  const locale = await getLocale();
  const thb = (satang: string | bigint | null) =>
    formatSatangThb(satang === null ? null : BigInt(satang), locale);

  return (
    <>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={
          <Link href="/admin/invoices" className={buttonClass({ variant: 'secondary', touchHeight: true })}>
            {t('backToList')}
          </Link>
        }
      />
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        <div className="flex flex-col gap-[var(--aura-space-4)]">
          <TaxRegisterForm initialKind={kind} initialFrom={from} initialTo={to} />

          {!result.ok ? (
            <Alert tone="danger" role="alert">
              {result.error.code !== 'invalid_range'
                ? t('errors.loadFailed')
                : result.error.reason === 'not_a_date'
                  ? t('errors.invalidDate')
                  : t('errors.invalidRange')}
            </Alert>
          ) : (
            <>
              {/* 088 B2 review FINDING 1 — the period ภ.พ.30 output-VAT figure,
                  ALWAYS shown for a valid range (independent of the selected
                  register and its row count): a PERIOD total across BOTH
                  standard-rated streams (§86/4 RC + §105 RE). */}
              <section
                aria-labelledby="output-vat-heading"
                className="flex flex-col gap-[var(--aura-space-2)] rounded-[var(--aura-radius-lg)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface-hover)] p-[var(--aura-space-4)]"
                data-testid="period-output-vat"
              >
                <h2 id="output-vat-heading" className="m-0 text-sm font-medium text-[var(--aura-fg-secondary)]">
                  {t('outputVat.title')}
                </h2>
                <p className="m-0 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-2xl font-semibold tabular-nums">
                    {thb(result.value.periodOutputVat.combinedVatSatang)}
                  </span>
                  <span className="text-sm text-[var(--aura-fg-secondary)]">{t('outputVat.combined')}</span>
                </p>
                <p className="m-0 text-sm tabular-nums">
                  {t('outputVat.rc')} {thb(result.value.periodOutputVat.rcVatSatang)}
                  {' · '}
                  {t('outputVat.re')} {thb(result.value.periodOutputVat.reVatSatang)}
                </p>
                {/* R3 — make the §86/10 credit-note reduction VISIBLE:
                    gross (RC + RE) − credit notes = the net figure above. */}
                <p className="m-0 text-sm tabular-nums">
                  {t('outputVat.gross')}{' '}
                  {thb(
                    BigInt(result.value.periodOutputVat.rcVatSatang) +
                      BigInt(result.value.periodOutputVat.reVatSatang),
                  )}
                  {/* The minus carries the meaning; some screen-reader
                      punctuation levels skip U+2212, so say it too. */}
                  <span aria-hidden="true">{' − '}</span>
                  <span className="sr-only"> {t('outputVat.less')} </span>
                  {t('outputVat.creditNote')} {thb(result.value.periodOutputVat.creditNoteVatSatang)}
                </p>
                {/* The note folds under "About this figure" on a phone (board
                    mobile); wider screens show it in full. */}
                <p className="m-0 text-xs text-[var(--aura-fg-secondary)] max-sm:hidden">{t('outputVat.note')}</p>
                <details className="text-xs text-[var(--aura-fg-secondary)] sm:hidden">
                  <summary className="cursor-pointer py-2 text-sm text-[var(--aura-fg-primary)]">
                    {t('outputVat.about')}
                  </summary>
                  <p className="m-0">{t('outputVat.note')}</p>
                </details>
                {/* Only a closed calendar month is "the figure to report" —
                    every other status is a caution against filing it as-is. */}
                {result.value.periodStatus === 'closed_month' ? (
                  <p className="m-0 text-sm font-medium" data-testid="period-output-vat-status">
                    {t('outputVat.status.closedMonth')}
                  </p>
                ) : (
                  <Alert tone="warning" data-testid="period-output-vat-status">
                    {result.value.periodStatus === 'closed_month_incomplete'
                      ? t('outputVat.status.closedMonthIncomplete', { count: result.value.legacyCombinedCount })
                      : result.value.periodStatus === 'month_to_date'
                        ? t('outputVat.status.monthToDate')
                        : t('outputVat.status.notAMonth')}
                  </Alert>
                )}
              </section>

              {result.value.rows.length === 0 ? (
                <EmptyState icon="file-text" title={t('empty')} headingLevel={2} />
              ) : (
                <>
                  <p className="m-0 text-sm text-[var(--aura-fg-secondary)]" data-testid="register-summary">
                    {t('summary.count', { count: result.value.summary.rowCount })}
                    {result.value.summary.cancelledCount > 0 ? (
                      <> {t('summary.cancelled', { count: result.value.summary.cancelledCount })}</>
                    ) : null}
                    {' · '}
                    {t('summary.subtotal')} {thb(result.value.summary.totalSubtotalSatang)}
                    {' · '}
                    {t('summary.vat')} {thb(result.value.summary.totalVatSatang)}
                    {' · '}
                    {t('summary.total')} {thb(result.value.summary.totalSatang)}
                  </p>
                  <TaxRegisterTable
                    rows={result.value.rows.map(
                      (r): TaxRegisterRowView => ({
                        invoiceId: r.invoiceId,
                        isVoid: r.status === 'void',
                        receiptNo: r.receiptDocumentNumberRaw ?? '—',
                        // The SAME date the row was BUCKETED under: the §78/1
                        // payment-date tax point, falling back to the
                        // Bangkok-local paid_at for a legacy receipt (mirrors
                        // the repo's COALESCE(payment_date, paid_at) filter).
                        paymentDate: r.paymentDate ?? (r.paidAt ? bangkokLocalDate(r.paidAt) : '—'),
                        buyer: r.memberIdentitySnapshot?.legal_name ?? '—',
                        taxId: r.memberIdentitySnapshot?.tax_id ?? '—',
                        subtotal: thb(r.subtotal?.satang ?? null),
                        vat: thb(r.vat?.satang ?? null),
                        total: thb(r.total?.satang ?? null),
                        zeroRated: r.vatTreatment === 'zero_rated_80_1_5',
                        certNo: r.zeroRateCertNo ?? '—',
                      }),
                    )}
                  />
                </>
              )}
            </>
          )}
        </div>
      </Card>
    </>
  );
}
