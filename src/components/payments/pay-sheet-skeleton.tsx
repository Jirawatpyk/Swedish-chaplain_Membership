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
 *   - `data-testid="pay-sheet-card-skeleton"` (default) or
 *     `pay-sheet-promptpay-skeleton` (when `variant="promptpay"`) is
 *     mandated by E2E T046 (§ 2.2 rule 7). R7 fix: both tabs pre-render
 *     simultaneously, so a single testid produced strict-mode locator
 *     violations in Playwright. Parameterising lets each tab's
 *     skeleton be addressed independently.
 */
import { useTranslations } from 'next-intl';

import { Skeleton } from '@/components/ui/skeleton';

export interface PaySheetSkeletonProps {
  /**
   * Which payment-method tab this skeleton sits under. Drives the
   * `data-testid` so card vs promptpay skeletons are independently
   * locatable from E2E specs even though both tabs pre-render. */
  readonly variant?: 'card' | 'promptpay';
}

export function PaySheetSkeleton({
  variant = 'card',
}: PaySheetSkeletonProps = {}) {
  const t = useTranslations('portal.payment.skeleton');
  const testIdRoot = `pay-sheet-${variant}-skeleton`;
  return (
    <div
      role="status"
      aria-busy="true"
      aria-live="polite"
      aria-label={t('loading')}
      data-testid={testIdRoot}
      className="space-y-4"
    >
      {/* Visible loading hint — reassures the member that the
          drawer is actively preparing the form (can take 1-3 s on
          first open). The shimmer rows alone are mute; a short label
          reduces perceived wait time. */}
      <p
        className="text-caption text-muted-foreground"
        data-testid={`${testIdRoot}-label`}
      >
        {t('loading')}
      </p>
      {variant === 'promptpay' ? (
        <>
          {/* H-12 (review 2026-04-27): skeleton shape mirrors the
              real PromptPay panel layout — 220×220 QR square + two
              instruction text rows + countdown + warning + refresh
              button. Previous shape (4 rows like card) caused a CLS
              spike when the placeholder swapped for the actual QR
              panel, breaking § 2.2 rule 2 (CLS-0 contract). */}
          <div className="flex flex-col items-center gap-3">
            <Skeleton className="aspect-square w-[220px]" />
            <Skeleton className="h-5 w-3/4" />
            <Skeleton className="h-4 w-1/2" />
          </div>
          {/* Countdown row */}
          <Skeleton className="mx-auto h-4 w-24" />
          {/* Warning microcopy */}
          <Skeleton className="h-12 w-full" />
          {/* Refresh button */}
          <Skeleton className="h-11 w-full" />
        </>
      ) : (
        <>
          {/* Card number row */}
          <Skeleton className="h-12 w-full" />
          {/* Expiry + CVC (half-width pair) */}
          <Skeleton className="h-12 w-full" />
          {/* Zip / country row */}
          <Skeleton className="h-12 w-full" />
          {/* Submit button */}
          <Skeleton className="h-10 w-full" />
        </>
      )}
    </div>
  );
}

export default PaySheetSkeleton;
