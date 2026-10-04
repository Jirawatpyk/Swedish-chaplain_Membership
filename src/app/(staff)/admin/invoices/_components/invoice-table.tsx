/**
 * T057 — Invoices admin table (F4).
 *
 * Spec 122 US8 (T802): one AURA `DataTable` that stacks into cards below
 * 640px, laid out as the `Admin-invoices` board draws it (spec
 * Clarifications, Session 2026-10-02):
 *   Invoice No. (+ "Issued {date}" · credit notes) · Buyer · Status ·
 *   [Queue] · [Method] · Due · Receipt No. · Total · Actions
 *
 *   - Queue shows only in the auto-renewal review queue (`?origin=
 *     auto_renewal`), Method only in the `?paidOnline=1` reconciliation view.
 *   - Actions: "Record payment…" on issued/overdue bills (admins), then a ⋯
 *     menu with the row's documents. A draft has no PDF, so its menu only
 *     opens it.
 *   - On a phone each row is a card: the number as its title, the status
 *     pill, then buyer, due and total, with the actions as its last row.
 */
'use client';

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import {
  Badge,
  DataTable,
  DropdownMenu,
  Icon,
  IconButton,
  StatusPill,
  type DataTableColumn,
  type MenuItem,
} from '@jirawatpyk/aura-react';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/utils';
import { invoiceStatusTone } from '@/components/invoices/invoice-status-tone';
import { downloadInvoice, downloadReceipt } from '../_lib/download-receipt-client';
import { RecordPaymentDialog } from './record-payment-dialog';
import { INVOICES_COLUMN_LAYOUT } from './invoices-table-columns';
import {
  AutoRenewalQueueBadges,
  type AutoRenewalQueueMeta,
} from './auto-renewal-queue-badges';
import { AutoRenewalQueueActions } from './auto-renewal-queue-actions';
import type { InvoiceStatus } from '@/modules/invoicing';
import { formatSatangAmount } from '@/lib/format-thb';

/**
 * R9-TY1 — `'overdue'` is a presentation-only derived status (T109,
 * FR-028) layered on top of the canonical `InvoiceStatus` domain
 * enum. The list page replaces `'issued'` with `'overdue'` when the
 * Bangkok-today read-time rule fires. Keeping the union here (rather
 * than widening to `string`) means a new domain status (e.g.
 * `'refunded'`) fails typecheck in `invoiceStatusTone`'s exhaustive
 * switch (`src/components/invoices/invoice-status-tone.ts`), surfacing
 * the gap at compile time instead of rendering a neutral pill.
 */
type RowStatus = InvoiceStatus | 'overdue';

