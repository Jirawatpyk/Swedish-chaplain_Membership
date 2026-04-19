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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

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
  return <Badge variant={statusVariant(status)}>{t(status)}</Badge>;
}

function formatSatang(satang: string): string {
  const n = BigInt(satang);
  const abs = n < 0n ? -n : n;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = n < 0n ? '-' : '';
  return `${sign}${whole.toLocaleString()}.${rem.toString().padStart(2, '0')}`;
}

const headCls = 'text-xs uppercase tracking-wide text-muted-foreground';

export function InvoicesTable({ rows }: { rows: readonly InvoicesTableRow[] }) {
  const t = useTranslations('admin.invoices.list');
  return (
    <div className="overflow-x-auto">
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
                <StatusBadge status={r.status} />
              </TableCell>
              <TableCell className="align-middle">{r.issueDate ?? '—'}</TableCell>
              <TableCell className="align-middle">{r.dueDate ?? '—'}</TableCell>
              <TableCell className="align-middle text-right tabular-nums">
                {formatSatang(r.totalSatang)} THB
              </TableCell>
              <TableCell className="align-middle text-right">
                {r.hasPdf ? (
                  // Plain <a> — PDF endpoint returns binary bytes;
                  // Next.js <Link> would misinterpret the response as
                  // an RSC payload and fail the fetch.
                  <a
                    href={`/api/invoices/${r.invoiceId}/pdf`}
                    className="text-sm text-primary hover:underline"
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
