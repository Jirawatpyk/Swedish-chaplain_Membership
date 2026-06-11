/**
 * T057 — Invoices admin table (F4).
 *
 * Visual parity with members-table: shadcn `Table` primitive + `Badge`
 * variants, cell `align-middle`, row hover `bg-accent/40`, header
 * `text-xs uppercase tracking-wide text-muted-foreground`. Kept plain
 * (no TanStack/selection) for MVP — SweCham has < 200 active invoices
 * per year; sort/selection arrive in a later polish pass.
 *
 * Columns (identity-first per AccRevo / Thai bookkeeper workflow):
 *   Number · Receipt No. · Member · Status · [Method?] · Issued ·
 *   Due · Total · Actions
 *
 *   - Receipt No. sits right after Number so the bookkeeper can scan
 *     both §87 document numbers (invoice + receipt) without crossing
 *     the Member column. Shows `receiptDocumentNumberRaw` for paid+
 *     separate-mode rows; em-dash for combined-mode (reuses invoice
 *     number) and for unpaid rows.
 *   - All columns use `whitespace-nowrap` so dates / numbers / badges
 *     stay on one line. Column widths rely on auto-layout (no w-px)
 *     so slack distributes proportionally across columns instead of
 *     piling into the only flex column.
 *   - Method column is opt-in via `?paidOnline=1` (F5 reconciliation
 *     filter).
 * Download link is suppressed on drafts (no PDF yet) to avoid 404s.
 */
'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations, useLocale } from 'next-intl';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { toast } from 'sonner';
import { AlertCircleIcon, InfoIcon, Loader2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { downloadInvoice, downloadReceipt } from '../_lib/download-receipt-client';
import type { InvoiceStatus } from '@/modules/invoicing';

/**
 * R9-TY1 — `'overdue'` is a presentation-only derived status (T109,
 * FR-028) layered on top of the canonical `InvoiceStatus` domain
 * enum. The list page replaces `'issued'` with `'overdue'` when the
 * Bangkok-today read-time rule fires. Keeping the union here (rather
 * than widening to `string`) means a new domain status (e.g.
 * `'refunded'`) will fail typecheck on `statusVariant`/`StatusBadge`
 * exhaustiveness, surfacing the gap at compile time instead of
 * silently falling into the `default: outline` branch.
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
  readonly totalSatang: string;
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
   * page.tsx as `status === 'paid' && receiptPdf !== null` — i.e. the
   * invoice is paid AND the receipt-stamped bytes have been persisted. A
   * non-null `receiptPdf` IS the admin's "receipt has rendered" signal
   * (the async worker only writes the blob once the PDF exists), so this
   * flag doubles as the rendered-receipt gate. The Actions cell uses it
   * to decide whether to render the "Receipt" download link, and the
   * Receipt-No. cell uses it to gate the combined-mode hint.
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
};

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

function statusVariant(status: RowStatus): BadgeVariant {
  switch (status) {
    case 'paid':
      return 'default';
    case 'issued':
      return 'secondary';
    case 'overdue':
      return 'destructive';
    case 'void':
    case 'credited':
    case 'partially_credited':
    case 'draft':
      return 'outline';
  }
}

function StatusBadge({ status }: { status: RowStatus }) {
  const t = useTranslations('admin.invoices.list.statuses');
  return (
    <Badge variant={statusVariant(status)}>
      {/* Icon on overdue so WCAG 1.4.1 "Use of Color" is satisfied:
          state is not conveyed by color alone. Icon aria-hidden;
          text label is canonical. */}
      {status === 'overdue' && (
        <AlertCircleIcon className="mr-1 size-3" aria-hidden="true" />
      )}
      {t(status)}
    </Badge>
  );
}

