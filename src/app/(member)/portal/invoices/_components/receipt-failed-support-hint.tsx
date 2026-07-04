/**
 * 088 T066a (FR-019) — graceful permanent-fail member affordance (compact).
 *
 * Shown on the portal invoice LIST row + mobile CARD when a paid invoice's
 * §86/4 RC receipt-PDF render has TERMINALLY failed (`receiptPdfStatus ===
 * 'failed'`). It replaces the former dead "Receipt unavailable" copy with a
 * CALM support-path message: the payment is recorded and the receipt number is
 * reserved — the team has been notified and will resolve it (the reconcile cron
 * re-renders the SAME pre-allocated RC). The member can still grab the
 * issue-time invoice PDF meanwhile.
 *
 * Pure presentational (no hooks) so BOTH the server list page (`getTranslations`)
 * and the server card list (receives a bound `t` prop) render the IDENTICAL
 * markup from one source — the table + card can never drift. Terminal state, so
 * NO `role="status"` / `aria-busy` / spinner (that is the in-progress
 * `<ReceiptStatusWatcher>`; a permanent failure must never be mislabelled as
 * forever-generating — portal S1 parity).
 */
import { InfoIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ReceiptFailedSupportHint({
  label,
  className,
}: {
  /** Localised support-path copy — pass `t('actions.receiptFailedSupport')`. */
  readonly label: string;
  readonly className?: string;
}): React.ReactElement {
  return (
    <span
      data-testid="receipt-failed-support"
      className={cn(
        'inline-flex min-h-11 items-center gap-1 text-sm text-muted-foreground',
        className,
      )}
    >
      <InfoIcon className="size-4 shrink-0" aria-hidden="true" />
      {label}
    </span>
  );
}
