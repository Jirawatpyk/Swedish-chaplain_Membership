'use client';

/**
 * <ProcessingPanel> — "Processing payment…" state shown when the Stripe
 * PaymentIntent returns `status === 'processing'` after confirm. Rare
 * for card (usually either `succeeded` or `requires_action`) but possible
 * when Stripe is still awaiting bank settlement.
 *
 * Contract (specs/009-online-payment FR-028d):
 *   - `role="status"` + `aria-live="polite"` so SR announces state.
 *   - Shimmer reuses <Skeleton> primitive — motion-safe shimmer,
 *     motion-reduce static (fallback handled inside the primitive).
 *   - Tertiary cancel button invokes onCancel prop. Parent owns the
 *     POST /api/payments/[id]/cancel call + drawer teardown.
 *
 * Purely presentational — no state, no side-effects.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export interface ProcessingPanelProps {
  readonly onCancel: () => void;
}

export function ProcessingPanel({ onCancel }: ProcessingPanelProps) {
  const t = useTranslations('portal.payment.processing');
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="pay-sheet-processing-panel"
      className="space-y-4"
    >
      <h3 className="text-body font-medium text-foreground">{t('title')}</h3>
      <p className="text-caption text-muted-foreground">{t('body')}</p>
      {/* Visual progress shimmer — not interactive. */}
      <Skeleton className="h-2 w-full" />
      <Button
        type="button"
        variant="ghost"
        onClick={onCancel}
        // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile (G-Review #7).
        className="min-h-[44px] w-full"
        data-testid="pay-sheet-processing-cancel"
      >
        {t('cancel')}
      </Button>
    </div>
  );
}

export default ProcessingPanel;
