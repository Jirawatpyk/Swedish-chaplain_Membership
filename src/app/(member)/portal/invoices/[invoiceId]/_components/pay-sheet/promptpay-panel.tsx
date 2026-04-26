'use client';

/**
 * <PromptPayPanel> — Phase 4 / T091 (US2 PromptPay).
 *
 * Renders the Stripe-issued PromptPay QR payload returned in
 * `next_action.promptpay_display_qr_code.image_url_svg` together with
 *
 *   - bilingual scan-instructions ("Scan with any Thai bank app" /
 *     "สแกนด้วยแอปธนาคารไทย")
 *   - aria-live="polite" countdown timer (defaults to 15 minutes per
 *     `tenant_payment_settings.promptpay_qr_expiry_seconds`)
 *   - anti-fraud warning microcopy ("Only scan the QR code shown above;
 *     do NOT transfer manually to any other account")
 *   - "Refresh QR" CTA — visible always, primary CTA when expired —
 *     fires `onRefresh()` which the parent uses to re-call
 *     `/api/payments/initiate` and produce a new attempt_seq
 *
 * Polling: this component does NOT own the PaymentIntent poll loop.
 * The parent <PaySheetInternal> wires `useThreeDSecurePoll` against the
 * promptpay clientSecret so the same `succeeded` / `canceled` machinery
 * used for card 3DS drives the success/failure transition. The QR
 * countdown here is a UX concern (when does the user need a fresh QR)
 * not a correctness concern — Stripe's own PI auto-cancellation is the
 * source of truth.
 *
 * Reduced-motion (FR-028g): countdown digits update via plain text; no
 * pulsing, no spinning. The "waiting for confirmation" status uses
 * `motion-safe:animate-pulse motion-reduce:animate-none` so a
 * reduced-motion user sees a steady dot instead of a pulsing one.
 *
 * a11y:
 *   - QR <img> has a localized non-empty alt
 *   - countdown lives inside `aria-live="polite"` so announcements are
 *     non-interrupting (FR-028j)
 *   - expired-state region uses `aria-live="assertive"` so SR users hear
 *     the expiry the moment it lands
 *   - refresh button has `min-h-[44px] min-w-[44px]` (WCAG 2.5.5)
 *
 * App-switching state persistence (T093 / spec § Edge Cases P6)
 * -------------------------------------------------------------
 * The user is expected to switch to a Thai bank app to scan the QR.
 * On return:
 *   - <PaySheet> stays mounted across drawer close/open cycles (mount-
 *     once pattern in `./index.tsx`), so navigating *within* the
 *     invoice detail page does not unmount this component
 *   - the parent's `useThreeDSecurePoll` against the PromptPay
 *     clientSecret keeps polling Stripe via `stripe.retrievePaymentIntent`
 *     regardless of `document.visibilityState`. setInterval is throttled
 *     in a backgrounded tab but resumes immediately on focus
 *   - all state lives in React (ephemeral) — no localStorage / sessionStorage
 *     read/write, so a tab refresh after switching apps requires a fresh
 *     drawer open + initiate (PCI SAQ-A invariant; see <PaySheet> header)
 *
 * Stripe Elements appearance (T094)
 * --------------------------------
 * This component does NOT mount Stripe Elements — the PromptPay rail is
 * a server-confirmed PaymentIntent rendered as a plain `<img>` of the
 * QR SVG returned by Stripe in `next_action.promptpay_display_qr_code`.
 * No Stripe iframe means no card fields can leak into the PromptPay
 * tab, satisfying T094 by construction. The card tab continues to
 * apply `useLocale().split('-')[0]` truncation in <CardForm>.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { useLocale, useTranslations } from 'next-intl';
import { RefreshCwIcon } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatSatangThb } from '@/app/(member)/portal/invoices/_utils/format';
import { paymentsMetrics } from '@/lib/metrics';
import { useCountdownAutoDismiss } from '@/hooks/use-countdown-auto-dismiss';

export interface PromptPayPanelProps {
  /** PromptPay QR SVG URL returned by Stripe `next_action`. */
  readonly qrSvgUrl: string;
  /** Invoice amount in satang for amount-display. */
  readonly amountSatang: number;
  /** Currency code (ISO 4217 lowercase). Display-only — always 'thb' for PromptPay. */
  readonly currency: string;
  /**
   * QR expiry seconds. Defaults to 900 (15 min) per
   * `tenant_payment_settings.promptpay_qr_expiry_seconds` MVP value.
   */
  readonly expirySeconds?: number;
  /**
   * Fires when the user clicks "Refresh QR" — either explicitly before
   * expiry or after the countdown reaches zero. Parent re-calls
   * `/api/payments/initiate` to create a new attempt_seq + fresh QR.
   */
  readonly onRefresh: () => void;
  /**
   * Fires when the QR `<img>` fails to load (Stripe SVG 404, CSP block,
   * network failure mid-load). Without this hook, the panel would render
   * a blank box with a ticking countdown — silent failure. The parent is
   * expected to map this to a recoverable failure state (e.g. set
   * `promptpayState` to `failure` with a localized reason).
   */
  readonly onLoadError?: () => void;
  /**
   * `'pending'` (default) renders the QR + countdown.
   * `'expired'` swaps to the "QR expired — Refresh" panel.
   * `'waiting-confirmation'` keeps the QR up but shows a "waiting for
   * payment confirmation…" indicator (used after the countdown reaches
   * zero but before the parent decides what to do, or while waiting on
   * the Stripe webhook to fire). Optional — parent normally just toggles
   * between `'pending'` and `'expired'`.
   */
  readonly status?: 'pending' | 'expired' | 'waiting-confirmation';
  /**
   * Whether the panel is the visible tab. PaySheet's `MethodTabs`
   * uses `keepMounted` so this component stays in the DOM (just
   * `hidden`) when the user is on the Card tab — without this gate
   * the 1Hz countdown `setInterval` would tick + re-render
   * unnecessarily on the inactive tab. Defaults to `true` for
   * single-tab callers + tests.
   */
  readonly active?: boolean;
}

