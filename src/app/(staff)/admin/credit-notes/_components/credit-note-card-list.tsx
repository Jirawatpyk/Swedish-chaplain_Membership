/**
 * Mobile card list for /admin/credit-notes (< md). The page dual-renders: the
 * `<table>` inside `hidden md:block`, this list with `className="md:hidden"`
 * — the seven-column table otherwise scrolls sideways on a phone.
 *
 * Server Component taking `t` as a prop (bound to `admin.creditNotes.list`),
 * so it reuses the table's column + action keys and cells verbatim: the same
 * `formatTaxDocDate`, `formatSatang`, `CreditNoteOriginalReceipt` (touch size)
 * and `CreditNoteRefundBadge`.
 *
 *   ┌───────────────────────────────────────────┐
 *   │ CN-2026-000014  [Refund]                   │  h2 link · refund badge
 *   │ Issued 23 Sept 2026                        │
 *   │ Original tax invoice RC-2026-000038        │  + "Bill SC-…" link (44px)
 *   │ Credit Refs Co                             │
 *   │ difference credited                        │  full reason (no clamp)
 *   │ ─────────────────────────────────────────  │
 *   │ 10,700.00 THB                              │
 *   │ [ View ] [ PDF ]                           │  ≥44px, flex-wrap
 *   └───────────────────────────────────────────┘
 *
 * a11y: `<ul role="list">` of `<li>`; each card is titled by a real `<h2>`
 * (a ≥44px link) under the page `<h1>`, so the list item needs no separate
 * name. Member and reason keep their column names as `<dt>`s (sr-only) now
 * that the table headers are gone. The reason is shown in full — a `title`
 * tooltip is unreachable on touch. The actions keep the table's per-note
 * aria-labels and wrap.
 *
 * Width: the list sits inside the page's padded outer Card, so each item is a
 * plain bordered box (not a nested Card with its own ring + padding) to leave
 * room at 320px.
 */
import Link from 'next/link';
import { DownloadIcon, EyeIcon } from 'lucide-react';
import type { ListCreditNotesRow } from '@/modules/invoicing';
import { buttonVariants } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import {
  CreditNoteOriginalReceipt,
  CreditNoteRefundBadge,
} from '@/components/invoices/credit-note-original-receipt';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
import { cn } from '@/lib/utils';
import { formatSatang } from '../_utils/format-satang';

export interface CreditNoteCardListProps {
  readonly rows: readonly ListCreditNotesRow[];
  readonly locale: string;
  /** `t` bound to `admin.creditNotes.list`. */
  readonly t: (key: string, values?: Record<string, string | number>) => string;
  /** Forwarded to the root `<ul>` — the page passes `md:hidden`. */
  readonly className?: string;
}

export function CreditNoteCardList({
  rows,
  locale,
  t,
  className,
}: CreditNoteCardListProps): React.ReactElement {
  return (
    <ul role="list" className={cn('flex flex-col gap-3', className)}>
      {rows.map((r) => (
        <li key={r.creditNoteId} className="flex flex-col gap-3 rounded-lg border p-3">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-sm font-medium leading-snug">
              <Link
                href={`/admin/credit-notes/${r.creditNoteId}`}
                className="inline-flex min-h-11 items-center rounded-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
              >
                {r.documentNumberRaw}
              </Link>
            </h2>
            {r.isRefund ? <CreditNoteRefundBadge /> : null}
          </div>

          <p className="text-sm text-muted-foreground">
            {t('columns.issueDate')}{' '}
            <span className="tabular-nums text-foreground">
              {formatTaxDocDate(r.issueDate, locale)}
            </span>
          </p>

          <div className="flex flex-col gap-0.5 text-sm">
            <span className="text-muted-foreground">{t('columns.originalReceipt')}</span>
            <CreditNoteOriginalReceipt
              original={r.original}
              invoiceHref={`/admin/invoices/${r.originalInvoiceId}`}
              size="touch"
            />
          </div>

          <dl className="flex flex-col gap-0.5 text-sm">
            <dt className="sr-only">{t('columns.member')}</dt>
            <dd className="break-words font-medium">{r.memberLegalName}</dd>
            <dt className="sr-only">{t('columns.reason')}</dt>
            <dd className="break-words text-muted-foreground">{r.reason}</dd>
          </dl>

          <Separator />

          <p className="text-base font-semibold tabular-nums">
            {formatSatang(r.totalSatang)}{' '}
            <span className="font-normal text-muted-foreground">THB</span>
          </p>

          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/admin/credit-notes/${r.creditNoteId}`}
              className={cn(buttonVariants({ variant: 'secondary', size: 'sm' }), 'min-h-11 px-3')}
              aria-label={t('actions.viewAria', { number: r.documentNumberRaw })}
            >
              <EyeIcon className="size-4" aria-hidden="true" />
              {t('actions.view')}
            </Link>
            <a
              href={`/api/credit-notes/${r.creditNoteId}/pdf`}
              target="_blank"
              rel="noopener noreferrer"
              download
              className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-11 px-3')}
              aria-label={t('actions.pdfAria', { number: r.documentNumberRaw })}
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              {t('actions.pdf')}
            </a>
          </div>
        </li>
      ))}
    </ul>
  );
}