export type InvoicesTableRow = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly status: RowStatus;
  /**
   * 054-event-fee-invoices — subject discriminator. `'event'` rows show an
   * Event chip next to the buyer name; `'membership'` rows do not.
   */
  readonly invoiceSubject: 'membership' | 'event';
  /**
   * Whether the buyer is a real F3 member (so the name links to
   * `/admin/members/{memberId}`). False for event-fee invoices billed to a
   * NON-member attendee — those have no member row, so the name renders as
   * plain text instead of a broken `/admin/members/` link (the empty-id
   * broken-link fix). Membership invoices and matched-member event invoices
   * are both `true`.
   */
  readonly buyerHasMemberLink: boolean;
  /**
   * Member-link target. Empty string when `buyerHasMemberLink` is false
   * (event non-member buyer) — never dereferenced in that case.
   */
  readonly memberId: string;
  /** Buyer display name — member company name OR non-member legal name. */
  readonly memberName: string;
  /**
   * 054-event-fee-invoices Task 14 — muted second line under the buyer
   * name that describes + distinguishes the invoice:
   *   - event rows  → `{event name} · {CE start date}` (e.g.
   *     "TSCC Gala Dinner · 2026-06-15"); falls back to just the CE date
   *     when the event name could not be resolved (archived / lookup miss).
   *   - membership rows → the localised "Membership {year}" string.
   *   - null when there is nothing useful to show (no plan_year, no event
   *     id) — the line is simply omitted, never rendered empty.
   * The string is fully composed in the server component (page.tsx) so the
   * event name (data, not i18n) and the localised membership label are both
   * resolved before the row reaches this client component.
   */
  readonly buyerSubtitle: string | null;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  /**
   * Stringified satang, or null for a draft — a draft has no total until it
   * is issued, so it renders "—" rather than a misleading "0.00 THB".
   */
  readonly totalSatang: string | null;
  readonly hasPdf: boolean;
  /**
   * Count of credit notes issued against this invoice. Zero on 99%
   * of invoices (paid/void rarely credited). Rendered as an outline
   * chip beside the status badge so admins can spot partially/fully
   * credited rows without drilling into detail.
   */
  readonly creditNoteCount: number;
  /** Cumulative credited amount in satang (stringified bigint). */
  readonly creditedTotalSatang: string;
  /**
   * Succeeded online payment method, or null when the invoice has no
   * F5 succeeded payment. Surfaces as a Method-column badge ONLY when
   * `showMethodColumn` is true (driven by `?paidOnline=1` admin
   * reconciliation view).
   */
  readonly onlinePaymentMethod: 'card' | 'promptpay' | null;
  /**
   * Receipt document number (e.g. `RC-2026-0001`) for paid invoices
   * issued under separate-mode numbering. `null` for combined-mode
   * (receipt reuses invoice number) and for any non-paid status.
   */
  readonly receiptDocumentNumberRaw: string | null;
  /**
   * Whether the row has a receipt PDF available for download. Computed in
   * page.tsx as `invoiceStatusHasReceipt(status) && receiptPdf !== null` —
   * i.e. the invoice is in a receipt-bearing state (paid / partially_credited
   * / credited — 092: a §86/10 credit note does NOT cancel the §86/4 receipt,
   * so it stays downloadable + re-sendable) AND the receipt-stamped bytes have
   * been persisted. A
   * non-null `receiptPdf` IS the admin's "receipt has rendered" signal
   * (the async worker only writes the blob once the PDF exists), so this
   * flag doubles as the rendered-receipt gate. The Actions cell uses it
   * to decide whether to render the "Receipt" download link.
   */
  readonly hasReceiptPdf: boolean;
  /**
   * Raw `receiptPdfStatus` so the action cell can render a
   * "preparing…" affordance when paid + pending/failed/null (receipt
   * is async-rendering but not yet downloadable). Without this,
   * bookkeepers saw a paid row with only an Invoice download and no
   * signal that the §86/4 + §105ทวิ legal doc is on its way.
   */
  readonly receiptPdfStatus: 'pending' | 'rendered' | 'failed' | null;
  /**
   * 064 remediation S7 — the MAIN pdf IS a §105 receipt (`pdfDocKind
   * 'receipt_separate'`: a β as-paid no-TIN event row, or a legacy issued
   * no-TIN row). The main download button then wears the Receipt label +
   * receipt aria instead of the Invoice ones — the file the admin grabs is
   * legally a receipt. `documentNumber` on these rows is the printed §105
   * number (mapped via `displayDocumentNumber` in page.tsx), so the
   * download filename follows automatically.
   */
  readonly mainDownloadIsReceipt: boolean;
  /**
   * 088 — the main pdf is an SC- bill (ใบแจ้งหนี้), not a §86/4 tax invoice
   * (that is the RC issued at payment). The main download wears the bill
   * label + aria. OPTIONAL (undefined → false) so legacy constructors are
   * unaffected.
   */
  readonly mainDownloadIsBill?: boolean;
  /**
   * 088 (T065 / T065a / FR-016) — the pre-payment NON-§87 bill number (SC-…)
   * for the two-document disambiguation. Present only on a real 088 bill (with
   * the flag on); `null` on legacy rows. `documentNumber` already carries this
   * SC number as the row identity (A-refined), so this field is retained for the
   * main-download accessible name. OPTIONAL so legacy row constructors are
   * unaffected (undefined → treated as `null`).
   */
  readonly billDocumentNumberRaw?: string | null;
  /**
   * 088 (T065 / T065a / FR-016) — the resolved §86/4 document kind, computed
   * server-side in page.tsx with the tax-at-payment flag baked in (A-refined):
   *   - `'none'`        — legacy / flag off → render exactly as today.
   *   - `'bill'`        — unpaid 088 bill → SC number + ใบแจ้งหนี้/Invoice tag.
   *   - `'tax_receipt'` — paid 088 bill → SC number + ใบแจ้งหนี้/Invoice tag (the
   *                       invoice's own identity); the RC §86/4 tax receipt is a
   *                       clickable link in the Receipt No. column.
   * OPTIONAL (undefined → `'none'`) so legacy constructors are unaffected.
   */
  readonly taxDocumentKind?: 'none' | 'bill' | 'tax_receipt';
  /**
   * 107-auto-invoice Task 13 — auto-renewal review-queue per-row decision
   * context (drift / bill-year-vs-coverage-year / would-be-refused
   * prediction / staleness). `null` outside the queue view — page.tsx only
   * populates this when `?origin=auto_renewal` is active. Rendered by
   * `AutoRenewalQueueBadges` in a dedicated column, shown only when
   * `showQueueMetaColumn` is true.
   */
  readonly queueMeta?: AutoRenewalQueueMeta | null;
};

