/**
 * The "Original tax invoice" cell shared by the admin credit-note list, the
 * admin credit-note detail and the portal credit-note detail.
 *
 * A §86/10 credit note references the original §86/4 tax invoice
 * (ใบกำกับภาษีเดิม), so that is the number shown first — the payment-time RC
 * tax receipt (or a legacy INV), the same number the credit-note PDF cites.
 * The second line names the document behind it (the 088 SC bill, a legacy
 * separate-mode receipt, or "combined") and links to the invoice page in-app.
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowUpRightIcon } from 'lucide-react';
import type { CreditNoteOriginalDocuments } from '@/modules/invoicing';
import { Badge } from '@/components/ui/badge';

export function CreditNoteOriginalReceipt({
  original,
  invoiceHref,
  size = 'compact',
}: {
  readonly original: CreditNoteOriginalDocuments;
  /** In-app invoice page for the second line (admin or portal). */
  readonly invoiceHref: string;
  /**
   * `touch` — the member portal, where this link is the way to the invoice:
   * readable size and a 44px target (ux-standards.md tap-target rule).
   */
  readonly size?: 'compact' | 'touch';
}) {
  const t = useTranslations('shared.creditNoteOriginal');
  if (original.receiptNumberRaw === null) {
    return <span className="text-muted-foreground">—</span>;
  }
  const related = original.related;
  const relatedLabel =
    related === null
      ? null
      : related.kind === 'bill'
        ? t('bill', { number: related.numberRaw })
        : related.kind === 'receipt'
          ? t('receipt', { number: related.numberRaw })
          : t('combined');
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono">{original.receiptNumberRaw}</span>
      {relatedLabel !== null ? (
        <Link
          href={invoiceHref}
          className={
            size === 'touch'
              ? 'inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground underline-offset-2 hover:underline'
              : 'inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:underline'
          }
        >
          {relatedLabel}
          {/* Visible text stays first (WCAG 2.5.3); the receipt number makes
              each link unique in a screen reader's links list. */}
          <span className="sr-only"> — {original.receiptNumberRaw}</span>
          <ArrowUpRightIcon className="size-3.5" aria-hidden="true" />
        </Link>
      ) : null}
    </span>
  );
}

/** Marks a credit note the F5 refund flow issued (`source_refund_id` set). */
export function CreditNoteRefundBadge() {
  const t = useTranslations('shared.creditNoteOriginal');
  return (
    // `font-sans` — the list renders this inside the mono Number cell.
    <Badge variant="outline" className="font-sans">
      {t('refund')}
      <span className="sr-only"> — {t('refundHint')}</span>
    </Badge>
  );
}
