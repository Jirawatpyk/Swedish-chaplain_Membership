'use client';

/**
 * <ConfirmationPanel> — post-settlement success state (FR-028e).
 *
 * Responsibilities:
 *   - CheckCircle icon (motion-safe scale-in 200 ms; motion-reduce instant).
 *   - Bilingual title + per-method summary (card vs promptpay).
 *   - Primary CTA "Download receipt" → F4 receipt PDF via 60 s signed URL
 *     (passed in as `receiptUrl` prop; getter is a Group F / G4 concern).
 *   - Secondary "Close" button.
 *   - 5-second auto-close countdown using `autoCloseCountdown` key.
 *     Countdown interrupts the moment the user clicks either button.
 *   - Fires a `sonner.success` toast on mount using the success.toast key.
 *
 * PCI: zero persistence. `clientSecret` does not enter this component.
 */
import { startTransition, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2Icon, DownloadIcon } from 'lucide-react';

import { Button, buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const AUTO_CLOSE_SECONDS = 5;

export interface ConfirmationPanelProps {
  readonly method: 'card' | 'promptpay';
  /** Formatted amount (caller applies locale). e.g. "THB 12,000.00". */
  readonly amount: string;
  /** Last-4 digits when method === 'card'; ignored for promptpay. */
  readonly last4?: string;
  /** Localized datetime string (caller formats with `intl` per locale). */
  readonly dateTime: string;
  /** Short-lived signed URL to the F4 receipt PDF. */
  readonly receiptUrl: string;
  /** Fired on user-initiated close OR on countdown exhaustion. */
  readonly onClose: () => void;
  /**
   * Optional callback for when the user clicks "Download receipt" (in
   * addition to the <a> navigating to `receiptUrl`). Parent may use this
   * to emit a telemetry event. Does NOT auto-close the drawer — the user
   * must explicitly click "Close" (or let the 5-second auto-close fire).
   */
  readonly onDownload?: () => void;
}

export function ConfirmationPanel({
  method,
  amount,
  last4,
  dateTime,
  receiptUrl,
  onClose,
  onDownload,
}: ConfirmationPanelProps) {
  const t = useTranslations('portal.payment.success');

  const [remaining, setRemaining] = useState<number>(AUTO_CLOSE_SECONDS);
  const interruptedRef = useRef<boolean>(false);

  // One-shot toast on mount — guarded so StrictMode's double-invoke in
  // development doesn't produce two toasts.
  const toastedRef = useRef<boolean>(false);
  useEffect(() => {
    if (toastedRef.current) return;
    toastedRef.current = true;
    toast.success(t('toast'));
  }, [t]);

  // Auto-close countdown. Tick once per second; reaching 0 fires onClose
  // unless the user already interrupted it via a click.
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (interruptedRef.current) {
          clearInterval(timer);
          return prev;
        }
        if (prev <= 1) {
          clearInterval(timer);
          // Defer onClose out of the setter to avoid setting parent
          // state during our own render. `startTransition` keeps the
          // update inside React 19's scheduler (G-Review Finding #3 —
          // the previous `queueMicrotask` call escaped batching).
          startTransition(() => {
            if (!interruptedRef.current) {
              onClose();
            }
          });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [onClose]);

  const interruptAutoClose = () => {
    interruptedRef.current = true;
  };

  const summary =
    method === 'card'
      ? t('summaryCard', {
          amount,
          last4: last4 ?? '****',
          dateTime,
        })
      : t('summaryPromptPay', { amount, dateTime });

  return (
    <section
      data-testid="pay-sheet-confirmation-panel"
      className="flex flex-col items-center gap-4 text-center"
    >
      <CheckCircle2Icon
        aria-hidden="true"
        className="size-12 text-primary motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200"
        data-testid="pay-sheet-confirmation-icon"
      />
      <h3 className="text-h3 font-semibold text-foreground">{t('title')}</h3>
      <p className="text-body text-muted-foreground">{summary}</p>
      <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-center">
        <a
          href={receiptUrl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            buttonVariants({ variant: 'default' }),
            // WCAG 2.5.5 / SC 2.5.8 — mobile tap target ≥ 44×44 px
            // (G-Review Finding #5).
            'min-h-[44px] px-4',
          )}
          onClick={() => {
            interruptAutoClose();
            onDownload?.();
          }}
          data-testid="pay-sheet-download-receipt"
        >
          <DownloadIcon aria-hidden="true" className="size-4" />
          {t('downloadReceipt')}
        </a>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            interruptAutoClose();
            onClose();
          }}
          data-testid="pay-sheet-confirmation-close"
        >
          {t('close')}
        </Button>
      </div>
      {/*
       * Countdown — dual-node pattern (G-Review Finding #6).
       * ----------------------------------------------------
       * The visible <p> ticks every second but is `aria-hidden` so
       * screen readers don't flood. A sibling `aria-live="polite"`
       * node is throttled to announce only at the 3 / 2 / 1 s
       * thresholds (UX contract § 3.1: at most one SR update per
       * meaningful threshold). The visible-vs-announced split matches
       * the PromptPay countdown elsewhere in the payment flow.
       */}
      <p
        className="text-caption text-muted-foreground"
        aria-hidden="true"
        data-testid="pay-sheet-confirmation-countdown"
      >
        {t('autoCloseCountdown', { seconds: remaining })}
      </p>
      <p
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="pay-sheet-confirmation-countdown-sr"
      >
        {remaining <= 3 && remaining > 0
          ? t('autoCloseCountdown', { seconds: remaining })
          : ''}
      </p>
    </section>
  );
}

export default ConfirmationPanel;
