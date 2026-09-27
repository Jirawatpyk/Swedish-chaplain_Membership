import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { ArrowRight } from 'lucide-react';
import { Alert, buttonClass } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';

/**
 * Spec 122 US3 (`Main` board) — the unpaid membership invoice, first thing on
 * the home page: "Your membership invoice is ready", its number, amount and
 * due date, and Pay now straight into the invoice's pay sheet (`?pay=1`).
 *
 * The board says "renewal"; this names it a membership invoice because a
 * first-year joining invoice takes the same path (decision 2 of 27 Sep: the
 * board's wording, except where it would say something untrue). With no
 * online payment it links to the invoice and does not promise one.
 */
export function MembershipInvoiceAlert({
  invoiceId,
  documentNumber,
  amount,
  dueDate,
  overdue,
  online,
}: {
  readonly invoiceId: string;
  readonly documentNumber: string | null;
  /** Already formatted ("38,520.00 THB"). */
  readonly amount: string;
  /** Already formatted, or null when the invoice has none. */
  readonly dueDate: string | null;
  readonly overdue: boolean;
  readonly online: 'both' | 'card' | 'promptpay' | null;
}) {
  const t = useTranslations('portal.dashboard.invoiceAlert');
  const body = t('body', {
    number: documentNumber ?? '',
    hasNumber: documentNumber ? 'yes' : 'no',
    amount,
    due: dueDate === null ? 'none' : overdue ? 'overdue' : 'upcoming',
    date: dueDate ?? '',
    online: online ?? 'none',
  });
  const href = online ? `/portal/invoices/${invoiceId}?pay=1` : `/portal/invoices/${invoiceId}`;

  return (
    <Alert tone={overdue ? 'warning' : 'info'} title={t('title')}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <span>{body}</span>
        <Link
          href={href}
          className={cn(
            buttonClass({ variant: online ? 'primary' : 'secondary' }),
            'shrink-0 no-underline max-sm:w-full max-sm:justify-center',
          )}
        >
          {online ? t('payNow') : t('viewInvoice')}
          <ArrowRight aria-hidden className="aura-icon size-4" />
        </Link>
      </div>
    </Alert>
  );
}
