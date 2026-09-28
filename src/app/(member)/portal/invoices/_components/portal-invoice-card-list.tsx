/**
 * 060-member-portal-d4 (Task 2) — Mobile card list for /portal/invoices.
 *
 * Server Component. Renders the same per-row data as the desktop
 * `<table>` (in `page.tsx`) as a stacked card list for narrow viewports
 * (`< lg`). The page dual-renders: `<table>` inside `hidden lg:block`,
 * this list with `className="lg:hidden"`.
 *
 * SINGLE SOURCE OF TRUTH — this list consumes the SAME per-row
 * view-model (`InvoiceRowViewModel`, see `_utils/invoice-row-view-model.ts`)
 * that the table consumes. It NEVER recomputes the presentation flags
 * (`displayStatus`, `showInvoice`, `showReceipt`, `receiptPending`,
 * `receiptFailed`, `resendable`, `isCombinedPaid`) — so the card + table
 * can never drift apart. Formatting (date / money / badge variant / status icon) and the
 * action buttons are reused verbatim from the same helpers the table uses.
 *
 * Card anatomy (member-confirmed mockup):
 *   ┌───────────────────────────────────────────┐
 *   │ INV-2026-0001                 [✓ Paid]     │  doc# link (font-mono) · status pill (icon+text)
 *   │ ─────────────────────────────────────────  │  divider
 *   │ Issued 1 Apr 2026      Due 15 Apr 2026      │  facts grid (spec 122 US4 `Invoices-mobile`)
 *   │ Receipt No. RCP-…      Total 50,000.00 THB  │  Receipt No. ONLY in separate-mode
 *   │ [ ⤓ Receipt                        ] [ ⋯ ]  │  one download ≥44px + menu: the other doc, Email me a copy
 *   └───────────────────────────────────────────┘
 *
 * Combined-mode receipt (em-dash + tooltip hint the table shows in its
 * receipt cell) is INTENTIONALLY omitted from the card — on mobile the
 * absence of a receipt line is the cleaner signal; the combined Receipt
 * download still surfaces in the action row exactly as on the table.
 *
 * a11y:
 *   - `<ul role="list">` of `<li>` (cards in a list = list items). Each
 *     `<li>` carries an `aria-label` ("Invoice {number}, {status}") so SR
 *     users hear an at-a-glance summary on item focus. The "Invoice"
 *     prefix reuses the SINGULAR `detail.title` key (not the plural list
 *     `title`) so the per-item summary reads naturally for one document.
 *   - Card title is a REAL `<h2>` (not the CardTitle div / not an `<h3>`)
 *     so the cards appear in the SR heading tree directly under the page
 *     `<h1>` with NO skipped level — mirrors the benefit-usage-card
 *     real-`<h2>` precedent (the portal card-header convention).
 *   - Status badge = lucide icon (aria-hidden) + text (WCAG 1.4.1 — colour
 *     is not the sole signal).
 *   - The download keeps its `min-h-11` (≥44px) treatment and the "⋯"
 *     trigger is a 44px square named "More actions for {number}"; the row
 *     wraps (`flex flex-wrap`) so a 320px card never scrolls horizontally.
 */
import Link from 'next/link';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';
import { formatDate, formatSatangThb } from '../_utils/format';
import type { InvoiceRowDisplayStatus } from '../_utils/format';
import {
  rowHasAnyAction,
  downloadLabelKeys,
  type InvoiceRowViewModel,
} from '../_utils/invoice-row-view-model';
import { EmptyCell } from './empty-cell';
import { InvoiceStatusBadge } from './invoice-status-badge';
import { PortalInvoiceCardMenu } from './portal-invoice-card-menu';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from './portal-pdf-download-button';
import { ReceiptStatusWatcher } from './receipt-status-watcher';
import { ReceiptFailedSupportHint } from './receipt-failed-support-hint';

/**
 * One row's data for the card list — the SAME `{ vm }` shape the page
 * builds for the table. The card only reads `vm.*` for every flag/label;
 * the raw repo row is not carried here, so the card can never re-derive a
 * presentation flag the table didn't (and vice versa).
 */
export interface PortalInvoiceCardRow {
  readonly vm: InvoiceRowViewModel;
}

