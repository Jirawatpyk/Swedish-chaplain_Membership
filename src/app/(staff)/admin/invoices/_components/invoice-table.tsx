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
import { useTranslations } from 'next-intl';
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

export type InvoicesTableRow = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly memberId: string;
  readonly memberName: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly totalSatang: string;
  readonly hasPdf: boolean;
  /**
   * G-2 — count of credit notes issued against this invoice.
   * Zero on 99% of invoices (paid/void/etc. rarely credited).
   * Rendered as a small outline chip beside the status badge so
   * admins can spot partially/fully credited rows without drilling
   * into detail.
   */
  readonly creditNoteCount: number;
  /** G-2 — cumulative credited amount in satang (stringified bigint). */
  readonly creditedTotalSatang: string;
  /**
   * F5 Phase 5 (T096) — succeeded online payment method, or null when
   * the invoice has no F5 succeeded payment. Surfaces as a Method-column
   * badge ONLY when `showMethodColumn` is true on the table (currently
   * the `?paidOnline=1` admin reconciliation view).
   */
  readonly onlinePaymentMethod: 'card' | 'promptpay' | null;
  /**
   * Receipt document number (e.g. `RC-2026-0001`) for paid invoices
   * issued under separate-mode numbering. `null` for combined-mode
   * (receipt reuses invoice number) and for any non-paid status.
   */
  readonly receiptDocumentNumberRaw: string | null;
  /**
   * Whether the row has a rendered receipt PDF available for download.
   * True when paid + receiptPdf is non-null + status='rendered'. The
   * Actions cell uses this flag to decide whether to render the
   * "Receipt" download link.
   */
  readonly hasReceiptPdf: boolean;
};

type BadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';

