'use client';

/**
 * <CardForm> — Stripe Elements card payment form for the PaySheet
 * drawer (G3 T076). Lazy-loads `@stripe/stripe-js` via a module-scoped
 * singleton cache so repeat mounts (e.g. user toggles tabs) reuse the
 * same `Stripe` instance per publishableKey (UX contract T074).
 *
 * PCI-critical
 * ------------
 * `clientSecret` is received via props from <PaySheetInternal>'s
 * ephemeral useState. This component NEVER writes it to any browser
 * persistence store (localStorage, sessionStorage, cookies,
 * IndexedDB). ESLint barrel-guard prevents any cross-module imports.
 * Run `grep -r "localStorage\\|sessionStorage" pay-sheet/` in CI.
 *
 * CLS = 0 contract
 * ----------------
 * The PaySheetSkeleton occupies the same 4-row height as the rendered
 * <PaymentElement>. We gate visibility on useMinDelay(300, elementReady)
 * so skeleton always shows ≥ 300 ms even on instant element loads,
 * preventing flicker on fast connections (§ 2.2 rule 3).
 *
 * Submit flow
 * -----------
 *   stripe.confirmPayment({ elements, confirmParams: { return_url },
 *                           redirect: 'if_required' })
 *     .then((result) => switch on result.paymentIntent.status)
 *
 *   - succeeded        → onSuccess({ paymentIntent })
 *   - processing       → onSuccess (caller renders ProcessingPanel)
 *   - requires_action  → onRequiresAction({ paymentIntent })
 *   - any error        → onFailure({ message })
 *
 * Theming (FR-028b)
 * -----------------
 * Stripe Elements `appearance.theme` switches between 'stripe' (light)
 * and 'night' (dark) based on the resolved `next-themes` value. CSS
 * variables (--primary, --background, --foreground, --radius) are
 * propagated so the PaymentElement matches the host drawer chrome.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';

import { formatSatangThb } from '@/app/(member)/portal/invoices/_utils/format';
import {
  loadStripe,
  type Stripe,
  type StripeElementsOptions,
} from '@stripe/stripe-js';
import {
  Elements,
  PaymentElement,
  useElements,
  useStripe,
} from '@stripe/react-stripe-js';

import { Button } from '@/components/ui/button';
import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';
import { useMinDelay } from '@/hooks/use-min-delay';

// -- Stripe singleton cache -------------------------------------------------
// Module-level Map keyed by publishableKey so toggling tabs (or re-
// opening the drawer for a different invoice under the same tenant)
// reuses the already-loaded Stripe instance. This is the UX contract
// T074 calls out + the officially-recommended pattern in the Stripe
// Elements docs.
const stripePromiseCache = new Map<string, Promise<Stripe | null>>();

function getStripe(publishableKey: string): Promise<Stripe | null> {
  let cached = stripePromiseCache.get(publishableKey);
  if (!cached) {
    cached = loadStripe(publishableKey);
    stripePromiseCache.set(publishableKey, cached);
  }
  return cached;
}

// -- Props ------------------------------------------------------------------
export interface CardFormSuccessPayload {
  readonly paymentIntentId: string;
  readonly status: 'succeeded' | 'processing';
}

export interface CardFormRequiresActionPayload {
  readonly paymentIntentId: string;
}

export interface CardFormFailurePayload {
  readonly message: string;
  readonly code?: string;
}

export interface CardFormProps {
  readonly clientSecret: string;
  readonly publishableKey: string;
  /** Amount due (for display-only badges). Currency handled by Stripe. */
  readonly amountDue: number;
  readonly currency: string;
  readonly invoiceId: string;
  readonly memberId: string;
  readonly onSuccess: (payload: CardFormSuccessPayload) => void;
  readonly onFailure: (payload: CardFormFailurePayload) => void;
  readonly onRequiresAction: (payload: CardFormRequiresActionPayload) => void;
  /**
   * Fires when the visible PaymentElement is fully rendered (Stripe
   * `onReady` + the 300ms skeleton floor). PaySheetInternal uses it
   * to gate rendering of the trust-signal footer so it does not
   * appear below the skeleton on first load — T082 UX feedback
   * 2026-04-24: "skeleton ค้างนาน, เห็น footer ข้างหลัง".
   */
  readonly onVisible?: () => void;
}

