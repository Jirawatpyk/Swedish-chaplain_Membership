/**
 * 060-member-portal-d4 (Task 2) — Mobile card list for /portal/invoices.
 *
 * Server Component. Renders the same per-row data as the desktop
 * `<table>` (in `page.tsx`) as a stacked card list for narrow viewports
 * (`< md`). The page dual-renders: `<table>` inside `hidden md:block`,
 * this list with `className="md:hidden"`.
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
 *   │ INV-2026-0001                 [✓ Paid]     │  doc# link (font-mono) · status Badge (icon+text)
 *   │ Issued 1 Apr 2026 · Due 15 Apr 2026        │  dates (muted) — reuse columns.issueDate/.dueDate labels
 *   │ Receipt No. RCP-2026-0042                   │  ONLY in separate-mode (vm.receiptNumber)
 *   │ ─────────────────────────────────────────  │  divider
 *   │ 50,000.00 THB                               │  total (prominent)
 *   │ [ Invoice ] [ Receipt ] [ Resend ]          │  inline actions ≥44px, flex-wrap (never overflow 320px)
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
 *   - Action buttons keep their `min-h-11` (≥44px) treatment and wrap
 *     (`flex flex-wrap`) so a 320px card never scrolls horizontally.
 */
import Link from 'next/link';
import { InfoIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
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
import { ResendInvoiceButton } from './resend-invoice-button';
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
  /** Forwarded to the root `<ul>` — the page passes `md:hidden`. */
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
        return (
          <li
            key={vm.invoiceId}
            // 064 remediation S3 — displayNumber resolves β as-paid rows to
            // their printed §105 receipt number; the row UUID fallback is a
            // last-resort that no numbered row reaches any more. 088 — an unpaid
            // bill's summary reads under its SC number (via `primaryNumber`).
            aria-label={`${t('detail.title')} ${primaryNumber}, ${statusLabel}`}
          >
            <Card>
              <CardContent className="flex flex-col gap-3">
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
                    <div
                      className={
                        tTax088 && vm.taxDocumentKind !== 'none'
                          ? 'flex flex-wrap items-center gap-2'
                          : 'flex items-center gap-2'
                      }
                    >
                      <Link
                        href={`/portal/invoices/${vm.invoiceId}`}
                        className="rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        aria-label={`${t('actions.viewDetail')} ${primaryNumber}`}
                      >
                        <h2 className="font-mono text-sm font-medium leading-snug">
                          {primaryNumber}
                        </h2>
                      </Link>
                      {/* 088 T065 — the RC IS the §86/4 tax receipt (presented
                          first, next to the primary number). Text badge (WCAG
                          1.4.1 — not colour alone). The `tTax088 &&` guard both
                          gates on the flag (prop present) AND narrows the
                          translator to defined for the call. */}
                      {tTax088 && vm.taxDocumentKind === 'tax_receipt' ? (
                        <Badge variant="secondary" className="shrink-0">
                          {tTax088('badgeTaxReceipt')}
                        </Badge>
                      ) : null}
                      {/* 088 T065a — an UNPAID bill shows the ใบแจ้งหนี้/Invoice
                          document-kind label. */}
                      {tTax088 && vm.taxDocumentKind === 'bill' ? (
                        <Badge variant="outline" className="shrink-0">
                          {tTax088('billTitle')}
                        </Badge>
                      ) : null}
                    </div>
                    {/* 088 T065a — the SC bill of a PAID invoice is a payable
                        record, not a tax document. Text + icon (WCAG 1.4.1) +
                        a clickable "see tax receipt RC-…" cross-reference that
                        names its target (T065c) and navigates to the RC on the
                        detail page. */}
                    {tTax088 && vm.taxDocumentKind === 'tax_receipt' && vm.billDocumentNumber ? (
                      <p className="flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-muted-foreground">
                        <InfoIcon className="size-3 shrink-0" aria-hidden="true" />
                        <span className="font-mono">{vm.billDocumentNumber}</span>
                        <span aria-hidden="true">·</span>
                        <span>{tTax088('badgeBillPayableRecord')}</span>
                        <Link
                          href={`/portal/invoices/${vm.invoiceId}`}
                          className="underline underline-offset-2 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        >
                          {tTax088('seeReceiptLink', { number: vm.receiptNumber ?? '' })}
                        </Link>
                      </p>
                    ) : null}
                  </div>
                  <InvoiceStatusBadge
                    status={vm.displayStatus}
                    label={statusLabel}
                    className="shrink-0"
                  />
                </div>

                {/* Dates — reuse the existing column labels as inline labels. */}
                <p className="text-sm text-muted-foreground">
                  {t('columns.issueDate')} {formatDate(vm.issueDate, locale)} ·{' '}
                  {t('columns.dueDate')} {formatDate(vm.dueDate, locale)}
                </p>

                {/* Receipt number — separate-mode only. Combined-mode (em-dash
                    + tooltip hint on the table) is omitted on the card; the
                    combined Receipt download still appears in the action row. */}
                {vm.receiptNumber ? (
                  <p className="text-sm text-muted-foreground">
                    {t('columns.receiptNumber')}{' '}
                    <span className="font-mono tabular-nums text-foreground">
                      {vm.receiptNumber}
                    </span>
                  </p>
                ) : null}

                <Separator />

                {/* Total — prominent. */}
                <p className="text-base font-semibold tabular-nums">
                  {formatSatangThb(vm.total?.satang ?? null, locale)}
                </p>

                {/* Actions — SAME conditional set + flag-gating as the table
                    cell, driven by vm.* flags; the button `variant` differs
                    (card = `outline`, table = `ghost`). Wraps on a 320px card.

                    Order (D4): the TEXT download buttons (Invoice / Receipt)
                    come first, then the icon-only resend square LAST. This is a
                    DELIBERATE divergence from the desktop table, which renders
                    the resend FIRST (leading). Only the compact / icon-only
                    treatment of the resend control is shared with the table;
                    the card places it last (and uses `variant="outline"` vs the
                    table's `ghost`) so the primary "grab my document" CTAs sit
                    leftmost where the eye lands first.

                    060-member-portal-d4 (F4) — when there is NO action to show
                    (`!rowHasAnyAction(vm)`: an issued invoice whose PDF hasn't
                    rendered → all four flags false) render the SAME em-dash
                    sentinel the desktop table renders, INSTEAD of an empty
                    action group (which previously left a blank gap after the
                    Separator). */}
                {rowHasAnyAction(vm) ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {vm.showInvoice && (
                      <PortalInvoiceDownloadButton
                        invoiceId={vm.invoiceId}
                        documentNumber={mainDownloadNumber}
                        // 064 — as-paid rows: the main pdf IS the final legal
                        // document; shared downloadLabelKeys helper (wave-4
                        // S17) maps mainPdfKind → label/aria keys. Mirrors
                        // the desktop table. 088 — on a paid bill the main pdf
                        // is the SC bill, so the control names the SC (not RC).
                        label={
                          vm.displayStatus === 'void'
                            ? t('actions.downloadVoided')
                            : t(downloadLabelKeys(vm.mainPdfKind).labelKey)
                        }
                        ariaLabel={t(
                          vm.displayStatus === 'void'
                            ? 'actions.downloadVoidedAria'
                            : downloadLabelKeys(vm.mainPdfKind).ariaKey,
                          { number: mainDownloadNumber },
                        )}
                        className={cn(
                          buttonVariants({ variant: 'outline', size: 'sm' }),
                          'min-h-11 px-3',
                          // Same wrap treatment the receipt button applies to
                          // its combined label — let the longer dual-role text
                          // wrap inside a 320px card instead of clipping.
                          vm.mainPdfKind === 'combined' &&
                            'h-auto min-h-11 whitespace-normal text-left',
                        )}
                      />
                    )}
                    {vm.showReceipt &&
                      (() => {
                        // 060-member-portal-d4 (final review) — the receipt
                        // reference (separate-mode receipt number, else the
                        // invoice doc number, else the raw id) was computed twice
                        // in this button (the `documentNumber` prop + the aria
                        // `number`). Hoist it so the visible doc-ref and the SR
                        // aria can never diverge. Mirrors the desktop table.
                        const receiptRef =
                          vm.receiptNumber ?? vm.displayNumber ?? vm.invoiceId;
                        return (
                          <PortalReceiptDownloadButton
                            invoiceId={vm.invoiceId}
                            documentNumber={receiptRef}
                            // Combined-mode label is the SHORT verb-less
                            // `actions.downloadCombined` ("Tax invoice / Receipt").
                            // The verb was dropped from that key so the download icon
                            // carries "download" and the card + desktop table + detail
                            // all share one label (no overflow on a 320px card).
                            // Separate-mode keeps the short "Receipt"; the full
                            // combined aria label is preserved below for SR users.
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
                              buttonVariants({ variant: 'outline', size: 'sm' }),
                              'min-h-11 px-3',
                              // Allow the combined label to WRAP to 2 lines within
                              // the card instead of clipping (Button defaults to
                              // `whitespace-nowrap` + the Card is `overflow-hidden`,
                              // which silently clipped the legally-required CTA).
                              // `h-auto` lets the button grow past its fixed sm
                              // height; `min-h-11` keeps the ≥44px tap target.
                              vm.isCombinedPaid && 'h-auto min-h-11 whitespace-normal text-left',
                            )}
                          />
                        );
                      })()}
                    {/* 088 T066a — receipt mid-render: the async watcher
                        (aria-live announce + auto-refresh poll). Mirrors the
                        desktop table; both consume vm.receiptPending. */}
                    {vm.receiptPending && (
                      <ReceiptStatusWatcher invoiceId={vm.invoiceId} />
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
                    {/* Resend ("Email me a copy") — icon-only square LAST in the
                        row. The compact / icon-only treatment is shared with the
                        desktop table's resend, but the placement diverges (the
                        table renders resend FIRST) and the variant differs (card
                        `outline` vs table `ghost`). `layout="compact"` renders
                        the Mail icon only; the component already sets
                        `aria-label` (emailCopyAria) so the icon-only control
                        keeps an accessible name. `min-h-11 min-w-11` keeps the
                        ≥44px square tap target (§9.1). */}
                    {vm.resendable ? (
                      <ResendInvoiceButton
                        invoiceId={vm.invoiceId}
                        documentNumber={vm.displayNumber ?? vm.invoiceId}
                        variant="outline"
                        layout="compact"
                        className="min-h-11 min-w-11"
                      />
                    ) : null}
                  </div>
                ) : (
                  // No document/action to show — mirror the desktop table's
                  // em-dash sentinel instead of an empty action group.
                  <EmptyCell />
                )}
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