function statusVariant(status: string): BadgeVariant {
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
    default:
      return 'outline';
  }
}

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('admin.invoices.list.statuses');
  return (
    <Badge variant={statusVariant(status)}>
      {/* R7-S7 — icon on overdue so WCAG 1.4.1 "Use of Color" is
          satisfied: the state is not conveyed by color alone. Text
          label stays canonical; icon is aria-hidden. */}
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
  // N11 — explicit 'en-US' pins thousand-separator output. FR-005.
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
      // S3 verify-fix (2026-04-26): SR users hearing only "Card" without
      // column context get an ambiguous label. The aria-label adds the
      // column name so readers row-by-row get "Method: Card" / "Method: PromptPay".
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
  // Round-4 fix R4-UX-H1 — Set<string> instead of a single string slot.
  // The previous design hosted ONE in-flight download identifier
  // (`${variant}:${invoiceId}`). Pressing "Receipt" on row B while
  // row A's "Invoice" was still mid-fetch overwrote row A's spinner
  // key → row A's loader vanished and the user thought it failed. The
  // Set permits N concurrent row downloads with their own spinner state
  // and only adds bounded memory (max N pending requests).
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

  // Round-4 fix R4-code-B2 — wrap each row download in try/finally so a
  // throw inside `downloadInvoice/downloadReceipt` cannot leak a stuck
  // spinner state. The helpers already swallow errors via their own
  // catch, but a defensive finally costs nothing and matches the menu's
  // own pattern (parity with `invoice-more-menu.tsx`).
  const handleRowDownloadInvoice = async (
    invoiceId: string,
    fallbackFilename: string,
  ) => {
    const key = `invoice:${invoiceId}`;
    addDownloading(key);
    try {
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
    } finally {
      removeDownloading(key);
    }
  };

  const handleRowDownloadReceipt = async (
    invoiceId: string,
    fallbackFilename: string,
  ) => {
    const key = `receipt:${invoiceId}`;
    addDownloading(key);
    try {
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
    } finally {
      removeDownloading(key);
    }
  };
  return (
    // Verify-fix U-I4 (2026-04-26): inset shadow on the right edge gives
    // mobile users a visual cue that the table scrolls horizontally
    // (8 cols when the Method column is on; 7 otherwise). Without the
    // cue the overflow was invisible and admins missed columns to the
    // right. R2-fix Q1 (2026-04-26): dual-tone shadow so the cue is
    // visible in both light AND dark mode (the rgba(0,0,0,0.08) ink
    // disappeared on `bg-card` dark surfaces).
    <div className="overflow-x-auto shadow-[inset_-12px_0_8px_-12px_rgba(0,0,0,0.08)] dark:shadow-[inset_-12px_0_8px_-12px_rgba(255,255,255,0.10)]">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.documentNumber')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} whitespace-nowrap`}>
              {t('columns.receiptNumber')}
            </TableHead>
            <TableHead scope="col" className={headCls}>
              {t('columns.member')}
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
                  className="cursor-pointer font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                >
                  {r.documentNumber}
                </Link>
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap">
                {r.receiptDocumentNumberRaw ? (
                  <span className="font-mono text-sm tabular-nums">
                    {r.receiptDocumentNumberRaw}
                  </span>
                ) : r.status === 'paid' ? (
                  // Paid + null = combined-mode (receipt reuses invoice
                  // number). Em-dash + Info icon → admin sees the
                  // affordance on touch (no hover state needed) and
                  // can long-press / focus to see the tooltip
                  // explanation. Round-3 fix M-R2-05.
                  <TooltipProvider delay={200}>
                    <Tooltip>
                      <TooltipTrigger
                        render={(props) => (
                          <span
                            {...props}
                            className="inline-flex min-h-6 items-center gap-1 text-sm text-muted-foreground cursor-help"
                            aria-label={t('receiptNumberCombinedAria')}
                          >
                            —
                            {/* R4-UX-H3 — removed `opacity-70`; size-3.5
                                preserves the affordance with full
                                contrast against muted-foreground.
                                R5-UX-M2 — added `min-h-6` so the
                                TooltipTrigger surface meets WCAG 2.2
                                SC 2.5.8 (≥24×24px touch target) on
                                mobile (line-height of text-sm only
                                resolves to ~20px otherwise). */}
                            <InfoIcon
                              className="size-3.5"
                              aria-hidden="true"
                            />
                          </span>
                        )}
                      />
                      <TooltipContent>
                        {t('receiptNumberCombinedTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
              <TableCell className="align-middle">
                <Link
                  href={`/admin/members/${r.memberId}`}
                  className="hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                >
                  {r.memberName}
                </Link>
              </TableCell>
              <TableCell className="align-middle whitespace-nowrap">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={r.status} />
                  {r.creditNoteCount > 0 && (
                    // G-2 — CN indicator chip. Shows only when ≥1 CN
                    // exists on the row. shadcn Tooltip (not the legacy
                    // `title` attribute) so the hint surfaces on
                    // mobile/touch + keyboard focus + screen-reader
                    // accessible tree.
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
              <TableCell className="align-middle whitespace-nowrap">{r.issueDate ?? '—'}</TableCell>
              <TableCell className="align-middle whitespace-nowrap">{r.dueDate ?? '—'}</TableCell>
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
                  // Round-4 fix R4-doc — clarify combined-mode detection
                  // intent: `receiptDocumentNumberRaw === null` is the
                  // single source of truth for "this paid invoice uses
                  // the same legal document as both invoice + receipt"
                  // (Thai RD §86/4 + §105ทวิ). It is NOT inferred from
                  // `tenant_invoice_settings.receipt_numbering_mode`
                  // because that flag describes the tenant's CURRENT
                  // mode — an invoice paid before a mode-flip keeps its
                  // own immutable snapshot here. Use the row, not the
                  // tenant setting.
                  const isCombinedPaid =
                    r.hasReceiptPdf && r.status === 'paid' && !r.receiptDocumentNumberRaw;
                  const showInvoice = r.hasPdf && !isCombinedPaid;
                  if (!showInvoice && !r.hasReceiptPdf) {
                    return <span className="text-sm text-muted-foreground">—</span>;
                  }
                  return (
                    <div className="flex items-center justify-end gap-1">
                      {showInvoice && (
                        // Round-3 follow-up — invoice download now also
                        // a button (parity with Receipt). Plain `<a>`
                        // would leak 401/403/404/5xx as JSON-in-new-tab.
                        // Round-4 fix R4-UX-NB2 — aria-label via t()
                        // interpolation instead of string-concat so the
                        // dash separator is locale-controlled and SR
                        // text reads naturally in TH/SV not "Invoice —
                        // INV-2026-0001" literal English.
                        <button
                          type="button"
                          onClick={() =>
                            handleRowDownloadInvoice(
                              r.invoiceId,
                              `${r.documentNumber ?? r.invoiceId}.pdf`,
                            )
                          }
                          disabled={downloadingKeys.has(`invoice:${r.invoiceId}`)}
                          aria-label={t('actions.downloadInvoiceAria', {
                            number: r.documentNumber ?? r.invoiceId,
                          })}
                          className={cn(
                            buttonVariants({ variant: 'ghost', size: 'sm' }),
                            'min-h-11 px-3 gap-1',
                          )}
                          data-testid="row-download-invoice"
                        >
                          {downloadingKeys.has(`invoice:${r.invoiceId}`) && (
                            // Round-4 fix R4-UX-M1 — size-4 parity with
                            // the InvoiceMoreMenu spinner; was size-3
                            // which read as visually inconsistent.
                            <Loader2
                              className="size-4 motion-safe:animate-spin"
                              aria-hidden="true"
                            />
                          )}
                          {t('actions.download')}
                        </button>
                      )}
                      {r.hasReceiptPdf && (
                        // Round-3 fix R3-BUG1 — converted plain
                        // `<a download>` to a button that uses the
                        // shared fetch+blob helper. Plain anchor
                        // would leak `{ "error": { "code": ... } }`
                        // JSON into a new tab on 425 Too Early / 502
                        // failed-render / 401 expired-session, etc.
                        <button
                          type="button"
                          onClick={() =>
                            handleRowDownloadReceipt(
                              r.invoiceId,
                              `${r.receiptDocumentNumberRaw ?? r.documentNumber ?? r.invoiceId}-receipt.pdf`,
                            )
                          }
                          disabled={downloadingKeys.has(`receipt:${r.invoiceId}`)}
                          aria-label={t('actions.downloadReceiptAria', {
                            number:
                              r.receiptDocumentNumberRaw ??
                              r.documentNumber ??
                              r.invoiceId,
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
