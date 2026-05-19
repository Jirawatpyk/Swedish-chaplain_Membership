'use client';

/**
 * Shared failure-panel primitive used by both the card-payment and
 * PromptPay branches of the PaySheet drawer.
 *
 * F5R1-UX12 + F5R2-CRIT-3 — visual styling stays `tone="destructive"`
 * for affordance. Live-region semantics are managed by the parent
 * `<pay-sheet-internal>` which mounts a persistent polite announcer
 * `<div aria-live="polite" role="status" class="sr-only">` (locate by
 * `data-testid="pay-sheet-aria-announcer"`) whose announcement string
 * is derived from `payState.kind` — when state transitions to
 * `failure`, the announcer fires.
 *
 * F5R2-CRIT-3 was a half-landed UX12: UX12 removed `role="alert"` +
 * `aria-live="assertive"` from THIS file's wrapper, but the
 * `<InlineAlert>` primitive defaults `role="alert"` (assertive) on
 * its rendered DOM. The result on `card-form → failure` was the same
 * double-announce UX12 had aimed to fix — assertive panel insertion
 * + polite announcer fire. The fix is to pass `role="status"` to
 * InlineAlert below, overriding its primitive default. AT now hears
 * exactly one announcement, via the parent's polite channel.
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
      // F5R2-CRIT-3 / WCAG 4.1.3 — InlineAlert defaults to role="alert"
      // (assertive). The parent <pay-sheet-internal> already mounts a
      // persistent polite live region (data-testid="pay-sheet-aria-
      // announcer") that announces the failure transition. Keeping
      // role="alert" here would cause a double-announce on every card
      // failure (assertive panel + polite announcer). Override to
      // role="status" so AT relies on the parent announcer alone.
      role="status"
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
