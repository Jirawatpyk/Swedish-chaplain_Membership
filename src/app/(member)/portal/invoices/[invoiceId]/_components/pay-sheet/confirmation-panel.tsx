'use client';

/**
 * <ConfirmationPanel> — post-settlement success state (FR-028e).
 *
 * Responsibilities:
 *   - CheckCircle icon (motion-safe scale-in 200 ms; motion-reduce instant).
 *   - Bilingual title + per-method summary (card vs promptpay).
 *   - Primary CTA "Download receipt" → the §86/4 RC receipt-PDF byte-streaming
 *     route `/api/portal/invoices/{id}/receipt/pdf` (passed in as the
 *     `receiptUrl` prop; built by `buildReceiptDownloadUrl` in
 *     pay-sheet-internal — 090 Bug 1 replaced the prior placeholder RSC path
 *     that 404'd). 090 finding #2/#8 — the CTA is a `<button>` running the
 *     shared fetch+blob `downloadPdf` helper (same as
 *     `PortalReceiptDownloadButton`), NOT a raw `<a target="_blank">`. At the
 *     just-paid moment the RC PDF is usually still rendering (webhook race), so
 *     the route returns 425; the helper maps that to the friendly "receipt
 *     still generating" toast instead of leaking the raw JSON error into a new
 *     tab. When the RC has rendered it downloads directly.
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
import {
  CheckCircle2Icon,
  DownloadIcon,
  Loader2,
  PauseIcon,
  PlayIcon,
} from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { downloadPdf } from '@/lib/download-pdf-client';
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
  /** Localized datetime string (caller formats with `intl` per locale). */
  readonly dateTime: string;
  /** Member receipt-PDF byte-streaming route (`/api/portal/.../receipt/pdf`). */
  readonly receiptUrl: string;
  /** Invoice id — used for the fallback download filename (090 finding #2). */
  readonly invoiceId: string;
  /** Fired on user-initiated close OR on countdown exhaustion. */
  readonly onClose: () => void;
  /**
   * Optional callback for when the user clicks "Download receipt" (in
   * addition to running the fetch+blob `downloadPdf`). Parent may use this
   * to emit a telemetry event. Does NOT auto-close the drawer — the user
   * must explicitly click "Close" (or let the 5-second auto-close fire).
   */
  readonly onDownload?: () => void;
}