// The open-detail link in the Invoice No. column (real number or the draft
// placeholder). `inline-flex min-h-6` keeps a ≥24px hit target (WCAG 2.5.8).
// The draft branch is normal weight: never italic (Thai has no true italic —
// faux-oblique bends "ร่าง"'s marks) and never muted (that colour is this
// table's "empty" sentinel), so it reads as a link, not a document number.
const numberLinkBase =
  'inline-flex min-h-6 items-center rounded-sm text-[var(--aura-fg-primary)] underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]';
const subLine = 'text-xs text-[var(--aura-fg-secondary)]';
const dash = <span className="text-sm text-[var(--aura-fg-tertiary)]">—</span>;

function formatListDate(iso: string, locale: string): string {
  return formatLocalisedDate(iso, locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export function InvoicesTable({
  rows,
  showMethodColumn = false,
  showQueueMetaColumn = false,
  canRecordPayment = false,
  canManageQueueActions = false,
  todayIso,
}: {
  rows: readonly InvoicesTableRow[];
  /**
   * F5 Phase 5 (T096) — render the Method column when active. Driven by
   * the `?paidOnline=1` admin reconciliation filter; hidden by default
   * to keep the standard list compact (95% of rows would carry no badge).
   */
  showMethodColumn?: boolean;
  /**
   * 107-auto-invoice Task 13 — render the auto-renewal review-queue
   * decision-context column (drift / bill-year-vs-coverage-year /
   * would-be-refused / staleness). Driven by `?origin=auto_renewal`;
   * hidden by default so the standard list is unchanged.
   */
  showQueueMetaColumn?: boolean;
  /**
   * 088 T021c / FR-035 — enable the per-row "Record payment" quick action on
   * issued / overdue bills. Admin-only (money mutation); the list page passes
   * `isAdmin`. Requires `todayIso` (below) to be threaded too.
   */
  canRecordPayment?: boolean;
  /**
   * 107-auto-invoice Task 14 — enable the per-row Issue+Send / Issue
   * silently / Discard queue actions on `status='draft'` auto-renewal rows.
   * Admin-only (money mutation, same rationale as `canRecordPayment`); the
   * routes themselves are independently admin-gated server-side — this prop
   * only controls whether a manager sees the controls at all.
   */
  canManageQueueActions?: boolean;
  /**
   * Tenant-timezone (Asia/Bangkok) "today" as YYYY-MM-DD, computed server-side
   * (`bangkokLocalDate`). Threaded to the per-row `RecordPaymentDialog` as the
   * payment-date default + upper bound — never derived client-side from
   * `new Date()` (UTC), which breaks the date clamp for ~7h/day. Only consumed
   * when `canRecordPayment` is on; the per-row action stays hidden without it.
   */
  todayIso?: string;
}) {
  const t = useTranslations('admin.invoices.list');
  const tDetail = useTranslations('admin.invoices.detail');
  // 088 (T065/T065a) — SC-bill ↔ RC-tax-receipt disambiguation labels (shared
  // tax088 namespace). Rendered only for rows whose `taxDocumentKind` is
  // non-'none' (page.tsx bakes the flag into that field).
  const tTax088 = useTranslations('admin.invoices.tax088');
  const tStatus = useTranslations('admin.invoices.list.statuses');
  const tMethod = useTranslations('admin.paymentReconciliation.methodBadge');
  const locale = useLocale();
  // Per-row spinner state keyed by `${variant}:${invoiceId}` so two
  // downloads on different rows don't overwrite each other's loader.
  // (Single-slot state would lose row-A's spinner when row-B's
  // download starts; the Set permits unlimited concurrent rows.)
  const [downloadingKeys, setDownloadingKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const addDownloading = (key: string) =>
    setDownloadingKeys((prev) => {
      const next = new Set(prev);
      next.add(key);
      return next;
    });
  const removeDownloading = (key: string) =>
    setDownloadingKeys((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });

  // Unified row-download dispatcher. `toast.loading` fires BEFORE the
  // await so SR + visual feedback is continuous click → completion
  // (rows scrolled off-screen otherwise had no audio cue during the
  // fetch window). `try/finally` guards against a throw inside the
  // helpers leaking a stuck spinner — the helpers themselves swallow
  // documented 4xx/5xx via their own catch, but defensive cleanup
  // matches the detail page's download pattern.
  const handleRowDownload = async (
    variant: 'invoice' | 'receipt',
    invoiceId: string,
    fallbackFilename: string,
  ) => {
    const key = `${variant}:${invoiceId}`;
    addDownloading(key);
    const loadingId = toast.loading(tDetail('toast.downloadInProgress'));
    try {
      if (variant === 'invoice') {
        await downloadInvoice({
          invoiceId,
          fallbackFilename,
          toasts: {
            forbidden: tDetail('toast.invoiceForbidden'),
            notFound: tDetail('toast.invoiceNotFound'),
            unavailable: tDetail('toast.invoiceUnavailable'),
            sessionExpired: tDetail('toast.invoiceSessionExpired'),
            rateLimited: tDetail('toast.invoiceRateLimited'),
          },
          toastWarning: (msg) => toast.warning(msg),
          toastError: (msg) => toast.error(msg),
        });
      } else {
        await downloadReceipt({
          invoiceId,
          fallbackFilename,
          toasts: {
            pending: tDetail('toast.receiptPending'),
            failed: (reason) => tDetail('toast.receiptFailed', { reason }),
            forbidden: tDetail('toast.receiptForbidden'),
            unavailable: tDetail('toast.receiptUnavailable'),
            sessionExpired: tDetail('toast.receiptSessionExpired'),
            rateLimited: tDetail('toast.receiptRateLimited'),
          },
          toastWarning: (msg) => toast.warning(msg),
          toastError: (msg) => toast.error(msg),
        });
      }
    } finally {
      toast.dismiss(loadingId);
      removeDownloading(key);
    }
  };
  // The Actions cell: "Record payment…" on issued/overdue bills (admin), then
  // the ⋯ menu with the row's documents — or, in the review-queue view, the
  // draft's issue/discard actions (a draft has no PDF, so no download menu).
  // Memoised with the columns: a fresh `columns` array on every render
  // remounts each cell, and an open menu closed on the click that opened it
  // (R18).
  const renderRowActions = useCallback(
    (r: InvoicesTableRow) => {
      const showRecordPayment =
        canRecordPayment && todayIso !== undefined && (r.status === 'issued' || r.status === 'overdue');
      const showQueueActions = canManageQueueActions && showQueueMetaColumn && r.status === 'draft';
      if (showQueueActions) {
        const qm = r.queueMeta;
        const issueCaution =
          qm == null
            ? null
            : qm.unresolved
              ? ('unresolved' as const)
              : qm.priceUnverifiable
                ? ('priceUnverifiable' as const)
                : qm.priceChanged
                  ? ('priceChanged' as const)
                  : null;
        return (
          <AutoRenewalQueueActions
            invoiceId={r.invoiceId}
            memberName={r.memberName}
            status={r.status}
            issueCaution={issueCaution}
          />
        );
      }
      // FR-015 — every document control names its own document: the main
      // pdf is the SC bill on an 088 bill, the §105 receipt on a β as-paid
      // row, else the tax invoice; the RC receipt once it has rendered (092:
      // a credit note does not cancel it, so credited rows keep it).
      const mainDownloadNumber =
        r.taxDocumentKind === 'tax_receipt' && r.billDocumentNumberRaw ? r.billDocumentNumberRaw : r.documentNumber;
      const receiptNumber = r.receiptDocumentNumberRaw ?? r.documentNumber;
      const items: MenuItem[] = [{ label: t('actions.view'), href: `/admin/invoices/${r.invoiceId}`, icon: 'file-text' }];
      if (r.hasPdf) {
        items.push({
          label: t(
            r.mainDownloadIsReceipt
              ? 'actions.downloadReceiptAria'
              : r.mainDownloadIsBill
                ? 'actions.downloadBillAria'
                : 'actions.downloadInvoiceAria',
            { number: mainDownloadNumber },
          ),
          icon: 'download',
          disabled: downloadingKeys.has(`invoice:${r.invoiceId}`),
          onSelect: () => void handleRowDownload('invoice', r.invoiceId, `${mainDownloadNumber}.pdf`),
        });
      }
      if (r.hasReceiptPdf) {
        items.push({
          label: t('actions.downloadReceiptAria', { number: receiptNumber }),
          icon: 'download',
          disabled: downloadingKeys.has(`receipt:${r.invoiceId}`),
          onSelect: () => void handleRowDownload('receipt', r.invoiceId, `${receiptNumber}-receipt.pdf`),
        });
      }
      // A draft has no number yet, so its ⋯ is named for the member (like the
      // number link), never a bare "Draft" shared by every draft row.
      const menuName =
        r.status === 'draft'
          ? t('actions.moreDraftAria', { name: r.memberName })
          : t('actions.moreAria', { number: r.documentNumber });
      // Record payment on the left and the ⋯ on the right (the board). On a
      // phone card the button grows to fill the footer row beside the ⋯.
      return (
        <div className="flex w-full items-center justify-between gap-1">
          {showRecordPayment ? (
            <RecordPaymentDialog
              invoiceId={r.invoiceId}
              documentNumber={r.documentNumber === '—' ? null : r.documentNumber}
              issueDate={r.issueDate}
              todayIso={todayIso}
              triggerLabel={t('actions.recordPayment')}
              triggerAriaLabel={t('actions.recordPaymentAria', { number: r.documentNumber })}
              memberName={r.memberName}
              {...(r.totalSatang !== null ? { totalDisplay: `${formatSatangAmount(r.totalSatang)} THB` } : {})}
              triggerVariant="ghost"
              triggerSize="sm"
              triggerId={`record-payment-${r.invoiceId}`}
              triggerTestId="row-record-payment-trigger"
              triggerClassName="max-sm:flex-1"
              // The refresh turns the row paid and the trigger unmounts; the ⋯ stays.
              finalFocusFallbackId={`row-menu-${r.invoiceId}`}
            />
          ) : (
            <span />
          )}
          <DropdownMenu
            label={menuName}
            trigger={
              <IconButton id={`row-menu-${r.invoiceId}`} icon="ellipsis" size="sm" touchHeight label={menuName} />
            }
            items={items}
          />
        </div>
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- handleRowDownload only reads the setters and translators
    [t, canRecordPayment, canManageQueueActions, showQueueMetaColumn, todayIso, downloadingKeys],
  );

  // The receipt's async state (088 T066b): a "generating" line while the
  // §86/4 receipt renders, a link to the invoice when it failed (actionable,
  // never a forever-pending state). Plain text, not a live region or
  // aria-busy: the words state the status. Drawn in the Receipt No. column,
  // and again under the number on a phone card, where that column is hidden.
  const renderReceiptState = useCallback(
    (r: InvoicesTableRow, withTestIds: boolean) => {
      if (r.status !== 'paid') return null;
      if (r.receiptPdfStatus === 'pending') {
        return (
          <span className={subLine} {...(withTestIds ? { 'data-testid': 'row-receipt-generating' } : {})}>
            {t('actions.receiptGenerating')}
          </span>
        );
      }
      if (r.receiptPdfStatus === 'failed') {
        return (
          <Link
            href={`/admin/invoices/${r.invoiceId}`}
            aria-label={t('actions.receiptRenderFailedAria', { number: r.documentNumber })}
            className="inline-flex min-h-6 items-center gap-1 rounded-sm text-xs font-medium text-[var(--aura-fg-danger)] underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
            {...(withTestIds ? { 'data-testid': 'row-receipt-render-failed' } : {})}
          >
            <Icon name="circle-alert" size={14} />
            {t('actions.receiptRenderFailed')}
          </Link>
        );
      }
      return null;
    },
    [t],
  );

  const columns = useMemo<DataTableColumn<InvoicesTableRow>[]>(() => {
    const cols: DataTableColumn<InvoicesTableRow>[] = [
      {
        // 088 A-refined (FR-016): the Invoice No. column always carries the
        // invoice's OWN number (the SC bill on an 088 bill, paid or unpaid);
        // the RC tax receipt is the Receipt No. column. A draft has no §87
        // number yet (allocated only at issue), so it shows a localised
        // "Draft" link named for the member — never a bare "—" link (WCAG
        // 2.4.4 / 2.5.8). Gated on the status, never on the "—" string.
        key: 'documentNumber',
        label: t('columns.documentNumber'),
        ...INVOICES_COLUMN_LAYOUT.documentNumber,
        render: (r) => (
          <div className="flex flex-col gap-0.5 leading-snug">
            {r.status === 'draft' ? (
              <Link
                href={`/admin/invoices/${r.invoiceId}`}
                aria-label={t('actions.openDraftAria', { name: r.memberName })}
                className={numberLinkBase}
              >
                {t('draftNumberLabel')}
              </Link>
            ) : (
              <Link
                href={`/admin/invoices/${r.invoiceId}`}
                className={cn(numberLinkBase, 'font-mono text-xs font-medium')}
              >
                {r.documentNumber}
              </Link>
            )}
            {r.issueDate || r.creditNoteCount > 0 ? (
              <span className={cn(subLine, 'flex flex-wrap gap-1')}>
                {r.issueDate ? <span>{t('issuedOn', { date: formatListDate(r.issueDate, locale) })}</span> : null}
                {r.issueDate && r.creditNoteCount > 0 ? <span aria-hidden="true">·</span> : null}
                {r.creditNoteCount > 0 ? (
                  <Link
                    href={`/admin/invoices/${r.invoiceId}`}
                    aria-label={t('creditedAria', {
                      count: r.creditNoteCount,
                      amount: formatSatangAmount(r.creditedTotalSatang),
                    })}
                    title={t('creditedTooltip', {
                      count: r.creditNoteCount,
                      amount: formatSatangAmount(r.creditedTotalSatang),
                    })}
                    className="rounded-sm text-[var(--aura-fg-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
                  >
                    {t('creditNoteCount', { count: r.creditNoteCount })}
                  </Link>
                ) : null}
              </span>
            ) : null}
            {/* Phone cards leave Receipt No. out (the board), and a table under
                1000px hides that column, so the receipt's state reads here
                then. A container query on the table's wrapper, the same width
                AURA's hideBelow measures. */}
            {r.status === 'paid' && (r.receiptPdfStatus === 'pending' || r.receiptPdfStatus === 'failed') ? (
              <span className="@min-[1000px]:hidden" data-testid="row-receipt-state-card">
                {renderReceiptState(r, false)}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        // 054 — the buyer: a member links to F3; an event NON-member buyer has
        // no member row, so the name is plain text (never an empty-id link).
        // Long legal names wrap to two lines with the full name in `title`.
        key: 'memberName',
        label: t('columns.buyer'),
        ...INVOICES_COLUMN_LAYOUT.memberName,
        render: (r) => (
          // `whitespace-normal`: AURA's stacked-card cells are nowrap.
          <div className="flex min-w-0 flex-col gap-0.5 leading-snug whitespace-normal">
            {r.buyerHasMemberLink ? (
              <Link
                href={`/admin/members/${r.memberId}`}
                title={r.memberName}
                className="line-clamp-2 max-w-[32ch] break-words rounded-sm focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
              >
                {r.memberName}
              </Link>
            ) : (
              <span title={r.memberName} className="line-clamp-2 max-w-[32ch] break-words">
                {r.memberName}
              </span>
            )}
            {r.invoiceSubject === 'event' || r.buyerSubtitle !== null ? (
              <span className="flex flex-wrap items-center gap-1.5">
                {r.invoiceSubject === 'event' ? (
                  <Badge tone="neutral" variant="outline" aria-label={t('subjectChip.eventAria')}>
                    {t('subjectChip.event')}
                  </Badge>
                ) : null}
                {r.buyerSubtitle !== null ? (
                  <span title={r.buyerSubtitle} className={cn(subLine, 'line-clamp-2 block max-w-[32ch]')}>
                    {r.buyerSubtitle}
                  </span>
                ) : null}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        key: 'status',
        label: t('columns.status'),
        ...INVOICES_COLUMN_LAYOUT.status,
        render: (r) => <StatusPill tone={invoiceStatusTone(r.status)}>{tStatus(r.status)}</StatusPill>,
      },
    ];
    if (showQueueMetaColumn) {
      // 107 Task 13 — the review-queue decision context, only in that view.
      cols.push({
        key: 'queue',
        label: t('columns.queue'),
        card: 'wide',
        render: (r) =>
          r.queueMeta ? (
            <span data-testid="queue-meta-cell">
              <AutoRenewalQueueBadges meta={r.queueMeta} />
            </span>
          ) : (
            <span data-testid="queue-meta-cell">{dash}</span>
          ),
      });
    }
    if (showMethodColumn) {
      // F5 T096 — the Method column, only in the `?paidOnline=1` view.
      cols.push({
        key: 'method',
        label: t('columns.method'),
        width: 120,
        render: (r) =>
          r.onlinePaymentMethod ? (
            <Badge
              tone="neutral"
              variant="soft"
              data-testid={`method-badge-${r.onlinePaymentMethod}`}
              aria-label={`${t('columns.method')}: ${tMethod(r.onlinePaymentMethod)}`}
            >
              {tMethod(r.onlinePaymentMethod)}
            </Badge>
          ) : (
            dash
          ),
      });
    }
    cols.push(
      {
        key: 'dueDate',
        label: t('columns.dueDate'),
        ...INVOICES_COLUMN_LAYOUT.dueDate,
        render: (r) => (r.dueDate ? formatListDate(r.dueDate, locale) : '—'),
      },
      {
        // 088 A-refined — a paid 088 bill's RC links to the invoice (named for
        // the receipt, so the row's two same-target links differ for screen
        // readers). Under it: the busy "generating" line while the receipt
        // renders, a link to the invoice when it failed (actionable, never a
        // forever-pending state), or the online method.
        key: 'receipt',
        label: t('columns.receiptNumber'),
        ...INVOICES_COLUMN_LAYOUT.receipt,
        render: (r) => {
          const receiptState = renderReceiptState(r, true);
          return (
            <div className="flex flex-col gap-0.5 leading-snug">
              {r.taxDocumentKind === 'tax_receipt' && r.receiptDocumentNumberRaw ? (
                <Link
                  href={`/admin/invoices/${r.invoiceId}`}
                  aria-label={tTax088('seeReceiptLink', { number: r.receiptDocumentNumberRaw })}
                  className={cn(numberLinkBase, 'font-mono text-xs font-medium')}
                >
                  {r.receiptDocumentNumberRaw}
                </Link>
              ) : r.receiptDocumentNumberRaw ? (
                <span className="font-mono text-xs tabular-nums">{r.receiptDocumentNumberRaw}</span>
              ) : (
                dash
              )}
              {receiptState ?? (r.onlinePaymentMethod && !showMethodColumn ? (
                <span className={subLine}>{tMethod(r.onlinePaymentMethod)}</span>
              ) : null)}
            </div>
          );
        },
      },
      {
        key: 'total',
        label: t('columns.total'),
        ...INVOICES_COLUMN_LAYOUT.total,
        render: (r) =>
          r.totalSatang === null ? (
            <span data-testid="invoice-total">
              <span className="text-[var(--aura-fg-tertiary)]" aria-hidden="true">
                —
              </span>
              <span className="sr-only">{t('columns.totalPending')}</span>
            </span>
          ) : (
            <span data-testid="invoice-total" className="font-medium tabular-nums">
              {formatSatangAmount(r.totalSatang)} THB
            </span>
          ),
      },
      {
        key: 'actions',
        label: t('columns.actions'),
        ...INVOICES_COLUMN_LAYOUT.actions,
        render: renderRowActions,
      },
    );
    return cols;
  }, [t, tStatus, tTax088, tMethod, locale, showMethodColumn, showQueueMetaColumn, renderRowActions, renderReceiptState]);

  return (
    // Review A8 — the review-queue view names its table for itself, so a
    // screen-reader user who jumps straight to it hears which list it is.
    <div className="@container">
      <DataTable<InvoicesTableRow>
        label={showQueueMetaColumn ? t('queueTableCaption') : t('tableCaption')}
        rows={rows}
        columns={columns}
        rowKey="invoiceId"
        rowHeight="auto"
        stackBelow={640}
        // Edge to edge inside the list card from 640px up (AURA 5.27, #130);
        // the pager follows, so it does not end the card.
        bleed
      />
    </div>
  );
}
