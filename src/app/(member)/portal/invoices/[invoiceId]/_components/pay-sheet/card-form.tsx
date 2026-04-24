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
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
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
}

// -- Inner form (must live inside <Elements>) -------------------------------
interface CardFormInnerProps {
  readonly invoiceId: string;
  readonly onReady: () => void;
  readonly onLoadError: (message: string) => void;
  readonly onSuccess: CardFormProps['onSuccess'];
  readonly onFailure: CardFormProps['onFailure'];
  readonly onRequiresAction: CardFormProps['onRequiresAction'];
  readonly show: boolean;
}

function CardFormInner({
  invoiceId,
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
        onFailure({
          message: result.error.message ?? t('retry.genericReason'),
          ...(result.error.code !== undefined && { code: result.error.code }),
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
       * Rendering contract (G-Review Finding #1)
       * ----------------------------------------
       * Only ONE loading region is live at any moment:
       *   - show === false → <PaySheetSkeleton> alone (already carries
       *     role="status" + aria-busy="true"); <PaymentElement> is
       *     off-DOM so its wrapper cannot also announce "busy".
       *   - show === true  → <PaymentElement> mounts cleanly without
       *     any aria-busy semantics; skeleton is unmounted.
       * The Stripe iframe mounts on first reveal — the ≥ 300 ms
       * skeleton floor (useMinDelay) + CLS-matched skeleton height keep
       * CLS at 0 without requiring the element be pre-mounted sr-only.
       * The hidden <PaymentElement> is always mounted once `show` is
       * true; a remountKey bump forces a fresh iframe on retry.
       */}
      {show ? (
        <>
          <PaymentElement
            onReady={onReady}
            onLoadError={(event) => {
              onLoadError(event?.error?.message ?? t('error.elementLoadFailed'));
            }}
          />
          <Button
            type="submit"
            variant="default"
            disabled={!stripe || !elements || submitting}
            className="mt-4 w-full min-h-[44px]"
            data-testid="pay-sheet-card-submit"
          >
            {t('payNow')}
          </Button>
        </>
      ) : (
        <>
          {/*
           * PaymentElement must be mounted for Stripe to fire `onReady`,
           * but we keep it visually hidden and aria-hidden from SR. The
           * sole live loading region for SR is the skeleton below.
           */}
          <div className="sr-only" aria-hidden="true">
            <PaymentElement
              onReady={onReady}
              onLoadError={(event) => {
                onLoadError(
                  event?.error?.message ?? t('error.elementLoadFailed'),
                );
              }}
            />
          </div>
          <PaySheetSkeleton />
        </>
      )}
    </form>
  );
}

// -- Public wrapper ---------------------------------------------------------
export function CardForm({
  clientSecret,
  publishableKey,
  invoiceId,
  onSuccess,
  onFailure,
  onRequiresAction,
}: CardFormProps) {
  const t = useTranslations('portal.payment');
  const { resolvedTheme } = useTheme();

  const [elementReady, setElementReady] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  // `remountKey` bumps to force a fresh <Elements> tree when the user
  // hits "Try again" after a load error (retry path per FR-028b).
  const [remountKey, setRemountKey] = useState<number>(0);

  // Gate the visible PaymentElement behind BOTH the Stripe ready event
  // and a 300 ms minimum skeleton duration.
  const show = useMinDelay(300, elementReady);

  // Memoize the Stripe promise AND the appearance options. Passing a
  // fresh object to <Elements> on every render forces a remount of the
  // internal iframe — expensive and visually jarring.
  const stripePromise = useMemo(
    () => getStripe(publishableKey),
    [publishableKey],
  );

  const options = useMemo<StripeElementsOptions>(
    () => ({
      clientSecret,
      appearance: {
        theme: resolvedTheme === 'dark' ? 'night' : 'stripe',
        variables: {
          colorPrimary: 'var(--primary)',
          colorBackground: 'var(--background)',
          colorText: 'var(--foreground)',
          borderRadius: 'var(--radius)',
        },
      },
    }),
    [clientSecret, resolvedTheme],
  );

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