export interface PortalInvoiceCardListProps {
  readonly rows: ReadonlyArray<PortalInvoiceCardRow>;
  /** BCP-47 locale for date + currency formatting (matches the table). */
  readonly locale: string;
  /** `t` bound to `portal.invoices` (column labels + action labels + aria). */
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  /**
   * `tStatus` bound to `admin.invoices.list.statuses` (status badge text).
   *
   * 060-member-portal-d4 (final review) — the param is narrowed to
   * {@link InvoiceRowDisplayStatus} (the only thing this list ever passes is
   * `vm.displayStatus`) so a wrong/typo status key is a COMPILE error at this
   * prop boundary. next-intl's `t: (key: string) => string` is still
   * assignable here: a wider parameter is contravariantly assignable to a
   * narrower one (string ⊇ InvoiceRowDisplayStatus), so the page's translator
   * type-checks unchanged.
   */
  readonly tStatus: (key: InvoiceRowDisplayStatus) => string;
  /**
   * 088 (T065 / T065a / FR-016) — OPTIONAL translator bound to
   * `admin.invoices.tax088`, used to render the SC-bill ↔ RC-tax-receipt
   * disambiguation labels. Omitted (flag off) → the card renders no 088 UI and
   * is byte-identical to legacy; the page passes it only when the tax-at-payment
   * flag is on (and the VM's `taxDocumentKind` is then non-`'none'`).
   */
  readonly tTax088?: (key: string, values?: Record<string, string | number>) => string;
  /** Forwarded to the root `<ul>` — the page passes `lg:hidden`. */
  readonly className?: string;
}

