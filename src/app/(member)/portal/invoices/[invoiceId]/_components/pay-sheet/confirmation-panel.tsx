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
import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { CheckCircle2Icon, DownloadIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
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
  // WCAG 2.4.3 Focus Order: on payment success the previously-focused
  // element (card submit button) unmounts → focus reverts to <body>
  // which is disorienting for keyboard + SR users. Land focus on the
  // primary Download CTA so the next Enter press downloads the
  // receipt (audit 2026-04-25 finding #15).
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    downloadLinkRef.current?.focus();
  }, []);

  // One-shot toast on mount — guarded so StrictMode's double-invoke in
  // development doesn't produce two toasts.
  const toastedRef = useRef<boolean>(false);
  useEffect(() => {
    if (toastedRef.current) return;
    toastedRef.current = true;
    toast.success(t('toast'));
  }, [t]);

  // Auto-close countdown. Tick once per second decrementing remaining.
  // Close is dispatched in a SEPARATE effect that watches `remaining`
  // (below) to avoid a setState-during-render React warning that
  // fires when the parent's setState is invoked from inside a
  // setState updater. The updater itself runs during React's render
  // phase, so calling `onClose()` (which calls setPayState on the
  // parent <PaySheetInternal>) — even wrapped in startTransition —
  // surfaces as "Cannot update a component (PaySheetInternal) while
  // rendering a different component (ConfirmationPanel)".
  useEffect(() => {
    const timer = setInterval(() => {
      setRemaining((prev) => {
        if (interruptedRef.current) {
          clearInterval(timer);
          return prev;
        }
        if (prev <= 1) {
          clearInterval(timer);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // Dispatch close once the countdown hits zero. Separate effect =
  // runs after commit, safely outside any render pass.
  useEffect(() => {
    if (remaining !== 0) return;
    if (interruptedRef.current) return;
    onClose();
  }, [remaining, onClose]);

  const interruptAutoClose = () => {
    interruptedRef.current = true;
  };

  // `last4Display`: when the backend supplies the actual last 4
  // digits we show them verbatim prefixed with the masked-pan prefix
  // (Stripe SAQ-A convention: "****4242"). Without a real value we
  // show just the mask so the copy stays truthful — never render
  // `********` (8 asterisks) which implies 8-digit padding.
  const last4Display =
    last4 && /^\d{4}$/.test(last4) ? `****${last4}` : '****';
  const summary =
    method === 'card'
      ? t('summaryCard', {
          amount,
          last4: last4Display,
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
      {/*
       * Option A layout (T082 UX feedback 2026-04-24): primary
       * Download CTA takes the full drawer body width; the Close
       * action is a subtle text-link underneath. Rationale: Close is
       * an "early exit" from the 5s auto-close, not a primary user
       * intent — it should visually recede so the eye lands on the
       * Download receipt, and the hierarchy reads as Download (act)
       * → Close (dismiss) → countdown (passive info).
       */}
      <a
        ref={downloadLinkRef}
        href={receiptUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          buttonVariants({ variant: 'default' }),
          // WCAG 2.5.5 / SC 2.5.8 — mobile tap target ≥ 44×44 px
          // (G-Review Finding #5).
          'min-h-[44px] w-full px-4',
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
      <button
        type="button"
        onClick={() => {
          interruptAutoClose();
          onClose();
        }}
        // Text-link styling: underline on hover, same min tap target
        // on mobile even though it looks like a link. Muted-foreground
        // keeps it subtler than the primary CTA but still WCAG 2.1 AA
        // contrast (4.5:1 on card background).
        className="min-h-[44px] text-caption text-muted-foreground hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:rounded"
        data-testid="pay-sheet-confirmation-close"
      >
        {t('close')}
      </button>
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