export function ConfirmationPanel({
  method,
  amount,
  dateTime,
  receiptUrl,
  invoiceId,
  onClose,
  onDownload,
}: ConfirmationPanelProps) {
  const t = useTranslations('portal.payment.success');
  // 090 finding #2 — receipt-download toast strings (shared namespace with
  // <PortalReceiptDownloadButton>) for the fetch+blob 4xx/5xx → toast mapping.
  const tToast = useTranslations('portal.invoices.toast');

  // WCAG 2.4.3 Focus Order: on payment success the previously-focused
  // element (card submit button) unmounts → focus reverts to <body>
  // which is disorienting for keyboard + SR users. focus the
  // section (with tabIndex=-1 + aria-labelledby on the success heading)
  // so SR users hear the success heading + summary BEFORE focus lands
  // on the Download CTA. Pressing Tab takes them to Download next.
  const sectionRef = useRef<HTMLElement>(null);
  useEffect(() => {
    sectionRef.current?.focus();
  }, []);

  // 090 finding #2 — in-flight state for the fetch+blob receipt download so the
  // CTA shows a spinner + is disabled while the request is running.
  const [downloading, setDownloading] = useState<boolean>(false);

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
  const {
    remaining,
    interrupt: interruptAutoClose,
    resume: resumeAutoClose,
  } = useCountdownAutoDismiss(AUTO_CLOSE_SECONDS, onClose);

  // R3 WCAG 2.2.1 (Timing Adjustable): a 5s auto-close is below the 20s
  // statutory threshold for "essential" timing. Provide an explicit
  // user-controlled pause so keyboard / SR / cognitive-disability users
  // can stop the timer without committing to Download / Close. R5 S008:
  // pause is now reversible — Pause toggles to Resume which re-arms the
  // countdown from the current `remaining` (avoids the "stuck panel
  // forever" UX trap when a user pauses by mistake).
  const [paused, setPaused] = useState<boolean>(false);
  const handlePause = () => {
    interruptAutoClose();
    setPaused(true);
  };
  const handleResume = () => {
    resumeAutoClose();
    setPaused(false);
  };

  // 090 finding #2 — fetch+blob receipt download (mirrors
  // <PortalReceiptDownloadButton>). At the just-paid moment the RC PDF is
  // usually still rendering → the route 425s → `downloadPdf` fires the friendly
  // `receiptPending` toast instead of leaking raw JSON into a new tab.
  // `interruptAutoClose` stops the 5s countdown so the drawer doesn't close
  // mid-download; `onDownload` keeps its telemetry hook.
  const handleDownloadReceipt = async () => {
    interruptAutoClose();
    onDownload?.();
    setDownloading(true);
    const loadingId = toast.loading(tToast('downloadInProgress'));
    try {
      await downloadPdf({
        url: receiptUrl,
        fallbackFilename: `${invoiceId}-receipt.pdf`,
        toasts: {
          pending: tToast('receiptPending'),
          failed: (reason: string) =>
            reason
              ? tToast('receiptFailed', { reason })
              : tToast('receiptUnavailable'),
          forbidden: tToast('receiptForbidden'),
          unavailable: tToast('receiptUnavailable'),
          sessionExpired: tToast('receiptSessionExpired'),
          rateLimited: tToast('receiptRateLimited'),
        },
        toastWarning: (msg) => toast.warning(msg),
        toastError: (msg) => toast.error(msg),
      });
    } finally {
      toast.dismiss(loadingId);
      setDownloading(false);
    }
  };

  // review-20260428-102639.md W15 closure — `last4` removed.
  // Stripe `confirmPayment` does not return the card object on the
  // happy path; fetching it requires either an `expand=payment_method`
  // round-trip or a separate retrieve call. SAQ-A scope considers
  // last4 non-sensitive but the extra call adds latency for what is
  // informational copy only (the user just typed the card seconds
  // ago). Removed from i18n templates across EN/TH/SV.
  const summary =
    method === 'card'
      ? t('summaryCard', { amount, dateTime })
      : t('summaryPromptPay', { amount, dateTime });

  // R4 polish: extracted from JSX to avoid a 3-arm nested ternary inside
  // the SR live-region. Visible countdown stays inline because it has
  // a trivial 2-arm shape.
  // review-20260428-102639.md S10 closure — added 5s threshold for
  // parity with HardCapPrompt + PromptPay countdown. Two announcements
  // in the 5s window left a silent gap at the start; SR users now get
  // an opening cue, mid-window check, and final-second confirmation.
  const SR_THRESHOLD_SECONDS = [5, 3, 1] as const;
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
      {/* 090 finding #2/#8 — a `<button>` running the fetch+blob `downloadPdf`
          (NOT `<a target="_blank">`), so a 425 "receipt still generating" surfaces
          as a toast instead of leaking raw JSON into a new tab. */}
      <button
        type="button"
        disabled={downloading}
        onClick={handleDownloadReceipt}
        className={cn(
          buttonVariants({ variant: 'default' }),
          // WCAG 2.5.5 / SC 2.5.8 — mobile tap target ≥ 44×44 px
          // (G-Review Finding #5).
          'min-h-[44px] w-full px-4',
          // T164 — accountant print convenience: hide download CTA when
          // printing (button is non-functional on paper). The F4 receipt
          // PDF remains the authoritative Thai-tax-compliant document
          // (FR-004); the print view here is informal confirmation only.
          'print:hidden',
        )}
        data-testid="pay-sheet-download-receipt"
      >
        {downloading ? (
          <Loader2
            aria-hidden="true"
            className="size-4 motion-safe:animate-spin"
          />
        ) : (
          <DownloadIcon aria-hidden="true" className="size-4" />
        )}
        {t('downloadReceipt')}
      </button>
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
        // T164: hide on print — close button has no meaning on paper.
        className="min-h-[44px] text-caption text-muted-foreground hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:rounded print:hidden"
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
      <div className="flex items-center gap-3 print:hidden">
        <p
          className="text-caption text-muted-foreground"
          aria-hidden="true"
          data-testid="pay-sheet-confirmation-countdown"
        >
          {paused
            ? t('autoClosePaused')
            : t('autoCloseCountdown', { seconds: remaining })}
        </p>
        <button
          type="button"
          onClick={paused ? handleResume : handlePause}
          // Visual stays compact (soft affordance beside the countdown text)
          // but a `::before` overlay extends the tap target to ~44px tall to
          // match the codebase 44px convention (WCAG 2.5.5) without adding
          // vertical space; primary keyboard targets remain Download / Close.
          className="relative inline-flex min-h-[24px] min-w-[24px] items-center gap-1 rounded text-caption text-muted-foreground before:absolute before:inset-x-0 before:-inset-y-2.5 before:content-[''] hover:text-foreground hover:underline underline-offset-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid={paused ? 'pay-sheet-confirmation-resume' : 'pay-sheet-confirmation-pause'}
        >
          {paused ? (
            <PlayIcon aria-hidden="true" className="size-3" />
          ) : (
            <PauseIcon aria-hidden="true" className="size-3" />
          )}
          {paused ? t('resumeAutoClose') : t('pauseAutoClose')}
        </button>
      </div>
      <p
        className="sr-only print:hidden"
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