/**
 * Maximum in-component QR `<img>` reload attempts before escalating
 * to the parent's failure state. Stripe-hosted SVGs over a flaky
 * mobile connection occasionally drop one byte; one or two retries
 * is usually enough to recover without burning a Stripe PI.
 */
export const MAX_QR_LOAD_RETRIES = 2;

/**
 * Pure helper — extracted for unit-testability of the countdown format.
 * Always renders MM:SS with leading zeros so SR announcements are stable.
 */
export function formatCountdown(remainingSeconds: number): {
  readonly minutes: string;
  readonly seconds: string;
} {
  const safeRemaining = Math.max(0, Math.floor(remainingSeconds));
  const minutes = Math.floor(safeRemaining / 60);
  const seconds = safeRemaining % 60;
  return {
    minutes: String(minutes).padStart(2, '0'),
    seconds: String(seconds).padStart(2, '0'),
  };
}

export function PromptPayPanel({
  qrSvgUrl,
  amountSatang,
  currency,
  expirySeconds = 900,
  onRefresh,
  onLoadError,
  status = 'pending',
  active = true,
}: PromptPayPanelProps) {
  const t = useTranslations('portal.payment.promptpay');
  const locale = useLocale();

  // Reuses the shared interval ticker (also used by ConfirmationPanel
  // + HardCapPrompt). The parent must remount this panel via a
  // `key` change when a fresh PaymentIntent is issued so the
  // countdown re-arms — see the `key={promptpayState.qrSvgUrl}` on
  // the call site in `pay-sheet-internal.tsx`.
  const { remaining, interrupt } = useCountdownAutoDismiss(
    expirySeconds,
    () => {
      // No-op: expiry is rendered via the `showExpired` derivation
      // below. The hook's `firedRef` ensures `onExpire` runs once
      // even if React re-renders the panel after `remaining=0`.
    },
  );
  // Stop ticking the moment the panel transitions out of `pending`
  // (e.g. parent flips status='expired' or 'waiting-confirmation')
  // OR the user is on a different tab (kept-mounted but hidden).
  useEffect(() => {
    if (status !== 'pending' || !active) interrupt();
  }, [status, active, interrupt]);

  // Image-load retry counter. The browser fires `<img onError>` on
  // any load failure, including transient network hiccups that the
  // browser would have recovered from on a retry. Without
  // debouncing, a single 3G blip would escalate to the parent
  // failure state → user clicks Refresh → new Stripe PI created →
  // attempt_seq + rate-limit budget burned for nothing. Allow up
  // to `MAX_QR_LOAD_RETRIES` in-component retries (force-reload by
  // appending a cache-busting query param) before escalating.
  const qrRetryCountRef = useRef<number>(0);
  const [qrSrc, setQrSrc] = useState<string>(qrSvgUrl);
  // Reset retry state whenever the QR URL itself changes (parent
  // produced a fresh PaymentIntent → fresh attempt).
  useEffect(() => {
    qrRetryCountRef.current = 0;
    setQrSrc(qrSvgUrl);
  }, [qrSvgUrl]);

  const handleQrLoadError = useCallback(() => {
    if (qrRetryCountRef.current < MAX_QR_LOAD_RETRIES) {
      qrRetryCountRef.current += 1;
      // Cache-bust query param forces the browser to retry. The
      // same Stripe SVG URL is reused — no new PI is created.
      setQrSrc(`${qrSvgUrl}#retry=${qrRetryCountRef.current}`);
      return;
    }
    // Retry budget exhausted — emit metric so flaky-CDN / CSP-block
    // patterns surface in dashboards.
    paymentsMetrics.qrLoadRetriesExhausted();
    onLoadError?.();
  }, [onLoadError, qrSvgUrl]);

  const { minutes, seconds } = formatCountdown(remaining);
  const amountDisplay = useMemo(
    () =>
      currency === 'thb'
        ? formatSatangThb(BigInt(Math.round(amountSatang)), locale)
        : `${amountSatang} ${currency.toUpperCase()}`,
    [amountSatang, currency, locale],
  );

  const showExpired =
    status === 'expired' || (status === 'pending' && remaining === 0);

  if (showExpired) {
    return (
      <section
        data-testid="pay-sheet-promptpay-expired"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
      >
        <div>
          <h3 className="text-body font-medium text-foreground">
            {t('expired')}
          </h3>
          <p className="text-caption text-muted-foreground mt-1">
            {t('expiredBody')}
          </p>
        </div>
        <Button
          type="button"
          variant="default"
          onClick={onRefresh}
          className="min-h-[44px] w-full"
          data-testid="pay-sheet-promptpay-refresh"
        >
          <RefreshCwIcon className="size-4" aria-hidden="true" />
          {t('refresh')}
        </Button>
      </section>
    );
  }

  return (
    <section
      data-testid="pay-sheet-promptpay-panel"
      className="space-y-4"
    >
      <div className="flex flex-col items-center gap-3">
        {/*
         * Stripe returns a PUBLIC SVG URL hosted on
         * `https://*.stripe.com/...`. Render via `<img>` so the SVG is
         * sandboxed inside an image tag (no DOM-level script execution
         * surface). Aspect-ratio-square keeps the QR scannable on any
         * viewport. Width capped to 220 px so the bilingual instructions
         * + countdown still fit on a 320 px iPhone viewport without the
         * sheet's vertical scroll.
         *
         * `next/image` with `unoptimized` — the QR is a Stripe-hosted
         * public SVG that changes per-PaymentIntent and lives only for
         * the duration of the drawer session, so the optimizer pipeline
         * adds no value (no caching across PIs, fixed 220px size).
         * `unoptimized` skips the loader while still satisfying the
         * `@next/next/no-img-element` rule and giving us width/height
         * intrinsic-sizing.
         */}
        <Image
          src={qrSrc}
          alt={t('qrAlt')}
          width={220}
          height={220}
          unoptimized
          className="aspect-square h-auto w-[220px] rounded-md border border-border bg-popover p-3"
          data-testid="pay-sheet-promptpay-qr"
          onError={handleQrLoadError}
        />
        <p className="text-body text-foreground">{t('instructions')}</p>
        <p className="text-caption text-muted-foreground">
          {t('amount', { amount: amountDisplay })}
        </p>
      </div>

      <div
        // FR-028j — non-interrupting countdown announcements.
        aria-live="polite"
        aria-atomic="true"
        className="text-center text-caption text-muted-foreground tabular-nums"
        data-testid="pay-sheet-promptpay-countdown"
      >
        {t('countdown', { minutes, seconds })}
      </div>

      {status === 'waiting-confirmation' ? (
        <div
          aria-live="polite"
          className="flex items-center justify-center gap-2 text-caption text-muted-foreground"
          data-testid="pay-sheet-promptpay-waiting"
        >
          <span
            aria-hidden="true"
            className="inline-block size-2 rounded-full bg-primary motion-safe:animate-pulse motion-reduce:animate-none"
          />
          {t('waiting')}
        </div>
      ) : null}

      <p
        className="rounded-md bg-muted/40 p-3 text-caption text-muted-foreground"
        data-testid="pay-sheet-promptpay-warning"
      >
        {t('warning')}
      </p>

      <Button
        type="button"
        variant="outline"
        onClick={onRefresh}
        className="min-h-[44px] w-full"
        data-testid="pay-sheet-promptpay-refresh"
      >
        <RefreshCwIcon className="size-4" aria-hidden="true" />
        {t('refresh')}
      </Button>
    </section>
  );
}

export default PromptPayPanel;
