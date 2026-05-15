'use client';

/**
 * Shared failure-panel primitive used by both the card-payment and
 * PromptPay branches of the PaySheet drawer.
 *
 * F5R1-UX12 — visual styling stays `tone="destructive"` for affordance,
 * but the live-region role/aria-live attributes are intentionally
 * OMITTED here. The parent `<pay-sheet-internal>` already mounts a
 * persistent `<div aria-live="polite" role="status" class="sr-only">`
 * announcer (line 793) whose announcement string is derived from
 * `payState.kind` — when state transitions to `failure`, the
 * announcer fires. Mounting a SECOND `role="alert" + assertive`
 * region here would announce the same failure twice on NVDA/VoiceOver
 * (the parent says it via the live region; the alert role re-fires
 * via the inserted-node-with-alert-role semantic).
 *
 * The CTA copy varies between rails (Card uses `retry.cta`, PromptPay
 * uses `promptpay.refresh`) so the label is passed in.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';

export interface PaymentFailurePanelProps {
  /** Localized reason interpolated into `portal.payment.retry.body`. */
  readonly reason: string;
  /** Localized retry-CTA label (rail-specific copy). */
  readonly ctaLabel: string;
  readonly onRetry: () => void;
  /** `data-testid` for the alert region (rail-specific). */
  readonly testId: string;
  /** `data-testid` for the retry CTA (rail-specific). */
  readonly ctaTestId: string;
}

export function PaymentFailurePanel({
  reason,
  ctaLabel,
  onRetry,
  testId,
  ctaTestId,
}: PaymentFailurePanelProps) {
  const t = useTranslations('portal.payment.retry');
  return (
    <InlineAlert
      tone="destructive"
      data-testid={testId}
      className="space-y-4"
    >
      <InlineAlertTitle>{t('title')}</InlineAlertTitle>
      <InlineAlertDescription>{t('body', { reason })}</InlineAlertDescription>
      <Button
        type="button"
        variant="default"
        onClick={onRetry}
        // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile.
        className="min-h-[44px] w-full"
        data-testid={ctaTestId}
      >
        {ctaLabel}
      </Button>
    </InlineAlert>
  );
}
