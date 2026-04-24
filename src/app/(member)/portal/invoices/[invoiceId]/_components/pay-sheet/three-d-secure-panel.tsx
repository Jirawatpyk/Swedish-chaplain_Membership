'use client';

/**
 * <ThreeDSecurePanel> — in-drawer placeholder rendered while the Stripe
 * PaymentIntent is in `requires_action` state and the issuing bank's
 * 3DS challenge iframe is being presented to the user.
 *
 * Contract (specs/009-online-payment FR-028d):
 *   - Bilingual title + explanatory body from
 *     `portal.payment.threeDSecure.*`.
 *   - Tertiary "Cancel payment" button (parent owns
 *     POST /api/payments/[id]/cancel + drawer teardown).
 *   - Shimmer reuses <Skeleton> primitive — motion-safe shimmer,
 *     motion-reduce pulse handled inside the primitive's CSS.
 *
 * Polling contract (owned by the parent <PaySheetInternal>)
 * ---------------------------------------------------------
 * This panel is STATE ONLY. It does not poll. The parent runs a narrow
 * `stripe.retrievePaymentIntent(clientSecret)` poll every 2 s for up to
 * 5 min; on `succeeded` it swaps to <ConfirmationPanel>, on
 * `canceled`/`requires_payment_method` it swaps to the retry panel.
 * G4 will wire the actual poll — G3 leaves the contract in the JSDoc
 * so the API surface is locked.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export interface ThreeDSecurePanelProps {
  readonly onCancel: () => void;
}

export function ThreeDSecurePanel({ onCancel }: ThreeDSecurePanelProps) {
  const t = useTranslations('portal.payment.threeDSecure');
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pay-sheet-3ds-panel"
      className="space-y-4"
    >
      <h3 className="text-body font-medium text-foreground">{t('title')}</h3>
      <p className="text-caption text-muted-foreground">{t('body')}</p>
      <Skeleton className="h-2 w-full" />
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile (G-Review #7).
        className="min-h-[44px] w-full"
        data-testid="pay-sheet-3ds-cancel"
      >
        {t('cancel')}
      </Button>
    </div>
  );
}

export default ThreeDSecurePanel;
