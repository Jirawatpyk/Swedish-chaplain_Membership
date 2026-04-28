/**
 * T057 — Invoices admin table (F4).
 *
 * Visual parity with members-table: shadcn `Table` primitive + `Badge`
 * variants, cell `align-middle`, row hover `bg-accent/40`, header
 * `text-xs uppercase tracking-wide text-muted-foreground`. Kept plain
 * (no TanStack/selection) for MVP — SweCham has < 200 active invoices
 * per year; sort/selection arrive in a later polish pass.
 *
 * Columns: Number · Member · Status · Issued · Due · Total · Actions.
 * Download link is suppressed on drafts (no PDF yet) to avoid 404s.
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
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
import { cn } from '@/lib/utils';

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
            <TableHead scope="col" className={headCls}>
              {t('columns.documentNumber')}
            </TableHead>
            <TableHead scope="col" className={headCls}>
              {t('columns.member')}
            </TableHead>
            <TableHead scope="col" className={headCls}>
              {t('columns.status')}
            </TableHead>
            {showMethodColumn && (
              <TableHead
                scope="col"
                className={headCls}
                data-testid="column-header-method"
              >
                {t('columns.method')}
              </TableHead>
            )}
            <TableHead scope="col" className={headCls}>
              {t('columns.issueDate')}
            </TableHead>
            <TableHead scope="col" className={headCls}>
              {t('columns.dueDate')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} text-right`}>
              {t('columns.total')}
            </TableHead>
            <TableHead scope="col" className={`${headCls} text-right`}>
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
              <TableCell className="align-middle">
                <Link
                  href={`/admin/invoices/${r.invoiceId}`}
                  className="cursor-pointer font-medium hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                >
                  {r.documentNumber}
                </Link>
              </TableCell>
              <TableCell className="align-middle">
                <Link
                  href={`/admin/members/${r.memberId}`}
                  className="hover:underline focus-visible:outline-2 focus-visible:outline-ring rounded-sm"
                >
                  {r.memberName}
                </Link>
              </TableCell>
              <TableCell className="align-middle">
                <div className="flex flex-wrap items-center gap-1.5">
                  <StatusBadge status={r.status} />
                  {r.creditNoteCount > 0 && (
                    // G-2 — CN indicator chip. Shows only when ≥1 CN
                    // exists on the row. Tooltip (title) + aria-label
                    // carry both the count AND the credited amount so
                    // admins can answer 'how much is still outstanding?'
                    // at a glance. Not clickable — the row itself links
                    // to the invoice detail which has the full CN section.
                    <Badge
                      variant="outline"
                      className="font-mono text-[10px] tabular-nums"
                      title={t('creditedTooltip', {
                        count: r.creditNoteCount,
                        amount: formatSatang(r.creditedTotalSatang),
                      })}
                      aria-label={t('creditedAria', {
                        count: r.creditNoteCount,
                        amount: formatSatang(r.creditedTotalSatang),
                      })}
                    >
                      {t('creditedSuffix', { count: r.creditNoteCount })}
                    </Badge>
                  )}
                </div>
              </TableCell>
              {showMethodColumn && (
                <TableCell className="align-middle">
                  {r.onlinePaymentMethod ? (
                    <MethodBadge method={r.onlinePaymentMethod} />
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
              )}
              <TableCell className="align-middle">{r.issueDate ?? '—'}</TableCell>
              <TableCell className="align-middle">{r.dueDate ?? '—'}</TableCell>
              <TableCell className="align-middle text-right tabular-nums">
                {formatSatang(r.totalSatang)} THB
              </TableCell>
              <TableCell className="align-middle text-right">
                {r.hasPdf ? (
                  // Plain <a> — PDF endpoint returns binary bytes;
                  // Next.js <Link> would misinterpret the response as
                  // an RSC payload and fail the fetch. Styled as a
                  // ghost button so the touch target meets WCAG 2.5.5
                  // (≥44×44 px) on mobile (L4).
                  <a
                    href={`/api/invoices/${r.invoiceId}/pdf`}
                    aria-label={`${t('actions.download')} — ${r.documentNumber ?? r.invoiceId}`}
                    className={cn(
                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                      'min-h-11 px-3',
                    )}
                    target="_blank"
                    rel="noopener noreferrer"
                    download
                  >
                    {t('actions.download')}
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">—</span>
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
