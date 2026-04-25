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
import { CheckCircle2Icon, DownloadIcon, PauseIcon } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCountdownAutoDismiss } from '@/hooks/use-countdown-auto-dismiss';

// Exported so tests can express timing assertions in terms of the
// canonical value (e.g. `for i < AUTO_CLOSE_SECONDS * 2`) instead of
// hard-coding a magic number that drifts when the UX team retunes
// the auto-close window.
export const AUTO_CLOSE_SECONDS = 5;

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

  // WCAG 2.4.3 Focus Order: on payment success the previously-focused
  // element (card submit button) unmounts → focus reverts to <body>
  // which is disorienting for keyboard + SR users. focus the
  // section (with tabIndex=-1 + aria-labelledby on the success heading)
  // so SR users hear the success heading + summary BEFORE focus lands
  // on the Download CTA. Pressing Tab takes them to Download next.
  const sectionRef = useRef<HTMLElement>(null);
  const downloadLinkRef = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    sectionRef.current?.focus();
  }, []);

  // One-shot toast on mount — guarded so StrictMode's double-invoke in
  // development doesn't produce two toasts.
  const toastedRef = useRef<boolean>(false);
  useEffect(() => {
    if (toastedRef.current) return;
    toastedRef.current = true;
    toast.success(t('toast'));
  }, [t]);

  // shared `useCountdownAutoDismiss` hook (was previously
  // an inline ticker + separate-effect dispatcher; same pattern lives
  // in `<HardCapPrompt>` and is now deduplicated). The two-effect
  // split inside the hook avoids "Cannot update a component while
  // rendering a different component" by dispatching onExpire from a
  // post-commit effect instead of from the setState updater.
  const { remaining, interrupt: interruptAutoClose } = useCountdownAutoDismiss(
    AUTO_CLOSE_SECONDS,
    onClose,
  );

  // R3 WCAG 2.2.1 (Timing Adjustable): a 5s auto-close is below the 20s
  // statutory threshold for "essential" timing. Provide an explicit
  // user-controlled pause so keyboard / SR / cognitive-disability users
  // can stop the timer without committing to Download / Close. Once
  // paused the panel stays open until the user dismisses explicitly.
  const [paused, setPaused] = useState<boolean>(false);
  const handlePause = () => {
    interruptAutoClose();
    setPaused(true);
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

  // R4 polish: extracted from JSX to avoid a 3-arm nested ternary inside
  // the SR live-region. Visible countdown stays inline because it has
  // a trivial 2-arm shape.
  const SR_THRESHOLD_SECONDS = [3, 1] as const;
  const srMessage = paused
    ? t('autoClosePaused')
    : (SR_THRESHOLD_SECONDS as readonly number[]).includes(remaining)
      ? t('autoCloseCountdown', { seconds: remaining })
      : '';

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      aria-labelledby="pay-sheet-confirmation-title"
      data-testid="pay-sheet-confirmation-panel"
      className="flex flex-col items-center gap-4 text-center focus:outline-none"
    >
      <CheckCircle2Icon
        aria-hidden="true"
        className="size-12 text-primary motion-safe:animate-in motion-safe:zoom-in-50 motion-safe:duration-200"
        data-testid="pay-sheet-confirmation-icon"
      />
      <h3
        id="pay-sheet-confirmation-title"
        className="text-h3 font-semibold text-foreground"
      >
        {t('title')}
      </h3>
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
       * Countdown + Pause control (R3: WCAG 2.2.1).
       * --------------------------------------------
       * Visible <p> ticks every second but is `aria-hidden` so screen
       * readers don't flood. A sibling `aria-live="polite"` node fires
       * at remaining ∈ [3, 1] — matches HardCapPrompt's multi-threshold
       * pattern (30/10/5/1) so SR users always get at least one
       * "closing soon" cue + a final "1 second" warning before
       * dismissal. Once `paused` flips, both nodes show the paused
       * state and the timer is frozen by `interruptAutoClose`.
       */}
      <div className="flex items-center gap-3">
        <p
          className="text-caption text-muted-foreground"
          aria-hidden="true"
          data-testid="pay-sheet-confirmation-countdown"
        >
          {paused
            ? t('autoClosePaused')
            : t('autoCloseCountdown', { seconds: remaining })}
        </p>
        {!paused && (
          <button
            type="button"
            onClick={handlePause}
            // 24×24 minimum target (WCAG 2.5.8) — kept compact since
            // this is a "soft" affordance next to the countdown text;
            // primary keyboard targets remain Download / Close.
            className="inline-flex min-h-[24px] min-w-[24px] items-center gap-1 rounded text-caption text-muted-foreground hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
            data-testid="pay-sheet-confirmation-pause"
          >
            <PauseIcon aria-hidden="true" className="size-3" />
            {t('pauseAutoClose')}
          </button>
        )}
      </div>
      <p
        className="sr-only"
        aria-live="polite"
        aria-atomic="true"
        data-testid="pay-sheet-confirmation-countdown-sr"
      >
        {srMessage}
      </p>
    </section>
  );
}

export default ConfirmationPanel;
