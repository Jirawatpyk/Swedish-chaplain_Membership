'use client';

/**
 * Shared failure-panel primitive used by both the card-payment and
 * PromptPay branches of the PaySheet drawer. Centralises the WCAG /
 * AT contract (`role="alert"` + `aria-live="assertive"` +
 * `aria-atomic`) so both rails announce identically and any future
 * a11y change lands in one place.
 *
 * The CTA copy varies between rails (Card uses `retry.cta`,
 * PromptPay uses `promptpay.refresh`) so the label is passed in,
 * not hard-coded.
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
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
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
