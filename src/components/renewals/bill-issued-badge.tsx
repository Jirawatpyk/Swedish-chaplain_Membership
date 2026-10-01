/**
 * 0309 — `BillIssuedBadge`: marks a pipeline row whose renewal bill was
 * issued BEFORE T-0 (member confirm, 107 auto-drafted issue, orphan relink).
 *
 * Such a cycle is `awaiting_payment` but keeps its countdown urgency: the
 * current period is already paid, so benefit access stays full until it ends
 * (`deriveMembershipAccess`). Without a marker the row is indistinguishable
 * from an un-billed `upcoming` one. The badge shows only when the urgency is
 * still a countdown and a bill is actually linked (a voided bill, or a confirm
 * whose issue failed, leaves none). Past the deadline (a born-awaiting cycle, or an early bill
 * whose period ended unpaid) the `suspended` pill already says what staff need.
 *
 * Neutral tokens, not an urgency hue: this is a billing fact, not a warning.
 * The visible text carries the meaning (WCAG 1.4.1); the `sr-only` span gives
 * screen-reader users the same reason sighted users get from `title`.
 */
import { useTranslations } from 'next-intl';
import { Badge } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';
import type { CycleStatus, UrgencyBucket } from '@/modules/renewals/client';
import { isPastDeadlineUrgency } from './urgency';

export interface BillIssuedBadgeProps {
  readonly status: CycleStatus;
  readonly urgency: UrgencyBucket;
  /** The linked renewal bill. None (voided, or the issue failed) → no badge. */
  readonly linkedInvoiceId: string | null;
  readonly className?: string;
}

export function BillIssuedBadge({
  status,
  urgency,
  linkedInvoiceId,
  className,
}: BillIssuedBadgeProps) {
  const t = useTranslations('admin.renewals.table');
  if (
    status !== 'awaiting_payment' ||
    linkedInvoiceId === null ||
    isPastDeadlineUrgency(urgency)
  ) {
    return null;
  }
  // 122 US7a: a neutral outline badge — quieter than the urgency pill beside it.
  return (
    <Badge
      tone="neutral"
      variant="outline"
      className={cn('whitespace-nowrap', className)}
      title={t('billIssuedTitle')}
    >
      {t('billIssuedLabel')}
      <span className="sr-only"> — {t('billIssuedTitle')}</span>
    </Badge>
  );
}