export function PortalInvoiceCardList({
  rows,
  locale,
  t,
  tStatus,
  tTax088,
  className,
}: PortalInvoiceCardListProps): React.ReactElement {
  return (
    <ul
      role="list"
      data-testid="portal-invoice-card-list"
      className={cn('flex flex-col gap-3', className)}
    >
      {rows.map(({ vm }) => {
        const statusLabel = tStatus(vm.displayStatus);
        // 088 (T065/T065a) — the card's row identity is `primaryNumber` (RC for
        // a paid bill / legacy rows, the SC bill for an UNPAID 088 bill). The
        // 088 disambiguation renders only when `tTax088` is wired (flag on) AND
        // the VM's `taxDocumentKind` is non-`'none'`.
        const primaryNumber = vm.primaryNumber ?? vm.invoiceId;
        // The MAIN download serves the issue-time PDF: the SC bill on a paid 088
        // bill (T065c — name the control after its OWN document, not the RC).
        const mainDownloadNumber =
          vm.taxDocumentKind === 'tax_receipt' && vm.billDocumentNumber
            ? vm.billDocumentNumber
            : primaryNumber;
        // 064 — as-paid rows: the main pdf IS the final legal document; the
        // shared downloadLabelKeys helper maps mainPdfKind → label/aria keys
        // (mirrors the desktop table). 088 — on a paid bill the main pdf is
        // the SC bill, so the control names the SC (not the RC).
        const invoiceLabel =
          vm.displayStatus === 'void'
            ? t('actions.downloadVoided')
            : t(downloadLabelKeys(vm.mainPdfKind).labelKey);
        const invoiceAria = t(
          vm.displayStatus === 'void'
            ? 'actions.downloadVoidedAria'
            : downloadLabelKeys(vm.mainPdfKind).ariaKey,
          { number: mainDownloadNumber },
        );
        // The receipt reference: the separate-mode receipt number, else the
        // invoice doc number, else the raw id — one value for the visible
        // doc-ref and the SR aria. Mirrors the desktop table.
        const receiptRef = vm.receiptNumber ?? vm.displayNumber ?? vm.invoiceId;
        return (
          <li
            key={vm.invoiceId}
            // 064 remediation S3 — displayNumber resolves β as-paid rows to
            // their printed §105 receipt number; the row UUID fallback is a
            // last-resort that no numbered row reaches any more. 088 — an unpaid
            // bill's summary reads under its SC number (via `primaryNumber`).
            aria-label={`${t('detail.title')} ${primaryNumber}, ${statusLabel}`}
          >
            {/* Spec 122 US4 — an AURA card per invoice (the `Invoices-mobile`
                board's stacked rows), hairline divider above the total. */}
            <Card>
              {/* A size container, so the facts grid below can reflow to one
                  column when the card is too narrow for it (R13: 200% text). */}
              <div className="@container flex flex-col gap-3">
                {/* Header: doc-number link + document-kind badge (left) +
                    status badge (right). */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    {/* 088 review fix — wrap ONLY when an 088 document-kind
                        badge is present (a long TH/SV badge e.g.
                        "ใบกำกับภาษี/ใบเสร็จรับเงิน" would otherwise clip against the
                        `overflow-hidden` Card at 320px, WCAG 1.4.10/1.4.1). A
                        legacy/none row stays non-wrapping so the sole
                        `flex-wrap` container in a no-action card remains the
                        action group — the card sentinel test relies on that. */}
                    {/* 088 A-refined (FR-016) — a real 088 bill is ALWAYS shown
                        under its OWN (SC) number (via `primaryNumber`, paid AND
                        unpaid). The SC-/IN- prefix is self-documenting; the RC §86/4
                        tax receipt is a clickable link in the Receipt No. line
                        below. No per-row document-kind tag. */}
                    <div className="flex items-center gap-2">
                      <Link
                        href={`/portal/invoices/${vm.invoiceId}`}
                        className="rounded-[var(--aura-radius-sm)] text-[var(--aura-fg-primary)] underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        aria-label={`${t('actions.viewDetail')} ${primaryNumber}`}
                      >
                        <h2 className="font-mono text-sm font-medium leading-snug">
                          {primaryNumber}
                        </h2>
                      </Link>
                    </div>
                  </div>
                  <InvoiceStatusBadge
                    status={vm.displayStatus}
                    label={statusLabel}
                    className="shrink-0"
                  />
                </div>

                {/* Spec 122 US4 (`Invoices-mobile` board) — the facts as a
                    2-column grid under the header: Issued, Due, then Receipt No.
                    and Total. Each value stays on one line ("15 ต.ค. 2569").
                    Total always sits in the right-hand column so it lines up
                    card to card. Below 16rem of card width the grid is one
                    column: rem-based, so 200% text reflows it too instead of
                    pushing an unbreakable amount past the screen (R13). Receipt No. is separate-mode only, as before:
                    combined mode omits it (the combined download is in the
                    action row). 088 A-refined (FR-016) — on a real tax_receipt
                    row the RC is a link to the detail whose aria-label names the
                    document; legacy separate-mode rows keep plain text. */}
                <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-[var(--aura-border-default)] pt-3 @max-[16rem]:grid-cols-1">
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('columns.issueDate')}</dt>
                    <dd data-testid="portal-invoice-card-issue-date" className="m-0 whitespace-nowrap text-sm">
                      {formatDate(vm.issueDate, locale)}
                    </dd>
                  </div>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('columns.dueDate')}</dt>
                    <dd data-testid="portal-invoice-card-due-date" className="m-0 whitespace-nowrap text-sm">
                      {formatDate(vm.dueDate, locale)}
                    </dd>
                  </div>
                  {vm.receiptNumber ? (
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('columns.receiptNumber')}</dt>
                      <dd className="m-0 truncate font-mono text-sm tabular-nums text-[var(--aura-fg-primary)]">
                        {tTax088 && vm.taxDocumentKind === 'tax_receipt' ? (
                          <Link
                            href={`/portal/invoices/${vm.invoiceId}`}
                            aria-label={tTax088('seeReceiptLink', { number: vm.receiptNumber })}
                            className="underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                          >
                            {vm.receiptNumber}
                          </Link>
                        ) : (
                          vm.receiptNumber
                        )}
                      </dd>
                    </div>
                  ) : null}
                  <div className="col-start-2 flex min-w-0 flex-col gap-0.5 @max-[16rem]:col-start-auto">
                    <dt className="text-xs text-[var(--aura-fg-secondary)]">{t('columns.total')}</dt>
                    <dd className="m-0 whitespace-nowrap text-sm font-semibold tabular-nums">
                      {formatSatangThb(vm.total?.satang ?? null, locale)}
                    </dd>
                  </div>
                </dl>

                {/* Actions — the SAME set of documents + resend as the table
                    cell, driven by vm.* flags, laid out for a phone: one
                    labelled download, then the "⋯" menu with the rest (spec
                    122 US4, option C; the table lists them inline). Wraps on
                    a 320px card.

                    060-member-portal-d4 (F4) — when there is NO action to show
                    (`!rowHasAnyAction(vm)`: an issued invoice whose PDF hasn't
                    rendered → all four flags false) render the SAME em-dash
                    sentinel the desktop table renders, INSTEAD of an empty
                    action group (which previously left a blank gap after the
                    Separator). */}
                {rowHasAnyAction(vm) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {/* Spec 122 US4 (option C) — ONE labelled download fills
                        the row: the receipt once paid (the document a member
                        files), else the invoice. The "⋯" menu beside it holds
                        the other document and "Email me a copy"; it renders
                        only when it has an item (a void invoice has none). */}
                    {vm.showReceipt ? (
                      <PortalReceiptDownloadButton
                        invoiceId={vm.invoiceId}
                        documentNumber={receiptRef}
                        // Combined-mode label is the SHORT verb-less
                        // `actions.downloadCombined` ("Tax invoice / Receipt");
                        // the download icon carries "download". Separate-mode
                        // keeps the short "Receipt"; the full aria label is
                        // preserved for SR users.
                        label={
                          vm.isCombinedPaid
                            ? t('actions.downloadCombined')
                            : t('actions.downloadReceipt')
                        }
                        ariaLabel={t(
                          vm.isCombinedPaid
                            ? 'actions.downloadCombinedAria'
                            : 'actions.downloadReceiptAria',
                          { number: receiptRef },
                        )}
                        className={cn(
                          buttonClass({ variant: 'secondary', size: 'sm' }),
                          'min-h-11 flex-1 px-3',
                          // The combined label WRAPS to 2 lines inside a 320px
                          // card instead of clipping; `min-h-11` keeps the
                          // ≥44px tap target.
                          vm.isCombinedPaid && 'h-auto whitespace-normal',
                        )}
                      />
                    ) : vm.showInvoice ? (
                      <PortalInvoiceDownloadButton
                        invoiceId={vm.invoiceId}
                        documentNumber={mainDownloadNumber}
                        label={invoiceLabel}
                        ariaLabel={invoiceAria}
                        className={cn(
                          buttonClass({ variant: 'secondary', size: 'sm' }),
                          'min-h-11 flex-1 px-3',
                          vm.mainPdfKind === 'combined' && 'h-auto whitespace-normal',
                        )}
                      />
                    ) : null}
                    {(vm.showReceipt && vm.showInvoice) || vm.resendable ? (
                      <PortalInvoiceCardMenu
                        invoiceId={vm.invoiceId}
                        label={t('actions.moreActions', { number: primaryNumber })}
                        invoiceDownload={
                          vm.showReceipt && vm.showInvoice
                            ? {
                                documentNumber: mainDownloadNumber,
                                label: t('actions.menuDownloadInvoice'),
                              }
                            : undefined
                        }
                        resendable={vm.resendable}
                      />
                    ) : null}
                    {/* 088 T066a — receipt mid-render: the async watcher
                        (aria-live announce + auto-refresh poll), on its own
                        row under the buttons. Mirrors the desktop table; both
                        consume vm.receiptPending. */}
                    {vm.receiptPending && (
                      <ReceiptStatusWatcher
                        invoiceId={vm.invoiceId}
                        // Card only: wrap inside the card at 200% text (WCAG
                        // 1.4.4) instead of being clipped by its
                        // `overflow-hidden`. The desktop table keeps the
                        // one-line chip (a wide table may scroll).
                        className="h-auto max-w-full whitespace-normal"
                      />
                    )}
                    {/* 088 T066a — TERMINAL receipt-render failure: a calm
                        support-path affordance (NOT a dead "unavailable"), NO
                        aria-busy/spinner. Shared ReceiptFailedSupportHint with
                        the desktop table so table + card can never drift. */}
                    {vm.receiptFailed && (
                      <ReceiptFailedSupportHint
                        label={t('actions.receiptFailedSupport')}
                      />
                    )}
                  </div>
                ) : (
                  // No document/action to show — mirror the desktop table's
                  // em-dash sentinel instead of an empty action group.
                  <EmptyCell />
                )}
              </div>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
