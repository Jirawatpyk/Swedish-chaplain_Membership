/**
 * 088 T065b (FR-031, ภ.พ.30 support) — admin tax-document registers page.
 *
 * A period view surfacing the registers an accountant needs for the monthly
 * Thai VAT return (ภ.พ.30):
 *   - the §86/4 RC tax-receipt register (output-VAT),
 *   - the §80/1(5) zero-rate sales list, and
 *   - the §105 RE receipt register (no-TIN sales — also standard-rated 7%).
 *
 * The page ALSO surfaces the period ภ.พ.30 output-VAT figure (§86/4 + §105,
 * combined) on every register view, so the reported total is never understated
 * (B2 review FINDING 1).
 *
 * Kept as a SEPARATE page (not a mode on the hot-path invoice list) so the
 * register — a distinct, period-scoped, RD-audit surface — carries zero
 * regression risk to the operational list. Admin-only + gated on
 * `FEATURE_088_TAX_AT_PAYMENT` (404 otherwise). The heavy lifting is the
 * `listTaxDocumentRegister` use-case (live-Neon integration-tested); this page
 * is a thin server render over its output.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';

import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { formatSatangThb } from '@/lib/format-thb';
import { listTaxDocumentRegister, makeListTaxDocumentRegisterDeps } from '@/modules/invoicing';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { TaxRegisterForm } from './_components/tax-register-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.registers.meta');
  return { title: t('title') };
}

type RegisterKind = 'rc_register' | 'zero_rate_sales' | 're_register';

const YMD = /^\d{4}-\d{2}-\d{2}$/;

interface SearchParams {
  readonly kind?: string;
  readonly from?: string;
  readonly to?: string;
}

/** Bangkok is UTC+7 (no DST). */
function todayBangkokYmd(): string {
  const d = new Date(Date.now() + 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export default async function TaxRegistersPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireSession('staff');
  // Admin-only tax-filing tool + flag-gated: a manager (read-only on finance)
  // or a flag-off tenant gets a clean 404 rather than an empty surface.
  if (user.role !== 'admin' || !env.features.f088TaxAtPayment) {
    notFound();
  }

  const t = await getTranslations('admin.invoices.registers');
  const locale = await getLocale();
  const query = await searchParams;
  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const kind: RegisterKind =
    query.kind === 'zero_rate_sales'
      ? 'zero_rate_sales'
      : query.kind === 're_register'
        ? 're_register'
        : 'rc_register';
  const today = todayBangkokYmd();
  const from = query.from && YMD.test(query.from) ? query.from : `${today.slice(0, 8)}01`;
  const to = query.to && YMD.test(query.to) ? query.to : today;

  const result = await listTaxDocumentRegister(makeListTaxDocumentRegisterDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    kind,
    from,
    to,
  });

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('description')}
        actions={
          <Link href="/admin/invoices" className={buttonVariants({ variant: 'outline' })}>
            {t('backToList')}
          </Link>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <TaxRegisterForm initialKind={kind} initialFrom={from} initialTo={to} />

          {!result.ok ? (
            <p className="py-8 text-center text-sm text-destructive" role="alert">
              {result.error.code === 'invalid_range'
                ? t('errors.invalidRange')
                : t('errors.loadFailed')}
            </p>
          ) : (
            <>
              {/* 088 B2 review FINDING 1 — the period ภ.พ.30 output-VAT figure.
                  ALWAYS shown when the range is valid (independent of the
                  selected register / its row count) because it is a PERIOD
                  total across BOTH standard-rated streams (§86/4 RC + §105 RE),
                  not the selected register's subtotal. Excluding §105 would
                  understate the seller's output-VAT liability. */}
              <section
                aria-labelledby="output-vat-heading"
                className="rounded-lg border bg-muted/40 p-4"
                data-testid="period-output-vat"
              >
                <h2 id="output-vat-heading" className="text-sm font-medium text-muted-foreground">
                  {t('outputVat.title')}
                </h2>
                <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
                  <span className="text-2xl font-semibold tabular-nums">
                    {formatSatangThb(
                      BigInt(result.value.periodOutputVat.combinedVatSatang),
                      locale,
                    )}
                  </span>
                  <span className="text-sm text-muted-foreground">{t('outputVat.combined')}</span>
                </p>
                <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                  {t('outputVat.rc')}{' '}
                  {formatSatangThb(BigInt(result.value.periodOutputVat.rcVatSatang), locale)}
                  {' · '}
                  {t('outputVat.re')}{' '}
                  {formatSatangThb(BigInt(result.value.periodOutputVat.reVatSatang), locale)}
                </p>
                {/* R3 — make the §86/10 credit-note reduction VISIBLE:
                    gross (RC + RE) − credit notes = the net figure above. */}
                <p className="mt-1 text-sm tabular-nums text-muted-foreground">
                  {t('outputVat.gross')}{' '}
                  {formatSatangThb(
                    BigInt(result.value.periodOutputVat.rcVatSatang) +
                      BigInt(result.value.periodOutputVat.reVatSatang),
                    locale,
                  )}
                  {' − '}
                  {t('outputVat.creditNote')}{' '}
                  {formatSatangThb(
                    BigInt(result.value.periodOutputVat.creditNoteVatSatang),
                    locale,
                  )}
                </p>
                <p className="mt-2 text-xs text-muted-foreground">{t('outputVat.note')}</p>
              </section>

              {result.value.rows.length === 0 ? (
                <p className="py-12 text-center text-muted-foreground">{t('empty')}</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground" data-testid="register-summary">
                    {t('summary.count', { count: result.value.summary.rowCount })}
                    {' · '}
                    {t('summary.subtotal')}{' '}
                    {formatSatangThb(BigInt(result.value.summary.totalSubtotalSatang), locale)}
                    {' · '}
                    {t('summary.vat')}{' '}
                    {formatSatangThb(BigInt(result.value.summary.totalVatSatang), locale)}
                    {' · '}
                    {t('summary.total')}{' '}
                    {formatSatangThb(BigInt(result.value.summary.totalSatang), locale)}
                  </p>
                  <div className="overflow-x-auto">
                    <table className="w-full min-w-[48rem] border-collapse text-sm">
                      <caption className="sr-only">{t('title')}</caption>
                      <thead>
                        <tr className="border-b text-left text-muted-foreground">
                          <th scope="col" className="py-2 pr-4 font-medium">
                            {t('columns.receiptNo')}
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium">
                            {t('columns.paidDate')}
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium">
                            {t('columns.buyer')}
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium">
                            {t('columns.taxId')}
                          </th>
                          <th scope="col" className="py-2 pr-4 text-right font-medium">
                            {t('columns.subtotal')}
                          </th>
                          <th scope="col" className="py-2 pr-4 text-right font-medium">
                            {t('columns.vat')}
                          </th>
                          <th scope="col" className="py-2 pr-4 text-right font-medium">
                            {t('columns.total')}
                          </th>
                          <th scope="col" className="py-2 pr-4 font-medium">
                            {t('columns.vatTreatment')}
                          </th>
                          <th scope="col" className="py-2 font-medium">
                            {t('columns.certNo')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.value.rows.map((r) => {
                          // R1 — a VOIDED (cancelled) receipt stays LISTED (RD:
                          // cancelled tax invoices appear in the sales report)
                          // but must NOT read as a live sale: mute the row,
                          // strike the number, and tag it "Cancelled". Its VAT
                          // is already excluded from the totals + output-VAT.
                          const isVoid = r.status === 'void';
                          return (
                            <tr
                              key={r.invoiceId}
                              className={
                                isVoid
                                  ? 'border-b text-muted-foreground last:border-0'
                                  : 'border-b last:border-0'
                              }
                              data-testid={isVoid ? 'register-row-void' : undefined}
                            >
                            <td className="py-2 pr-4 font-medium tabular-nums">
                              <span className={isVoid ? 'line-through' : undefined}>
                                {r.receiptDocumentNumberRaw ?? '—'}
                              </span>
                              {isVoid ? (
                                <span className="ml-2 inline-flex items-center rounded-full border border-destructive/40 px-2 py-0.5 align-middle text-xs font-medium text-destructive">
                                  {t('cancelled')}
                                </span>
                              ) : null}
                            </td>
                            <td className="py-2 pr-4 tabular-nums">
                              {r.paidAt ? bangkokLocalDate(r.paidAt) : '—'}
                            </td>
                            <td className="py-2 pr-4">
                              {r.memberIdentitySnapshot?.legal_name ?? '—'}
                            </td>
                            <td className="py-2 pr-4 tabular-nums">
                              {r.memberIdentitySnapshot?.tax_id ?? '—'}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatSatangThb(r.subtotal?.satang ?? null, locale)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatSatangThb(r.vat?.satang ?? null, locale)}
                            </td>
                            <td className="py-2 pr-4 text-right tabular-nums">
                              {formatSatangThb(r.total?.satang ?? null, locale)}
                            </td>
                            <td className="py-2 pr-4">
                              {r.vatTreatment === 'zero_rated_80_1_5'
                                ? t('vatTreatment.zeroRated')
                                : t('vatTreatment.standard')}
                            </td>
                            <td className="py-2 tabular-nums">{r.zeroRateCertNo ?? '—'}</td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </TableContainer>
  );
}
