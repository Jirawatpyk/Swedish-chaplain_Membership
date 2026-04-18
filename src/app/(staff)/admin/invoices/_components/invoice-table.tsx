/**
 * T057 — Invoices admin table (F4).
 *
 * Keeps the first ship simple — plain table with status chip + quick
 * link. TanStack Table + sort/filter arrive in a later polish pass
 * once the list contains enough rows to warrant it (SweCham currently
 * has < 200 active invoices / year).
 */
'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export type InvoicesTableRow = {
  readonly invoiceId: string;
  readonly documentNumber: string;
  readonly status: string;
  readonly memberId: string;
  readonly issueDate: string | null;
  readonly dueDate: string | null;
  readonly totalSatang: string;
};

function StatusChip({ status }: { status: string }) {
  const cls =
    status === 'paid'
      ? 'bg-emerald-100 text-emerald-900'
      : status === 'void' || status === 'credited'
        ? 'bg-slate-200 text-slate-700'
        : status === 'partially_credited'
          ? 'bg-amber-100 text-amber-900'
          : status === 'issued'
            ? 'bg-sky-100 text-sky-900'
            : 'bg-zinc-100 text-zinc-700';
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${cls}`}>
      {status}
    </span>
  );
}

function formatSatang(satang: string): string {
  const n = BigInt(satang);
  const whole = n / 100n;
  const rem = n % 100n;
  return `${whole.toLocaleString()}.${rem.toString().padStart(2, '0')}`;
}

export function InvoicesTable({ rows }: { rows: readonly InvoicesTableRow[] }) {
  const t = useTranslations('admin.invoices.list');
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-muted/40">
          <tr>
            <th className="p-3 text-left font-medium">{t('columns.documentNumber')}</th>
            <th className="p-3 text-left font-medium">{t('columns.status')}</th>
            <th className="p-3 text-left font-medium">{t('columns.issueDate')}</th>
            <th className="p-3 text-left font-medium">{t('columns.dueDate')}</th>
            <th className="p-3 text-right font-medium">{t('columns.total')}</th>
            <th className="p-3 text-right font-medium">{t('columns.actions')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.invoiceId} className="border-t">
              <td className="p-3">
                <Link className="font-medium underline-offset-2 hover:underline" href={`/admin/invoices/${r.invoiceId}`}>
                  {r.documentNumber}
                </Link>
              </td>
              <td className="p-3">
                <StatusChip status={r.status} />
              </td>
              <td className="p-3">{r.issueDate ?? '—'}</td>
              <td className="p-3">{r.dueDate ?? '—'}</td>
              <td className="p-3 text-right tabular-nums">{formatSatang(r.totalSatang)} THB</td>
              <td className="p-3 text-right">
                <Link
                  className="text-sm text-primary hover:underline"
                  href={`/api/invoices/${r.invoiceId}/pdf`}
                >
                  {t('actions.download')}
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