function formatSatang(satang: string): string {
  const n = BigInt(satang);
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = n < 0n ? '-' : '';
  // Explicit 'en-US' pins thousand-separator output (FR-005); SSR/CSR
  // locale drift would otherwise hydrate-mismatch on currency display.
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

const headCls = 'text-xs uppercase tracking-wide text-muted-foreground';

function MethodBadge({ method }: { method: 'card' | 'promptpay' }) {
  const t = useTranslations('admin.paymentReconciliation.methodBadge');
  const tCol = useTranslations('admin.invoices.list.columns');
  return (
    <Badge
      variant="secondary"
      data-testid={`method-badge-${method}`}
      className="font-normal"
      // SR users hearing only "Card" without column context get an
      // ambiguous label. aria-label prepends the column name so
      // row-by-row reading produces "Method: Card" / "Method: PromptPay".
      aria-label={`${tCol('method')}: ${t(method)}`}
    >
      {t(method)}
    </Badge>
  );
}

export function InvoicesTable({
  rows,
  showMethodColumn = false,
}: {
  rows: readonly InvoicesTableRow[];
  /**
   * F5 Phase 5 (T096) — render the Method column when active. Driven by
   * the `?paidOnline=1` admin reconciliation filter; hidden by default
   * to keep the standard list compact (95% of rows would carry no badge).
   */
  showMethodColumn?: boolean;
}) {
  const t = useTranslations('admin.invoices.list');
  const tDetail = useTranslations('admin.invoices.detail');
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
  // matches the invoice-more-menu pattern.
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
  return (
    // Inset shadow on the right edge cues mobile users that the table
    // scrolls horizontally (8 cols with Method on; 7 otherwise);
    // without it the overflow was invisible. Dual-tone (light + dark)
    // so the cue stays visible — the rgba(0,0,0,0.08) ink disappears
    // on `bg-card` dark surfaces alone.
    <div className="overflow-x-auto shadow-[inset_-12px_0_8px_-12px_rgba(0,0,0,0.08)] dark:shadow-[inset_-12px_0_8px_-12px_rgba(255,255,255,0.10)]">
      <Table aria-label={t('tableCaption')}>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.documentNumber')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.receiptNumber')}
            </TableHead>
            <TableHead scope="col" className={headCls}>
              {t('columns.buyer')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.status')}
            </TableHead>
            {showMethodColumn && (
              <TableHead
                scope="col"
                className={`${headCls} whitespace-nowrap`}
                data-testid="column-header-method"
              >
                {t('columns.method')}
              </TableHead>
            )}
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.issueDate')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.dueDate')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap text-right`}>
              {t('columns.total')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap text-right`}>
              {t('columns.actions')}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow
              key={r.invoiceId}
              className="hover:bg-accent/40 focus-within:bg-accent/40"
            >
              <TableCell className="align-middle whitespace-nowrap">
                <Link
                  href={`/admin/invoices/${r.invoiceId}`}
                  className="cursor-pointer font-medium focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                >
                  {r.documentNumber}
                </Link>
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap">
                {r.receiptDocumentNumberRaw ? (
                  <span className="font-mono text-sm tabular-nums">
                    {r.receiptDocumentNumberRaw}
                  </span>
                ) : r.hasReceiptPdf && r.status === 'paid' ? (
                  // Combined-mode (receipt reuses the invoice number per
                  // Thai RD §86/4 + §105ทวิ). Gate on the SAME condition as
                  // the action cell's `isCombinedPaid` (= `hasReceiptPdf &&
                  // status === 'paid' && !receiptDocumentNumberRaw`;
                  // `hasReceiptPdf` is `paid && receiptPdf !== null`, i.e.
                  // the receipt PDF has actually rendered). The
                  // `receiptDocumentNumberRaw` falsy branch above already
                  // supplies the `&& !receiptDocumentNumberRaw` clause.
                  // Previously this gated on the raw `r.status === 'paid'`,
                  // so a paid combined-mode invoice whose receipt PDF was
                  // still rendering (`receiptPdfStatus = 'pending'`) showed
                  // the "receipt = invoice number" hint PREMATURELY while
                  // the action cell correctly showed "Preparing receipt…".
                  // Now this cell and the action cell both gate on the
                  // receipt PDF being PRESENT (`hasReceiptPdf` = paid +
                  // receiptPdf !== null), which is the admin's own
                  // rendered-receipt signal. This is the same INTENT as
                  // the member-portal fix (060-member-portal-d4) — don't
                  // surface receipt-derived UI until the receipt has
                  // rendered — but a DIFFERENT mechanism: admin reads
                  // `hasReceiptPdf` (PDF blob present) while the portal VM
                  // reads `receiptPdfStatus === 'rendered'`. The two
                  // predicates are not identical and can momentarily
                  // disagree during the async render window; they merely
                  // share the goal of gating on a rendered receipt. The
                  // hover-only tooltip was removed: its `<span>` trigger
                  // was not keyboard-focusable and not touch-reachable
                  // (base-ui tooltips are hover/focus only), so the hint
                  // never surfaced on touch or keyboard — only desktop
                  // mouse. The `aria-label` already conveys the full
                  // combined-mode explanation to assistive tech, so SR
                  // users keep complete coverage; we drop the redundant
                  // dead-on-touch tooltip rather than inject a
                  // non-actionable tab stop. Mirrors the members table's
                  // dead edit-hint tooltip removal.
                  <span
                    className="inline-flex min-h-6 items-center gap-1 text-sm text-muted-foreground"
                    aria-label={t('receiptNumberCombinedAria')}
                  >
                    —
                    <InfoIcon className="size-3.5" aria-hidden="true" />
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="align-middle">
                {/* 054-event-fee-invoices — buyer column. First line: the
                    buyer name (+ Event chip on event rows). Second line
                    (Task 14): the muted subtitle describing the invoice —
                    event name + CE date, or "Membership {year}". */}
                <div className="flex flex-col gap-0.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Membership invoices (and matched-member event
                        invoices) link to the F3 member; event NON-member
                        buyers have no member row, so the name renders as
                        plain text — NOT a broken `/admin/members/` link
                        with an empty id. */}
                    {r.buyerHasMemberLink ? (
                      <Link
                        href={`/admin/members/${r.memberId}`}
                        className="focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                      >
                        {r.memberName}
                      </Link>
                    ) : (
                      <span>{r.memberName}</span>
                    )}
                    {r.invoiceSubject === 'event' && (
                      // Event chip — surfaces event-fee invoices at a glance.
                      // aria-label gives SR users the full "Event-fee invoice"
                      // context (the visible "Event" chip is terse for layout).
                      // The subtitle below carries the event NAME + date.
                      <Badge
                        variant="secondary"
                        className="font-normal"
                        aria-label={t('subjectChip.eventAria')}
                      >
                        {t('subjectChip.event')}
                      </Badge>
                    )}
                  </div>
                  {r.buyerSubtitle !== null && (
                    // Muted detail line. `block` so it stacks under the
                    // name; `text-xs text-muted-foreground` keeps it a
                    // secondary scan cue. Stacked text reflows cleanly at
                    // 320px (no fixed width / nowrap).
                    <span className="block text-xs text-muted-foreground">
                      {r.buyerSubtitle}
                    </span>
                  )}
                </div>
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={r.status} />
                  {r.creditNoteCount > 0 && (
                    // CN indicator chip. Shows only when ≥1 CN exists
                    // on the row. shadcn Tooltip (not the legacy
                    // `title` attribute) so the hint reaches mobile/
                    // touch + keyboard focus + SR accessibility tree.
                    <TooltipProvider delay={200}>
                      <Tooltip>
                        <TooltipTrigger
                          render={(props) => (
                            <Badge
                              {...props}
                              variant="outline"
                              className="font-mono text-[10px] tabular-nums"
                              aria-label={t('creditedAria', {
                                count: r.creditNoteCount,
                                amount: formatSatang(r.creditedTotalSatang),
                              })}
                            >
                              {t('creditedSuffix', { count: r.creditNoteCount })}
                            </Badge>
                          )}
                        />
                        <TooltipContent>
                          {t('creditedTooltip', {
                            count: r.creditNoteCount,
                            amount: formatSatang(r.creditedTotalSatang),
                          })}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  )}
                </div>
              </TableCell>
              {showMethodColumn && (
                <TableCell className="align-middle whitespace-nowrap">
                  {r.onlinePaymentMethod ? (
                    <MethodBadge method={r.onlinePaymentMethod} />
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="align-middle whitespace-nowrap">
                {r.issueDate ? formatLocalisedDate(r.issueDate, locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'}
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap">
                {r.dueDate ? formatLocalisedDate(r.dueDate, locale, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '—'}
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap text-right tabular-nums">
                {formatSatang(r.totalSatang)} THB
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap text-right">
                {/* Action mix mirrors the invoice-detail "⋯" menu
                    (Thai RD §86/4 + §105ทวิ combined-mode rule):
                      - paid + combined  → Receipt only (the dual-role
                        PDF; pre-payment invoice is a stale draft)
                      - paid + separate  → Invoice + Receipt (two
                        distinct §87 legal docs)
                      - issued / void    → Invoice only
                    Plain <a download> — PDF endpoint returns binary
                    bytes; Next.js <Link> would misinterpret as RSC
                    payload. */}
                {(() => {
                  // `receiptDocumentNumberRaw === null` is the SINGLE
                  // source of truth for "this paid invoice uses one
                  // legal document for both invoice + receipt" (Thai
                  // RD §86/4 + §105ทวิ). Do NOT infer from
                  // `tenant_invoice_settings.receipt_numbering_mode`
                  // — that flag describes the tenant's CURRENT mode;
                  // an invoice paid before a mode flip keeps its own
                  // immutable snapshot. Read the row, not the setting.
                  const isCombinedPaid =
                    r.hasReceiptPdf && r.status === 'paid' && !r.receiptDocumentNumberRaw;
                  const showInvoice = r.hasPdf && !isCombinedPaid;
                  // Async receipt-PDF gate. Paid + receiptPdfStatus
                  // pending/failed/null surfaces a "preparing…"
                  // affordance alongside the Invoice button.
                  // Bookkeepers otherwise saw a paid row with only
                  // an Invoice download and no signal that the
                  // §86/4+§105ทวิ legal doc is on its way.
                  const receiptPending =
                    r.status === 'paid' &&
                    r.receiptPdfStatus !== null &&
                    r.receiptPdfStatus !== 'rendered';
                  if (!showInvoice && !r.hasReceiptPdf && !receiptPending) {
                    return <span className="text-sm text-muted-foreground">—</span>;
                  }
                  return (
                    <div className="flex items-center justify-end gap-1">
                      {showInvoice && (
                        // Button (not <a download>) routes through
                        // the shared fetch+blob helper so 4xx/5xx
                        // surface as toasts instead of JSON in a new
                        // tab. aria-label via t() interpolation so
                        // the dash separator is locale-controlled
                        // (TH/SV read naturally; English string-concat
                        // would force "Invoice — INV-2026-0001"
                        // literally).
                        <button
                          type="button"
                          onClick={() =>
                            handleRowDownload(
                              'invoice',
                              r.invoiceId,
                              `${r.documentNumber}.pdf`,
                            )
                          }
                          disabled={downloadingKeys.has(`invoice:${r.invoiceId}`)}
                          // 064 remediation S7 — β rows: the main pdf IS the
                          // §105 receipt, so label + aria flip to the receipt
                          // wording (the endpoint/testid stay the main-pdf
                          // ones; only the presentation changes).
                          aria-label={t(
                            r.mainDownloadIsReceipt
                              ? 'actions.downloadReceiptAria'
                              : 'actions.downloadInvoiceAria',
                            {
                              number: r.documentNumber,
                            },
                          )}
                          className={cn(
                            buttonVariants({ variant: 'ghost', size: 'sm' }),
                            'min-h-11 px-3 gap-1',
                          )}
                          data-testid="row-download-invoice"
                        >
                          {downloadingKeys.has(`invoice:${r.invoiceId}`) && (
                            <Loader2
                              className="size-4 motion-safe:animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {r.mainDownloadIsReceipt
                            ? t('actions.downloadReceipt')
                            : t('actions.download')}
                        </button>
                      )}
                      {r.hasReceiptPdf && (
                        <button
                          type="button"
                          onClick={() =>
                            handleRowDownload(
                              'receipt',
                              r.invoiceId,
                              `${r.receiptDocumentNumberRaw ?? r.documentNumber}-receipt.pdf`,
                            )
                          }
                          disabled={downloadingKeys.has(`receipt:${r.invoiceId}`)}
                          aria-label={t('actions.downloadReceiptAria', {
                            number:
                              r.receiptDocumentNumberRaw ?? r.documentNumber,
                          })}
                          className={cn(
                            buttonVariants({ variant: 'ghost', size: 'sm' }),
                            'min-h-11 px-3 gap-1',
                          )}
                          data-testid="row-download-receipt"
                        >
                          {downloadingKeys.has(`receipt:${r.invoiceId}`) && (
                            <Loader2
                              className="size-4 motion-safe:animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {t('actions.downloadReceipt')}
                        </button>
                      )}
                      {receiptPending && (
                        // Paid + receipt-render in flight. `role=status
                        // aria-live=polite` so SR users hear the async
                        // state when the bookkeeper scans the table.
                        // Style matches portal list for visual parity.
                        <span
                          role="status"
                          aria-live="polite"
                          aria-busy="true"
                          className={cn(
                            buttonVariants({ variant: 'outline', size: 'sm' }),
                            'min-h-11 px-3 cursor-progress',
                          )}
                          data-testid="row-receipt-pending"
                        >
                          {t('actions.receiptPreparing')}
                        </span>
                      )}
                    </div>
                  );
                })()}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