// -- Inner form (must live inside <Elements>) -------------------------------
interface CardFormInnerProps {
  readonly invoiceId: string;
  readonly amountLabel: string;
  readonly onReady: () => void;
  readonly onLoadError: (message: string) => void;
  readonly onSuccess: CardFormProps['onSuccess'];
  readonly onFailure: CardFormProps['onFailure'];
  readonly onRequiresAction: CardFormProps['onRequiresAction'];
  readonly show: boolean;
}

function CardFormInner({
  invoiceId,
  amountLabel,
  onReady,
  onLoadError,
  onSuccess,
  onFailure,
  onRequiresAction,
  show,
}: CardFormInnerProps) {
  const t = useTranslations('portal.payment');
  const stripe = useStripe();
  const elements = useElements();
  const [submitting, setSubmitting] = useState<boolean>(false);

  const handleSubmit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!stripe || !elements) return;
      setSubmitting(true);
      const origin =
        typeof window !== 'undefined' ? window.location.origin : '';
      const result = await stripe.confirmPayment({
        elements,
        confirmParams: {
          return_url: `${origin}/portal/invoices/${invoiceId}?paid=1`,
        },
        redirect: 'if_required',
      });
      setSubmitting(false);

      if (result.error) {
        // Map well-known Stripe error codes → localized reasons.
        // Stripe's error shape for a declined card is:
        //   code         = 'card_declined' (always, for any decline)
        //   decline_code = 'insufficient_funds' | 'expired_card'
        //                | 'incorrect_cvc' | 'processing_error' | ...
        // So we branch on `decline_code` FIRST for the specific reason,
        // then fall through to `code` for non-decline errors
        // (validation_error, authentication_required, rate_limited etc).
        const code = result.error.code;
        const declineCode = (result.error as { decline_code?: string })
          .decline_code;
        const localized = ((): string | null => {
          switch (declineCode) {
            case 'insufficient_funds':
              return t('retry.reasonInsufficientFunds');
            case 'expired_card':
              return t('retry.reasonExpiredCard');
            case 'incorrect_cvc':
              return t('retry.reasonIncorrectCvc');
            case 'processing_error':
              return t('retry.reasonProcessingError');
          }
          switch (code) {
            case 'card_declined':
              return t('retry.reasonCardDeclined');
            case 'incorrect_cvc':
            case 'invalid_cvc':
              return t('retry.reasonIncorrectCvc');
            case 'expired_card':
              return t('retry.reasonExpiredCard');
            case 'insufficient_funds':
              return t('retry.reasonInsufficientFunds');
            case 'processing_error':
              return t('retry.reasonProcessingError');
            case 'authentication_required':
              return t('retry.reason3dsTimeout');
            default:
              return null;
          }
        })();
        onFailure({
          message:
            localized ?? result.error.message ?? t('retry.genericReason'),
          ...(code !== undefined && { code }),
        });
        return;
      }

      const pi = result.paymentIntent;
      if (!pi) {
        onFailure({ message: t('retry.genericReason') });
        return;
      }
      if (pi.status === 'requires_action') {
        onRequiresAction({ paymentIntentId: pi.id });
        return;
      }
      if (pi.status === 'succeeded' || pi.status === 'processing') {
        onSuccess({ paymentIntentId: pi.id, status: pi.status });
        return;
      }
      onFailure({ message: t('retry.genericReason') });
    },
    [stripe, elements, invoiceId, onSuccess, onFailure, onRequiresAction, t],
  );

  return (
    <form onSubmit={handleSubmit} data-testid="pay-sheet-card-form">
      {/*
       * Skeleton is OWNED BY THE PARENT (<PaySheetInternal>), not here.
       * CardForm renders only the visible form once Stripe is ready;
       * while `show=false` the form sits at opacity 0 + aria-hidden
       * so Stripe can paint its iframe off-screen. The parent layers
       * its own <PaySheetSkeleton> on top during loading (T082 UX
       * feedback 2026-04-24: previously had skeleton rendered in BOTH
       * places which produced stacked loading indicators).
       *
       * FR-028g — motion-reduce:duration-0 collapses fade to instant.
       */}
      <div
        className={`transition-opacity duration-200 motion-reduce:duration-0 ${
          show ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
        aria-hidden={!show}
      >
        <PaymentElement
          onReady={onReady}
          onLoadError={(event) => {
            onLoadError(event?.error?.message ?? t('error.elementLoadFailed'));
          }}
        />
        <Button
          type="submit"
          variant="default"
          disabled={!stripe || !elements || submitting || !show}
          className="mt-4 w-full min-h-[44px]"
          data-testid="pay-sheet-card-submit"
        >
          {submitting
            ? t('processing.title')
            : t('payAmount', { amount: amountLabel })}
        </Button>
      </div>
    </form>
  );
}

// -- Public wrapper ---------------------------------------------------------
export function CardForm({
  clientSecret,
  publishableKey,
  amountDue,
  currency,
  invoiceId,
  onSuccess,
  onFailure,
  onRequiresAction,
  onVisible,
}: CardFormProps) {
  const t = useTranslations('portal.payment');
  const locale = useLocale();
  const { resolvedTheme } = useTheme();
  // `amountDue` is carried as number-of-satang; `formatSatangThb`
  // divides by 100 + emits "3,530.00 THB" — matches OrderSummary.
  void currency;
  const amountLabel = formatSatangThb(BigInt(Math.round(amountDue)), locale);

  const [elementReady, setElementReady] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `remountKey` bumps to force a fresh <Elements> tree when the user
  // hits "Try again" after a load error (retry path per FR-028b).
  const [remountKey, setRemountKey] = useState<number>(0);

  // Gate the visible PaymentElement behind BOTH the Stripe ready event
  // and a 300 ms minimum skeleton duration.
  const show = useMinDelay(300, elementReady);

  // Notify the parent (PaySheetInternal) once the form is visible so
  // the trust-signal footer can be shown at the same moment the form
  // becomes interactive — not while the skeleton is still painting.
  // Fires exactly once per card-form mount.
  const notifiedRef = useRef(false);
  useEffect(() => {
    if (show && !notifiedRef.current) {
      notifiedRef.current = true;
      onVisible?.();
    }
  }, [show, onVisible]);

  // Memoize the Stripe promise AND the appearance options. Passing a
  // fresh object to <Elements> on every render forces a remount of the
  // internal iframe — expensive and visually jarring.
  const stripePromise = useMemo(
    () => getStripe(publishableKey),
    [publishableKey],
  );

  // Stripe Elements runs in a cross-origin iframe and cannot read our
  // CSS custom properties. Its appearance API also does NOT accept
  // `oklch()` (Tailwind v4's default color space) — only HEX / rgb() /
  // hsl(). To keep the theme synchronised with our design tokens
  // WITHOUT hard-coding hex values (which would drift as the theme
  // evolves), we resolve tokens at render time via:
  //   1. `getComputedStyle(document.documentElement)` to read the
  //      concrete value applied to `:root` (handles light↔dark via
  //      next-themes class toggling on <html>).
  //   2. Canvas 2D `fillStyle` which normalises any valid CSS color
  //      (including `oklch()`) to a canonical `#rrggbb` / `#rrggbbaa`
  //      string. This works because the browser's own color-parsing
  //      pipeline is invoked.
  // Fallbacks to Stripe's built-in theme palette when running without
  // a DOM (SSR paths — defensive; this component is client-only).
  const options = useMemo<StripeElementsOptions>(() => {
    /**
     * Resolve any CSS color (including `oklch()` / `lab()` / `hsl()`
     * / `color(display-p3 ...)`) to `#rrggbb`. Canvas `fillStyle`
     * reflectively returns the input color space verbatim in modern
     * browsers (Chrome normalises `oklch` → `lab()`), so we instead
     * RENDER one pixel into an in-memory bitmap and read the actual
     * rgba bytes via `getImageData`. The browser's color pipeline
     * handles every space; we get back guaranteed sRGB bytes.
     */
    const toHex = (cssColor: string): string | null => {
      if (!cssColor || typeof document === 'undefined') return null;
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      // `willReadFrequently: true` silences the Chrome perf warning
      // for repeated getImageData reads (one per CSS var resolved).
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) return null;
      try {
        // Validate by setting + probing — invalid colors leave fillStyle
        // at its previous value. Seed with a sentinel to detect that.
        // `fillStyle` types as `string | CanvasGradient | CanvasPattern`;
        // after a color string assignment browsers normalize to string,
        // so narrow via typeof instead of `as any` (audit finding #17).
        ctx.fillStyle = '#010203';
        ctx.fillStyle = cssColor;
        const normalized: unknown = ctx.fillStyle;
        if (
          typeof normalized === 'string' &&
          normalized === '#010203' &&
          cssColor !== '#010203'
        ) {
          return null;
        }
        ctx.fillRect(0, 0, 1, 1);
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
        const toHexByte = (v: number) =>
          v.toString(16).padStart(2, '0');
        return `#${toHexByte(r!)}${toHexByte(g!)}${toHexByte(b!)}`;
      } catch {
        return null;
      }
    };

    const resolved: Record<string, string> = {
      borderRadius: '8px',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
    };
    if (typeof window !== 'undefined') {
      const styles = getComputedStyle(document.documentElement);
      const pairs: Array<[keyof typeof resolved | string, string]> = [
        ['colorPrimary', styles.getPropertyValue('--primary').trim()],
        ['colorBackground', styles.getPropertyValue('--background').trim()],
        ['colorText', styles.getPropertyValue('--foreground').trim()],
        ['colorDanger', styles.getPropertyValue('--destructive').trim()],
      ];
      for (const [key, raw] of pairs) {
        if (!raw) continue;
        const hex = toHex(raw);
        if (hex) {
          resolved[key] = hex;
        } else if (process.env.NODE_ENV !== 'production') {
          // Surface unresolved brand colors during development so a
          // broken tenant theme is caught before QA instead of
          // silently falling back to Stripe's default palette
          // (audit 2026-04-25 finding #16).
          // eslint-disable-next-line no-console
          console.warn(
            `[pay-sheet/card-form] Unable to resolve CSS color for Stripe theme var "${key}" (raw="${raw}"). Stripe default will be used.`,
          );
        }
      }
    }

    return {
      clientSecret,
      appearance: {
        theme: resolvedTheme === 'dark' ? 'night' : 'stripe',
        variables: resolved,
      },
    };
  }, [clientSecret, resolvedTheme]);

  // G-Review Finding #10 — the previous dev-only "guard" effect was a
  // no-op (`void clientSecret`) that produced misleading signal. We do
  // NOT replace it with a `Storage.prototype.setItem` proxy because
  // that intrusion is invasive and would degrade perf for every unit
  // test + dev session. PCI protection already runs in two stronger
  // layers:
  //   1. The CI grep guard in `scripts/pci-grep.sh` scans the pay-sheet
  //      directory for any `localStorage|sessionStorage` occurrence.
  //   2. The unit-test coverage (`card-form.test.tsx` + `pay-sheet
  //      .test.tsx`) spies on `Storage.prototype.setItem` across the
  //      full lifecycle and fails on any write.
  // Removing the no-op keeps intent honest.

  if (loadError) {
    return (
      <div
        role="alert"
        data-testid="pay-sheet-card-load-error"
        className="space-y-4 rounded-md border border-destructive/40 bg-destructive/5 p-4"
      >
        <p className="text-body text-foreground">{loadError}</p>
        <Button
          type="button"
          variant="default"
          onClick={() => {
            setLoadError(null);
            setElementReady(false);
            setRemountKey((n) => n + 1);
          }}
          data-testid="pay-sheet-card-load-retry"
        >
          {t('retry.cta')}
        </Button>
      </div>
    );
  }

  return (
    <Elements key={remountKey} stripe={stripePromise} options={options}>
      <CardFormInner
        invoiceId={invoiceId}
        amountLabel={amountLabel}
        onReady={() => setElementReady(true)}
        onLoadError={(message) => setLoadError(message)}
        onSuccess={onSuccess}
        onFailure={onFailure}
        onRequiresAction={onRequiresAction}
        show={show}
      />
    </Elements>
  );
}

export default CardForm;
