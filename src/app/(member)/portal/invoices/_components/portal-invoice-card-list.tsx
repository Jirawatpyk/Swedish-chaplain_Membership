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
 * `resendable`, `isCombinedPaid`) — so the card + table can never drift
 * apart. Formatting (date / money / badge variant / status icon) and the
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
import { AlertTriangle, Ban, CheckCircle2, Clock, FileText, type LucideIcon } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from '../_utils/format';
import type { InvoiceRowViewModel } from '../_utils/invoice-row-view-model';
import { ResendInvoiceButton } from './resend-invoice-button';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from './portal-pdf-download-button';

const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

/**
 * One row's data for the card list — the SAME `{ row, vm }` shape the
 * page builds for the table. `row` is intentionally NOT typed wider than
 * needed: the card only reads `vm.*` for flags; the raw row is unused
 * here (all flags live on the VM), so we accept just the VM.
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
  /** `tStatus` bound to `admin.invoices.list.statuses` (status badge text). */
  readonly tStatus: (key: string) => string;
  /** Forwarded to the root `<ul>` — the page passes `md:hidden`. */
  readonly className?: string;
}

export function PortalInvoiceCardList({
  rows,
  locale,
  t,
  tStatus,
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
        const Icon = STATUS_ICON_MAP[statusIconName(vm.displayStatus)];
        return (
          <li
            key={vm.invoiceId}
            aria-label={`${t('detail.title')} ${vm.documentNumber ?? vm.invoiceId}, ${statusLabel}`}
          >
            <Card>
              <CardContent className="flex flex-col gap-3">
                {/* Header: doc-number link (left) + status badge (right). */}
                <div className="flex items-start justify-between gap-3">
                  <Link
                    href={`/portal/invoices/${vm.invoiceId}`}
                    className="rounded-sm underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                    aria-label={`${t('actions.viewDetail')} ${vm.documentNumber ?? vm.invoiceId}`}
                  >
                    <h2 className="font-mono text-sm font-medium leading-snug">
                      {vm.documentNumber ?? vm.invoiceId}
                    </h2>
                  </Link>
                  <Badge
                    variant={statusBadgeVariant(vm.displayStatus)}
                    className="inline-flex shrink-0 items-center gap-1"
                  >
                    <Icon className="size-3.5" aria-hidden="true" />
                    {statusLabel}
                  </Badge>
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

                {/* Actions — SAME conditional set + props as the table cell,
                    driven by vm.* flags. Wraps on a 320px card. */}
                <div className="flex flex-wrap items-center gap-2">
                  {vm.resendable ? (
                    <ResendInvoiceButton
                      invoiceId={vm.invoiceId}
                      documentNumber={vm.documentNumber ?? vm.invoiceId}
                      variant="outline"
                      layout="full"
                      className="min-h-11"
                    />
                  ) : null}
                  {vm.showInvoice && (
                    <PortalInvoiceDownloadButton
                      invoiceId={vm.invoiceId}
                      documentNumber={vm.documentNumber ?? vm.invoiceId}
                      label={
                        vm.displayStatus === 'void'
                          ? t('actions.downloadVoided')
                          : t('actions.download')
                      }
                      ariaLabel={t(
                        vm.displayStatus === 'void'
                          ? 'actions.downloadVoidedAria'
                          : 'actions.downloadInvoiceAria',
                        { number: vm.documentNumber ?? vm.invoiceId },
                      )}
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'sm' }),
                        'min-h-11 px-3',
                      )}
                    />
                  )}
                  {vm.showReceipt && (
                    <PortalReceiptDownloadButton
                      invoiceId={vm.invoiceId}
                      documentNumber={
                        vm.receiptNumber ?? vm.documentNumber ?? vm.invoiceId
                      }
                      label={
                        vm.isCombinedPaid
                          ? t('actions.downloadCombined')
                          : t('actions.downloadReceipt')
                      }
                      ariaLabel={t('actions.downloadReceiptAria', {
                        number: vm.receiptNumber ?? vm.documentNumber ?? vm.invoiceId,
                      })}
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'sm' }),
                        'min-h-11 px-3',
                      )}
                    />
                  )}
                  {vm.receiptPending && (
                    <span
                      role="status"
                      aria-live="polite"
                      aria-busy="true"
                      className={cn(
                        buttonVariants({ variant: 'outline', size: 'sm' }),
                        'min-h-11 px-3 cursor-progress',
                      )}
                    >
                      {t('actions.receiptPreparing')}
                    </span>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
