/**
 * PaySheetSkeleton — shimmer placeholder for Stripe's <PaymentElement>
 * inside the PaySheet drawer.
 *
 * Contract: specs/009-online-payment/ux-phase3-contract.md § 2 (C-A).
 *   - Uses the shared <Skeleton> primitive (`.skeleton-shimmer` CSS already
 *     handles the `prefers-reduced-motion` fallback — do NOT layer Tailwind
 *     motion utilities on top, per § 2.2 rule 1).
 *   - Shape fidelity (CLS=0): 3 rectangular rows matching PaymentElement
 *     layout (card number / expiry+CVC / zip) + 1 button rect ~40px
 *     (§ 2.2 rule 2).
 *   - ARIA-busy contract: `role="status"` + `aria-busy="true"` +
 *     `aria-live="polite"` on the root container so SR users hear that
 *     the payment form is loading (§ 2.2 rule 6).
 *   - `data-testid="pay-sheet-card-skeleton"` is mandated by E2E T046
 *     (§ 2.2 rule 7).
 */
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/ui/skeleton';

export function PaySheetSkeleton() {
  const t = useTranslations('portal.payment.skeleton');
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={t('loading')}
      data-testid="pay-sheet-card-skeleton"
      className="space-y-4"
    >
      {/* Card number row */}
      <Skeleton className="h-12 w-full" />
      {/* Expiry + CVC (half-width pair) */}
      <Skeleton className="h-12 w-full" />
      {/* Zip / country row */}
      <Skeleton className="h-12 w-full" />
      {/* Submit button */}
      <Skeleton className="h-10 w-full" />
    </div>
  );
}

export default PaySheetSkeleton;
