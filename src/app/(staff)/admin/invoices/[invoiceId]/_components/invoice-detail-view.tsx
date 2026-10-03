/**
 * Spec 122 US8b (T822–T823) — the invoice detail page's markup once its data
 * is loaded, split out so the no-DB preview route renders the page's own
 * layout (the US5b-1 member-detail pattern). Every read and every derived
 * value (display status, totals, refund headroom, banners) stays in the page;
 * this view only lays them out.
 *
 * The one layout (spec Session 2026-10-02 US8b, board `Admin-voided`):
 *
 *   "Invoice {number}" (a draft reads "Draft invoice") with the status pill in
 *   the list's tone → the alerts → a Details card (the fields, then the totals
 *   at its end) → Payment details → Voided → Credit notes → Line items →
 *   Payment activity, each in its own card.
 */
import { Suspense, type ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import {
  billFirstDocumentNumber,
  invoiceStatusHasReceipt,
  isSupersessionLinkLive,
  type CreditNote,
  type Invoice,
  type InvoiceSupersessionLink,
} from '@/modules/invoicing';
import { formatCalendarYear, formatLocalisedDate } from '@/lib/format-date-localised';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { NoPrimaryContactBanner } from '@/components/members/no-primary-contact-banner';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import { invoiceStatusTone, type InvoiceDisplayStatus } from '@/components/invoices/invoice-status-tone';
import { IssueInvoiceDialog } from '../../_components/issue-invoice-dialog';
import { RecordPaymentDialog } from '../../_components/record-payment-dialog';
import { DeleteDraftDialog } from '../../_components/delete-draft-dialog';
import { InvoiceMoreMenu } from '../../_components/invoice-more-menu';
import { EmailFailureAlert } from '../../_components/email-failure-alert';
import { AutoRefundFailedAlert } from '../../_components/auto-refund-failed-alert';
import { RefundDialog } from './refund-dialog';
import { IssueCreditNoteAction } from './issue-credit-note-action';
import { InvoiceActionBar } from './invoice-action-bar';
import type { PaymentDetailsView } from '../_lib/payment-details';

// F5 UX D2 — the out-of-band-refund reconciliation runbook (repo-relative doc
// path, same literal the `auto_refund_failed_needs_manual_reconcile` forensic
// stamps into its payload). Surfaced to the admin so they can follow it.
const OOB_RUNBOOK_URL = 'docs/runbooks/out-of-band-refund.md';

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  // N11 — explicit `'en-US'` locale pins thousand-separator output on
  // Vercel runtimes whose process locale may be `C`/`POSIX` (emits no
  // separator). Thai-tax amounts are legal figures; deterministic
  // formatting is required by FR-005.
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/**
 * The heading's noun names the document by its type (maintainer, 3 Oct): an
 * 088 bill is always "Invoice {SC}", paid or not (its header is the bill); the
 * event-fee already-paid flow issues no bill, only a combined tax
 * invoice/receipt for a TIN buyer or a §105 receipt for a buyer without one.
 */
function headingKey(
  pdfDocKind: Invoice['pdfDocKind'],
  taxDocKind: InvoiceDetailViewProps['taxDocKind'],
): 'title' | 'titleTaxInvoiceReceipt' | 'titleReceipt' {
  if (taxDocKind !== 'none') return 'title';
  if (pdfDocKind === 'receipt_combined') return 'titleTaxInvoiceReceipt';
  if (pdfDocKind === 'receipt_separate') return 'titleReceipt';
  return 'title';
}

/** A labelled value in a card's field grid. */
function Field({ label, children, wide = false }: { readonly label: ReactNode; readonly children: ReactNode; readonly wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

const FIELD_GRID = 'grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2';
const MONO_LINK =
  'rounded-xs font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--aura-focus-ring)]';

export interface InvoiceDetailFailedEmailBanner {
  readonly variant: 'invoice' | 'receipt';
  readonly recipientEmail: string;
  readonly canResend: boolean;
}

export interface InvoiceDetailViewProps {
  readonly invoice: Invoice;
  /** The route's `[invoiceId]` as typed, for the breadcrumb match. */
  readonly routeSegment: string;
  /** The status shown: `overdue` once an issued bill is past due, else the stored status. */
  readonly displayStatus: InvoiceDisplayStatus;
  /** The number the page reads under (the SC bill for an 088 bill), or `null` for a draft. */
  readonly headerNumber: string | null;
  /** `displayDocumentNumber(invoice)`: the download name and the β receipt fallback. */
  readonly displayNumber: string | null;
  readonly taxDocKind: 'none' | 'bill' | 'tax_receipt' | (string & {});
  /** A voided unpaid 088 bill's SC number, which is kept rather than retired. */
  readonly voidedBill: string | null;
  readonly memberDisplayName: string;
  readonly planDisplayName: string;
  readonly buyerHasTaxId: boolean;
  readonly buyerIsVatRegistrant: boolean;
  readonly showNoPrimaryContactBanner: boolean;
  readonly paymentRecordedByEmail: string;
  readonly voidedByEmail: string;
  readonly paymentDetails: Pick<PaymentDetailsView, 'methodKey' | 'notes'>;
  readonly creditNotes: readonly CreditNote[];
  readonly replacedBy: InvoiceSupersessionLink | null;
  readonly replaces: readonly InvoiceSupersessionLink[];
  /** `invoicing.write` — every mutating action and the admin-only alerts. */
  readonly isAdmin: boolean;
  readonly hasReceiptPdf: boolean;
  readonly failedEmailBanners: readonly InvoiceDetailFailedEmailBanner[];
  readonly autoRefund: { readonly failed: boolean; readonly processorRefundId: string | null };
  /** A draft's live preview, or the issued snapshot. */
  readonly totals: {
    readonly subtotalSatang: bigint | null;
    readonly vatSatang: bigint | null;
    readonly totalSatang: bigint | null;
    readonly vatPercent: string | null;
  };
  readonly refundSettling: boolean;
  readonly refund: {
    readonly paymentId: string;
    readonly remainingRefundableSatang: bigint;
    readonly pendingRefundExists: boolean;
  } | null;
  /** Asia/Bangkok "today", for the Record-payment date clamp. */
  readonly bangkokTodayIso: string;
  /** `env.features.f088TaxAtPayment`. */
  readonly taxAtPayment: boolean;
  readonly locale: string;
  /** The payment activity card (the page streams it in its own Suspense); `null` for a draft. */
  readonly paymentActivity: ReactNode | null;
}

export async function renderInvoiceDetailView({
  invoice,
  routeSegment,
  displayStatus,
  headerNumber,
  displayNumber,
  taxDocKind,
  voidedBill,
  memberDisplayName,
  planDisplayName,
  buyerHasTaxId,
  buyerIsVatRegistrant,
  showNoPrimaryContactBanner,
  paymentRecordedByEmail,
  voidedByEmail,
  paymentDetails,
  creditNotes,
  replacedBy,
  replaces,
  isAdmin,
  hasReceiptPdf,
  failedEmailBanners,
  autoRefund,
  totals,
  refundSettling,
  refund,
  bangkokTodayIso,
  taxAtPayment,
  locale: userLocale,
  paymentActivity,
}: InvoiceDetailViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.invoices.detail');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const isDraft = invoice.status === 'draft';
  const number = headerNumber ?? displayNumber;
  const breadcrumbLabel = number ?? t('draftTitle');
  const dateOnly = { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' } as const;
  const instant = { year: 'numeric', month: 'short', day: 'numeric' } as const;
  // The phone bar's line: what the bill comes to, and when it is due while it
  // is still owed (board Admin-invoice-issued-mobile). No line for a draft (a
  // preview) or a void bill.
  const totalText = totals.totalSatang !== null ? formatSatang(totals.totalSatang) : null;
  const phoneSummary =
    totalText === null || isDraft || invoice.status === 'void'
      ? null
      : invoice.status === 'issued' && invoice.dueDate
        ? t('phoneBar.totalDue', { total: totalText, date: formatLocalisedDate(invoice.dueDate, userLocale, dateOnly) })
        : t('phoneBar.total', { total: totalText });

  // The bar (and, from 640px, the header's action row) only when it has
  // something to hold: a manager on a draft, or a void bill with no PDF, has
  // no action and no summary line, and an empty fixed bar is a stray strip.
  const hasMenu = !isDraft && (Boolean(invoice.pdf) || hasReceiptPdf || (invoice.status === 'issued' && isAdmin));
  const hasActions =
    (isAdmin && (isDraft || invoice.status === 'issued' || invoice.status === 'paid' || invoice.status === 'partially_credited')) ||
    refund !== null ||
    hasMenu;
  const showActionBar = hasActions || phoneSummary !== null;

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={routeSegment} label={breadcrumbLabel} />
      <PageHeader
        // 088 A-refined — the header ALWAYS reads under the invoice's OWN (SC)
        // bill number for a real 088 bill (paid or unpaid, never "Draft
        // invoice"); a paid bill's RC §86/4 tax receipt is surfaced in the
        // "Receipt No." field below.
        title={number !== null ? t(headingKey(invoice.pdfDocKind, taxDocKind), { number }) : t('draftTitle')}
        badge={<StatusPill tone={invoiceStatusTone(displayStatus)}>{tStatus(displayStatus)}</StatusPill>}
        actions={
          showActionBar ? (
          <InvoiceActionBar summary={phoneSummary}>
            {isDraft && isAdmin && (
              <>
                <a
                  href={`/api/invoices/${invoice.invoiceId}/preview`}
                  className={buttonClass({ variant: 'secondary', touchHeight: true })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('actions.preview')}
                </a>
                <DeleteDraftDialog invoiceId={invoice.invoiceId} />
                <IssueInvoiceDialog
                  invoiceId={invoice.invoiceId}
                  // 066 — only MEMBERSHIP no-TIN buyers get the input-VAT note;
                  // events are issue-blocked (event_no_tin_requires_paid_issue),
                  // so the hint would never apply to them.
                  showNoTaxIdHint={invoice.invoiceSubject === 'membership' && !buyerHasTaxId}
                  // 088 T017a / FR-027 — pre-issue review + immutable-snapshot
                  // acknowledgement, gated by the tax-at-payment flag.
                  taxAtPayment={taxAtPayment}
                  isMembership={invoice.invoiceSubject === 'membership'}
                  buyerIsVatRegistrant={buyerIsVatRegistrant}
                  // 088 US8 (T061d) — draft subtotal in satang (plain number;
                  // a bigint cannot cross the RSC → client-prop boundary)
                  // drives the ≥ 5,000 THB zero-rate advisory in the form.
                  subtotalSatang={totals.subtotalSatang !== null ? Number(totals.subtotalSatang) : null}
                  summary={{
                    memberName: memberDisplayName,
                    planDisplayName,
                    // 054-event-fee-invoices — membership invoices always carry
                    // plan_year (`invoices_subject_fields_ck`); coalesce for type.
                    planYear: invoice.planYear ?? 0,
                    subtotalText: formatSatang(totals.subtotalSatang),
                    vatText: formatSatang(totals.vatSatang),
                    vatPercent: totals.vatPercent ?? '',
                    totalText: formatSatang(totals.totalSatang),
                  }}
                />
              </>
            )}
            {invoice.status === 'issued' && isAdmin && (
              <RecordPaymentDialog
                invoiceId={invoice.invoiceId}
                // 088 FR-030 — bill-first: an issued 088 bill's number is its SC
                // (`billDocumentNumberRaw`); legacy §87 rows keep documentNumber.
                documentNumber={billFirstDocumentNumber(invoice)}
                issueDate={invoice.issueDate}
                todayIso={bangkokTodayIso}
              />
            )}
            {invoice.status === 'issued' && isAdmin && (
              // Void — destructive terminal action on issued-unpaid invoices
              // (US5 / FR-008). Routes to the typed-phrase confirm page: a
              // typed-phrase gate is high-friction by design and deserves its
              // own route for deep-linking (CP-9.3).
              <Link
                href={`/admin/invoices/${invoice.invoiceId}/void`}
                // Below 640px Void… moves into the ⋯ menu (the phone bar).
                className={`${buttonClass({ variant: 'danger-secondary' })} max-sm:hidden`}
                data-testid="void-invoice-trigger"
              >
                {t('actions.void')}
              </Link>
            )}
            {(invoice.status === 'paid' || invoice.status === 'partially_credited') && isAdmin && (
              <IssueCreditNoteAction invoiceId={invoice.invoiceId} refundSettling={refundSettling} />
            )}
            {/* F5 Phase 6 (T112) — Refund online payment: only when there is a
                succeeded F5 payment with refundable balance left. */}
            {refund && (
              // RefundDialog reads useSearchParams(): without a Suspense
              // boundary Next.js bails the whole page out to CSR.
              <Suspense
                fallback={
                  // Reserves the button's space so the row does not shift
                  // while the dialog hydrates.
                  <div aria-hidden="true" className="h-9 w-32 opacity-0 max-sm:h-11" />
                }
              >
                <RefundDialog
                  paymentId={refund.paymentId}
                  invoiceId={invoice.invoiceId}
                  memberCompanyName={memberDisplayName}
                  remainingRefundableSatang={refund.remainingRefundableSatang}
                  currencyCode={
                    (invoice.tenantIdentitySnapshot as { currency_code?: string } | null)?.currency_code ?? 'THB'
                  }
                  // 0306 — a full refund of a membership invoice asks Keep /
                  // End membership; "full" = the invoice's un-credited headroom.
                  invoiceSubject={invoice.invoiceSubject}
                  invoiceHeadroomSatang={invoice.total ? invoice.total.satang - invoice.creditedTotal.satang : 0n}
                  receiptDocumentNumberRaw={invoice.receiptDocumentNumberRaw}
                  // 088 FR-030 — bill-first for an 088 bill (documentNumber NULL).
                  invoiceDocumentNumber={billFirstDocumentNumber(invoice)}
                  // Gap E — disabled and "settling" while a pending async
                  // refund exists for this payment.
                  pendingRefundExists={refund.pendingRefundExists}
                />
              </Suspense>
            )}
            {/* Downloads and resends in one ⋯ menu; it renders nothing when
                there is nothing to show (T107 visibility rules inside). */}
            {!isDraft && (
              <InvoiceMoreMenu
                invoiceId={invoice.invoiceId}
                // 064 remediation S2 — display number, never a raw UUID; 088
                // FR-030 — the SC bill number before the UUID.
                documentNumber={displayNumber ?? invoice.billDocumentNumberRaw ?? invoice.invoiceId}
                // 088 (T065 review fix) — a paid 088 bill's MAIN PDF is the
                // non-tax SC bill, so the download is named by the SC number.
                {...(taxDocKind === 'tax_receipt' && invoice.billDocumentNumberRaw
                  ? { invoiceDownloadNumber: invoice.billDocumentNumberRaw }
                  : {})}
                showDownload={Boolean(invoice.pdf)}
                showResendInvoice={isAdmin && invoice.status !== 'void' && Boolean(invoice.pdf)}
                showResendReceipt={isAdmin && hasReceiptPdf}
                showDownloadReceipt={hasReceiptPdf}
                showVoid={invoice.status === 'issued' && isAdmin}
                // 064 remediation A4 — what the main pdf IS.
                mainDownloadKind={
                  invoice.pdfDocKind === 'receipt_combined'
                    ? 'combined'
                    : invoice.pdfDocKind === 'receipt_separate'
                      ? 'receipt'
                      : invoice.pdfDocKind === 'invoice' && invoice.billDocumentNumberRaw !== null
                        ? 'bill'
                        : undefined
                }
              />
            )}
          </InvoiceActionBar>
          ) : undefined
        }
      />

      {/* 108 FR-003 — no live primary contact, so this invoice's receipt, void
          notice and credit note reach nobody: seen before acting. */}
      {showNoPrimaryContactBanner && invoice.memberId !== null && (
        <NoPrimaryContactBanner memberId={invoice.memberId} contactsHref={`/admin/members/${invoice.memberId}`} />
      )}
      {/* FR-026 — one delivery-failure alert per failed document (admins only). */}
      {isAdmin &&
        failedEmailBanners.map((b) => (
          <EmailFailureAlert
            key={b.variant}
            invoiceId={invoice.invoiceId}
            recipientEmail={b.recipientEmail}
            variant={b.variant}
            canResend={b.canResend}
          />
        ))}
      {/* F5 UX D2 — a failed stale-invoice auto-refund (money not returned). */}
      {isAdmin && autoRefund.failed && (
        <AutoRefundFailedAlert
          invoiceId={invoice.invoiceId}
          processorRefundId={autoRefund.processorRefundId}
          runbookUrl={OOB_RUNBOOK_URL}
        />
      )}

      <Card title={t('detailsTitle')} titleId="invoice-details-heading" headingLevel={2}>
        <div className="flex flex-col gap-6">
          <dl className={FIELD_GRID}>
            <Field label={t('fields.memberId')}>
              {/* Non-member event buyer: plain text — a member link would href
                  /admin/members/null and 404 (the list's buyer-column rule). */}
              {invoice.memberId !== null ? (
                <Link
                  href={`/admin/members/${invoice.memberId}`}
                  className="text-[var(--aura-fg-accent)] underline-offset-2 hover:underline"
                >
                  {memberDisplayName}
                </Link>
              ) : (
                memberDisplayName
              )}
            </Field>
            {/* Membership only: an event-fee invoice carries no plan. */}
            {invoice.invoiceSubject === 'membership' && (
              <Field label={t('fields.plan')}>
                {planDisplayName}{' '}
                <span className="text-[var(--aura-fg-secondary)]">
                  / {invoice.planYear !== null ? formatCalendarYear(invoice.planYear, userLocale) : null}
                </span>
              </Field>
            )}
            <Field label={t('fields.issueDate')}>{formatLocalisedDate(invoice.issueDate ?? '', userLocale, dateOnly)}</Field>
            <Field label={t('fields.dueDate')}>{formatLocalisedDate(invoice.dueDate ?? '', userLocale, dateOnly)}</Field>
            {/* Receipt No. — a separate-mode receipt (its own §87 sequence),
                kept on paid AND credited rows: once issued it is a permanent
                record (thai-tax review 2026-06-07). */}
            {invoice.receiptDocumentNumberRaw && invoiceStatusHasReceipt(invoice.status) && (
              <div>
                <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('fields.receiptNumber')}</dt>
                <dd className="mt-1 font-mono text-sm" data-testid="invoice-receipt-number">
                  {invoice.receiptDocumentNumberRaw}
                </dd>
              </div>
            )}
            {replaces.length > 0 && (
              <div>
                <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('fields.replaces')}</dt>
                <dd className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm" data-testid="invoice-replaces">
                  {replaces.map((r) => (
                    <Link key={r.invoiceId} href={`/admin/invoices/${r.invoiceId}`} className={MONO_LINK}>
                      {r.displayNumber}
                    </Link>
                  ))}
                </dd>
              </div>
            )}
          </dl>
          {/* The totals at the card's end, right-aligned (board Admin-voided). */}
          <dl
            data-slot="invoice-totals"
            aria-label={t('totalsLabel')}
            className="ms-auto grid w-full grid-cols-[1fr_auto] gap-x-8 gap-y-2 text-sm sm:max-w-sm"
          >
            <dt className="text-[var(--aura-fg-secondary)]">{t('fields.subtotal')}</dt>
            <dd className="text-end tabular-nums">{formatSatang(totals.subtotalSatang)} THB</dd>
            <dt className="text-[var(--aura-fg-secondary)]">
              {t('fields.vat')}
              {totals.vatPercent && <span className="ms-1">({totals.vatPercent})</span>}
            </dt>
            <dd className="text-end tabular-nums">{formatSatang(totals.vatSatang)} THB</dd>
            <dt className="border-t border-[var(--aura-border-default)] pt-2 font-semibold">
              {t('fields.total')}
              {isDraft && <span className="ms-1 font-normal text-[var(--aura-fg-secondary)]">({t('previewLabel')})</span>}
            </dt>
            <dd className="border-t border-[var(--aura-border-default)] pt-2 text-end font-semibold tabular-nums">
              {formatSatang(totals.totalSatang)} THB
            </dd>
          </dl>
        </div>
      </Card>

      {/* Payment details — once a payment is recorded, and still after a
          §86/10 credit note reduces the invoice (092); void has its own card. */}
      {invoiceStatusHasReceipt(invoice.status) && (
        <Card id="payment" className="scroll-mt-20" title={t('payment.title')} titleId="payment-details-heading" headingLevel={2}>
          <dl className={FIELD_GRID}>
            {/* paymentDate is a Postgres `date` — UTC-pin so the day never shifts. */}
            <Field label={t('payment.paymentDate')}>{formatLocalisedDate(invoice.paymentDate ?? '', userLocale, dateOnly)}</Field>
            {/* paidAt is a real instant — rendered in the user's time zone on purpose. */}
            <Field label={t('payment.paidAt')}>{formatLocalisedDate(invoice.paidAt ?? '', userLocale, instant)}</Field>
            <Field label={t('payment.method')}>
              {paymentDetails.methodKey ? t(`payment.methods.${paymentDetails.methodKey}`) : '—'}
            </Field>
            <Field label={t('payment.reference')}>
              <span className="font-mono">{invoice.paymentReference ?? '—'}</span>
            </Field>
            <Field label={t('payment.recordedBy')}>{paymentRecordedByEmail}</Field>
            {paymentDetails.notes && (
              <Field label={t('payment.notes')} wide>
                <span className="whitespace-pre-wrap">{paymentDetails.notes}</span>
              </Field>
            )}
          </dl>
        </Card>
      )}

      {invoice.status === 'void' && (
        <Card title={t('voidDetails.title')} titleId="void-details-heading" headingLevel={2}>
          <div className="flex flex-col gap-4">
            <dl className={FIELD_GRID}>
              {/* voidedAt is a real instant — rendered in the user's time zone on purpose. */}
              <Field label={t('voidDetails.voidedAt')}>{formatLocalisedDate(invoice.voidedAt ?? '', userLocale, instant)}</Field>
              <Field label={t('voidDetails.voidedBy')}>{voidedByEmail}</Field>
              {invoice.voidReason && (
                <Field label={t('voidDetails.reason')} wide>
                  <span className="whitespace-pre-wrap">{invoice.voidReason}</span>
                </Field>
              )}
            </dl>
            {/* 121-void-supersede-links — auto-voided because a reactivation
                bill superseded it. Dashed = a pointer, not a second status. */}
            {replacedBy && (
              <p
                className="rounded-[var(--aura-radius-md)] border border-dashed border-[var(--aura-border-strong)] px-3 py-2 text-sm"
                data-testid="invoice-replaced-by"
              >
                {t.rich('voidDetails.replacedBy', {
                  number: replacedBy.displayNumber,
                  link: (chunks) => (
                    <Link href={`/admin/invoices/${replacedBy.invoiceId}`} className={`${MONO_LINK} font-medium`}>
                      {chunks}
                    </Link>
                  ),
                })}
                {replacedBy.issueDate && (
                  <span className="text-[var(--aura-fg-secondary)]">
                    {' · '}
                    {t('voidDetails.replacedByIssued', {
                      // issue_date is a Postgres `date` — UTC-pin so the day never shifts.
                      date: formatLocalisedDate(replacedBy.issueDate, userLocale, dateOnly),
                    })}
                  </span>
                )}
                {/* The replacement is no longer live itself — say so. */}
                {!isSupersessionLinkLive(replacedBy) && (
                  <StatusPill tone={invoiceStatusTone(replacedBy.status)} className="ms-2 align-middle">
                    {tStatus(replacedBy.status)}
                  </StatusPill>
                )}
              </p>
            )}
            <p className="text-xs text-[var(--aura-fg-secondary)]">
              {voidedBill ? t('voidDetails.creditNoteHintBill', { number: voidedBill }) : t('voidDetails.creditNoteHint')}
            </p>
          </div>
        </Card>
      )}

      {creditNotes.length > 0 && (
        <Card
          title={t('creditNotesSection.title', { count: creditNotes.length })}
          titleId="credit-notes-heading"
          headingLevel={2}
          actions={
            <p className="text-xs text-[var(--aura-fg-secondary)]">
              <span>{t('creditNotesSection.totalCredited')}</span>{' '}
              <span className="font-medium tabular-nums text-[var(--aura-fg-primary)]">
                {formatSatang(invoice.creditedTotal.satang)} THB
              </span>
            </p>
          }
        >
          <Table caption={t('creditNotesSection.title', { count: creditNotes.length })} captionHidden stackBelow="sm">
            <THead>
              <Tr>
                <Th>{t('creditNotesSection.col.number')}</Th>
                <Th>{t('creditNotesSection.col.issueDate')}</Th>
                <Th>{t('creditNotesSection.col.reason')}</Th>
                <Th align="end">{t('creditNotesSection.col.total')}</Th>
                <Th align="end">
                  <span className="sr-only">{t('creditNotesSection.col.actions')}</span>
                </Th>
              </Tr>
            </THead>
            <TBody>
              {creditNotes.map((cn) => (
                <Tr key={cn.creditNoteId}>
                  <Td card="title" className="font-mono font-medium">
                    {cn.documentNumber.raw}
                  </Td>
                  {/* A tax-document date: th renders CE + (พ.ศ.), as on the CN pages. */}
                  <Td className="tabular-nums" label={t('creditNotesSection.col.issueDate')}>
                    {formatTaxDocDate(cn.issueDate, userLocale)}
                  </Td>
                  <Td className="max-w-[20rem] truncate" title={cn.reason} label={t('creditNotesSection.col.reason')}>
                    {cn.reason}
                  </Td>
                  <Td align="end" className="tabular-nums" label={t('creditNotesSection.col.total')}>
                    {formatSatang(cn.total.satang)} THB
                  </Td>
                  <Td align="end" card="action">
                    <span className="flex justify-end gap-2">
                      <a
                        href={`/api/credit-notes/${cn.creditNoteId}/pdf`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className={buttonClass({ variant: 'secondary', size: 'sm' })}
                        aria-label={t('creditNotesSection.action.pdfAria', { number: cn.documentNumber.raw })}
                      >
                        {t('creditNotesSection.action.pdf')}
                      </a>
                      <Link
                        href={`/admin/credit-notes/${cn.creditNoteId}`}
                        className={buttonClass({ variant: 'ghost', size: 'sm' })}
                        aria-label={t('creditNotesSection.action.viewAria', { number: cn.documentNumber.raw })}
                      >
                        {t('creditNotesSection.action.view')}
                      </Link>
                    </span>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </Card>
      )}

      <Card title={t('lines.title')} titleId="invoice-lines-heading" headingLevel={2}>
        {/* Stacked on a phone, each field cell names itself: AURA cannot read
            the headers of a table rendered from a server file. */}
        <Table caption={t('lines.title')} captionHidden stackBelow="sm">
          <THead>
            <Tr>
              <Th>{t('lines.description')}</Th>
              <Th align="end">{t('lines.qty')}</Th>
              <Th align="end">{t('lines.unit')}</Th>
              <Th align="end">{t('lines.total')}</Th>
            </Tr>
          </THead>
          <TBody>
            {invoice.lines.map((l) => (
              <Tr key={l.lineId}>
                <Td card="title">
                  <span lang="th" className="block font-sarabun">
                    {l.descriptionTh}
                  </span>
                  <span className="block text-xs text-[var(--aura-fg-secondary)]">{l.descriptionEn}</span>
                </Td>
                <Td align="end" className="tabular-nums" label={t('lines.qty')}>
                  {l.quantity}
                </Td>
                <Td align="end" className="tabular-nums" label={t('lines.unit')}>
                  {formatSatang(l.unitPrice.satang)}
                </Td>
                <Td align="end" className="tabular-nums" label={t('lines.total')}>
                  {formatSatang(l.total.satang)}
                </Td>
              </Tr>
            ))}
          </TBody>
        </Table>
      </Card>

      {paymentActivity}
      {/* Room for the phone action bar, so the page's end scrolls clear of it. */}
      <div
        data-slot="invoice-action-bar-spacer"
        aria-hidden="true"
        className="h-[var(--invoice-action-bar-height,0px)] sm:hidden"
      />
    </DetailContainer>
  );
}
