/**
 * Spec 122 US8c (T844) — the credit-notes list's table: one AURA `DataTable`
 * that stacks into cards below 640px, laid out as board `Admin-credit-notes`
 * draws it (spec Clarifications, Session 2026-10-03):
 *   Number (+ Refund) · Issued · Original tax invoice · Member · Reason ·
 *   Total · PDF
 *
 * The number opens the detail, so the separate View button is gone; the PDF
 * downloads from the same URL as before. On a phone each row is a card: the
 * number as its title, then the fields, with the download as its last row.
 */
'use client';

import { useMemo } from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { DataTable, buttonClass, type DataTableColumn } from '@jirawatpyk/aura-react';
import { DownloadIcon } from 'lucide-react';
import type { ListCreditNotesRow } from '@/modules/invoicing';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import {
  CreditNoteOriginalReceipt,
  CreditNoteRefundBadge,
} from '@/components/invoices/credit-note-original-receipt';
import { formatSatang } from '../_utils/format-satang';
import { CREDIT_NOTES_COLUMN_LAYOUT } from './credit-notes-table-columns';

export function CreditNotesTable({ rows }: { readonly rows: readonly ListCreditNotesRow[] }) {
  const t = useTranslations('admin.creditNotes.list');
  const locale = useLocale();

  const columns = useMemo<DataTableColumn<ListCreditNotesRow>[]>(
    () => [
      {
        key: 'documentNumber',
        label: t('columns.documentNumber'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.documentNumber,
        render: (r) => (
          <span className="inline-flex flex-wrap items-center gap-[var(--aura-space-2)]">
            <Link
              href={`/admin/credit-notes/${r.creditNoteId}`}
              className="rounded-sm font-mono text-xs font-medium text-[var(--aura-fg-accent)] underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-[var(--aura-focus-ring)]"
            >
              {r.documentNumberRaw}
            </Link>
            {r.isRefund ? <CreditNoteRefundBadge /> : null}
          </span>
        ),
      },
      {
        key: 'issueDate',
        label: t('columns.issueDate'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.issueDate,
        render: (r) => <span className="tabular-nums">{formatTaxDocDate(r.issueDate, locale)}</span>,
      },
      {
        key: 'originalReceipt',
        label: t('columns.originalReceipt'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.originalReceipt,
        render: (r) => (
          <span className="text-xs whitespace-normal break-words">
            <CreditNoteOriginalReceipt
              original={r.original}
              invoiceHref={`/admin/invoices/${r.originalInvoiceId}`}
            />
          </span>
        ),
      },
      {
        key: 'member',
        label: t('columns.member'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.member,
        // `whitespace-normal`: AURA's stacked-card cells are nowrap.
        render: (r) => (
          <span title={r.memberLegalName} className="line-clamp-2 max-w-[32ch] break-words whitespace-normal">
            {r.memberLegalName}
          </span>
        ),
      },
      {
        key: 'reason',
        label: t('columns.reason'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.reason,
        render: (r) => (
          <span title={r.reason} className="line-clamp-2 max-w-[36ch] break-words whitespace-normal">
            {r.reason}
          </span>
        ),
      },
      {
        key: 'total',
        label: t('columns.total'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.total,
        render: (r) => <span className="font-medium tabular-nums">{formatSatang(r.totalSatang)} THB</span>,
      },
      {
        key: 'pdf',
        label: t('columns.pdf'),
        ...CREDIT_NOTES_COLUMN_LAYOUT.pdf,
        render: (r) => (
          <a
            href={`/api/credit-notes/${r.creditNoteId}/pdf`}
            target="_blank"
            rel="noopener noreferrer"
            download
            aria-label={t('actions.pdfAria', { number: r.documentNumberRaw })}
            className={buttonClass({ variant: 'ghost', size: 'sm', touchHeight: true, className: 'max-sm:w-full' })}
          >
            <DownloadIcon aria-hidden="true" className="size-4" />
            {/* The phone card's footer is a whole row: say what it does. */}
            <span className="sm:hidden" aria-hidden="true">
              {t('actions.download')}
            </span>
          </a>
        ),
      },
    ],
    [t, locale],
  );

  return (
    <DataTable<ListCreditNotesRow>
      label={t('tableCaption')}
      rows={rows}
      columns={columns}
      rowKey="creditNoteId"
      rowHeight="auto"
      stackBelow={640}
      // Edge to edge inside the list card from 640px up (the list-card rule).
      bleed
    />
  );
}
