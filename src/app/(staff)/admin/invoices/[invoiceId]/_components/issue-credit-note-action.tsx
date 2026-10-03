/**
 * "Issue credit note…" action on the invoice detail page.
 *
 * While a refund on the invoice's payment is still settling, the server
 * refuses a manual credit note (`refund_in_progress`, the 8A pending-refund
 * guard — a manual CN now would strand the refund's own §86/10). So the action
 * renders DISABLED with the reason as its accessible description, instead of
 * leading the admin into a guaranteed refusal. Mirrors the Issue-refund
 * trigger's own "settling" gate (Gap E).
 */
import Link from 'next/link';
import { useTranslations } from 'next-intl';
// A server file (no 'use client'): AURA's `/server` entry has `buttonClass`
// but no `Button`, so the disabled state is a native button in AURA's class.
import { buttonClass } from '@jirawatpyk/aura-react/server';

export function IssueCreditNoteAction({
  invoiceId,
  refundSettling,
}: {
  readonly invoiceId: string;
  /** A `pending` refund exists on this invoice's payment(s). */
  readonly refundSettling: boolean;
}) {
  const t = useTranslations('admin.invoices.detail.actions');
  if (refundSettling) {
    return (
      // The reason stays the button's description but is not drawn: the page's
      // settling note says it once (board Admin-refund-settling), and drawn
      // here it squeezed the h1 and broke the phone bar's row.
      <span className="inline-flex flex-col items-start gap-1 max-sm:items-stretch">
        <button
          type="button"
          className={buttonClass({ variant: 'secondary', touchHeight: true })}
          disabled
          aria-describedby="issue-credit-note-settling-hint"
        >
          {t('issueCreditNote')}
        </button>
        <span
          id="issue-credit-note-settling-hint"
          className="sr-only"
        >
          {t('issueCreditNoteRefundSettling')}
        </span>
      </span>
    );
  }
  return (
    <Link
      href={`/admin/invoices/${invoiceId}/credit-notes/new`}
      className={buttonClass({ variant: 'secondary', touchHeight: true })}
    >
      {t('issueCreditNote')}
    </Link>
  );
}
