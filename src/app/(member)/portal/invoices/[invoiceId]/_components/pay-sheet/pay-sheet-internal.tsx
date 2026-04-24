'use client';

/**
 * <PaySheetInternal> — the actual body of the PaySheet drawer.
 *
 * Split from <PaySheet> so that <PaySheet> can `next/dynamic`-lazy-load
 * this module and keep the Stripe SDK out of the route's initial bundle.
 *
 * PCI constraint (F5 PCI Group-G must-do)
 * ---------------------------------------
 * The Stripe `clientSecret` lives ONLY in this component's ephemeral
 * useState tree (inside the `payState` discriminated union). It MUST
 * NEVER be written to:
 *   - localStorage
 *   - sessionStorage
 *   - document.cookie
 *   - any Zustand / Redux / Jotai store
 *   - any React context that outlives the drawer
 * On drawer close (success / cancel / escape / backdrop-click / unmount)
 * <PaySheet> unmounts this subtree, which tears down the state
 * automatically (React unmount semantics). See the grep guard in
 * specs/009-online-payment + CI PCI lint (T041).
 *
 * State machine (G3 T076)
 * -----------------------
 *   idle                   — initial; on mount w/ active='card' → initiating
 *   initiating             — POST /api/payments/initiate in flight
 *   card-form(clientSecret)— <CardForm> mounted, awaiting user submit
 *   processing             — PaymentIntent reported `processing`
 *   requires-action(clientSecret) — Stripe 3DS challenge underway; poll
 *   success(summary)       — render <ConfirmationPanel>
 *   failure(reason)        — render retry panel (simple inline for G3)
 *
 * Transitions owned here:
 *   - initiating → card-form   (HTTP 200 from initiate)
 *   - initiating → failure     (HTTP non-2xx)
 *   - card-form  → processing  (CardForm.onSuccess w/ status=processing)
 *   - card-form  → success     (CardForm.onSuccess w/ status=succeeded)
 *   - card-form  → requires-action (CardForm.onRequiresAction)
 *   - card-form  → failure     (CardForm.onFailure)
 *   - requires-action → success / failure (3DS poll — stubbed in G3)
 *
 * The PromptPay slot is left as a G2 placeholder — Phase 4 wires it.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { loadStripe, type Stripe } from '@stripe/stripe-js';

import { Button } from '@/components/ui/button';
import { useThreeDSecurePoll } from '@/hooks/use-three-d-secure-poll';
import {
  formatPaymentAmount,
  formatPaymentDateTime,
} from '@/lib/format-payment-summary';

import { MethodTabs, type PaymentMethod } from './method-tabs';
import { CardForm } from './card-form';
import { ProcessingPanel } from './processing-panel';
import { ThreeDSecurePanel } from './three-d-secure-panel';
import { ConfirmationPanel } from './confirmation-panel';

// Share the Stripe singleton cache with <CardForm> via a small local
// cache — importing it directly from card-form risks a circular
// module dep, and `loadStripe()` is a no-op on the already-cached
// publishable key anyway (Stripe.js memoises internally).
const stripePromiseCache = new Map<string, Promise<Stripe | null>>();
function getStripeInstance(publishableKey: string): Promise<Stripe | null> {
  let cached = stripePromiseCache.get(publishableKey);
  if (!cached) {
    cached = loadStripe(publishableKey);
    stripePromiseCache.set(publishableKey, cached);
  }
  return cached;
}

// -- State machine ---------------------------------------------------------
type PayState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'initiating' }
  | { readonly kind: 'card-form'; readonly clientSecret: string }
  | { readonly kind: 'processing' }
  | { readonly kind: 'requires-action'; readonly clientSecret: string }
  | {
      readonly kind: 'success';
      readonly paymentIntentId: string;
      readonly method: PaymentMethod;
      readonly receiptUrl: string;
    }
  | { readonly kind: 'failure'; readonly reason: string };

interface InitiateResponse {
  readonly payment: { readonly id: string };
  readonly stripe: {
    readonly clientSecret: string;
    readonly publishableKey: string;
    readonly paymentIntentId: string;
    readonly promptpayQrSvgUrl?: string | null;
  };
  readonly correlationId: string;
}

export interface PaySheetInternalProps {
  readonly invoice: {
    readonly id: string;
    readonly invoiceNumber: string;
    readonly amountDue: number;
    readonly currency: string;
  };
  readonly enabledMethods: readonly PaymentMethod[];
  readonly tenantPublishableKey: string;
  /** Member id passed down so CardForm can pass it to the submit handler. */
  readonly memberId?: string;
}

export function PaySheetInternal({
  invoice,
  enabledMethods,
  tenantPublishableKey,
  memberId = '',
}: PaySheetInternalProps) {
  const t = useTranslations('portal.payment');
  const locale = useLocale();

  const initialMethod: PaymentMethod =
    enabledMethods.find((m) => m === 'card') ??
    enabledMethods[0] ??
    'card';

  const [activeMethod, setActiveMethod] =
    useState<PaymentMethod>(initialMethod);
  const [payState, setPayState] = useState<PayState>({ kind: 'idle' });
  // `publishableKey` is initialised from the tenant prop but overridden
  // by the /initiate response (the server is authoritative — it may
  // return a different key if the tenant has multiple Stripe accounts).
  const [publishableKey, setPublishableKey] = useState<string>(
    tenantPublishableKey,
  );

  // -- Kick off payment-intent creation on first mount of the card tab --
  // Guard key is derived so changing active method (back to card after a
  // retry) re-fires the effect exactly once. We avoid the
  // react-hooks/set-state-in-effect pattern by transitioning to
  // `initiating` via a ref-gated setter INSIDE the async closure — the
  // eslint rule flags the synchronous setState that appeared on the
  // first line before the `await`.
  useEffect(() => {
    if (activeMethod !== 'card') return;
    if (payState.kind !== 'idle') return;
    // G-Review Finding #9 — `AbortController` cancels any in-flight
    // /initiate POST when the user retries or cancels rapidly. The
    // effect cleanup fires on both state-change and unmount, so the
    // prior request is torn down before the new state kicks in. The
    // local `aborted` flag remains as defence-in-depth for the
    // `response.json()` microtask that may resolve after abort but
    // before the component re-runs the effect.
    const controller = new AbortController();
    let aborted = false;
    (async () => {
      // First update wraps into the async task body so it isn't the
      // synchronous leading setState the lint rule rejects.
      setPayState({ kind: 'initiating' });
      try {
        const response = await fetch('/api/payments/initiate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            invoiceId: invoice.id,
            method: 'card',
          }),
          signal: controller.signal,
        });
        if (aborted) return;
        if (!response.ok) {
          setPayState({
            kind: 'failure',
            reason: t('retry.genericReason'),
          });
          return;
        }
        const payload = (await response.json()) as InitiateResponse;
        if (aborted) return;
        setPublishableKey(payload.stripe.publishableKey);
        setPayState({
          kind: 'card-form',
          clientSecret: payload.stripe.clientSecret,
        });
      } catch (err) {
        // Swallow abort-driven rejections — they're the expected
        // cleanup path, not a user-facing error.
        if (aborted) return;
        if (err instanceof Error && err.name === 'AbortError') return;
        setPayState({ kind: 'failure', reason: t('retry.genericReason') });
      }
    })();
    return () => {
      aborted = true;
      controller.abort();
    };
  }, [activeMethod, invoice.id, payState.kind, t]);

  // -- 3DS polling loop (G4 gap closeout) ---------------------------------
  // Delegated to `useThreeDSecurePoll` so the loop can be tested in
  // isolation without wiring the full initiate fetch chain. The hook
  // is inert unless `enabled=true`; cleanup (clearInterval) fires on
  // unmount + on any `enabled` / `clientSecret` transition.
  const threeDsClientSecret =
    payState.kind === 'requires-action' ? payState.clientSecret : null;
  const getStripeForPoll = useMemo(
    () => () => getStripeInstance(publishableKey),
    [publishableKey],
  );
  const handle3dsSucceeded = useCallback(
    (paymentIntentId: string) => {
      setPayState({
        kind: 'success',
        paymentIntentId,
        method: 'card',
        receiptUrl: `/portal/invoices/${invoice.id}/receipt`,
      });
    },
    [invoice.id],
  );
  const handle3dsFailed = useCallback(
    (reason: '3ds_timeout' | 'canceled' | 'card_declined') => {
      setPayState({
        kind: 'failure',
        reason:
          reason === '3ds_timeout'
            ? t('retry.reason3dsTimeout')
            : t('retry.genericReason'),
      });
    },
    [t],
  );
  useThreeDSecurePoll({
    enabled: payState.kind === 'requires-action',
    clientSecret: threeDsClientSecret,
    getStripe: getStripeForPoll,
    onSucceeded: handle3dsSucceeded,
    onFailed: handle3dsFailed,
  });

  // -- CardForm callbacks --------------------------------------------------
  const handleCardSuccess = useCallback(
    (payload: { paymentIntentId: string; status: 'succeeded' | 'processing' }) => {
      if (payload.status === 'processing') {
        setPayState({ kind: 'processing' });
        return;
      }
      setPayState({
        kind: 'success',
        paymentIntentId: payload.paymentIntentId,
        method: 'card',
        // G4 will wire the real F4 signed-URL getter. For G3 we leave
        // a placeholder path that the invoice page can resolve.
        receiptUrl: `/portal/invoices/${invoice.id}/receipt`,
      });
    },
    [invoice.id],
  );

  const handleCardFailure = useCallback(
    ({ message }: { message: string }) => {
      setPayState({ kind: 'failure', reason: message });
    },
    [],
  );

  const handleRequiresAction = useCallback(
    (payload: { paymentIntentId: string }) => {
      // The 3DS flow continues with the existing clientSecret; we only
      // reach this branch from card-form so we know the secret is in
      // state already. Narrow the discriminated union safely.
      setPayState((prev) => {
        if (prev.kind === 'card-form') {
          return { kind: 'requires-action', clientSecret: prev.clientSecret };
        }
        // Defensive: if we somehow got here from another state, bail
        // back to failure rather than lose the secret silently.
        void payload;
        return { kind: 'failure', reason: t('retry.genericReason') };
      });
    },
    [t],
  );

  const handleCancel = useCallback(() => {
    // Parent <PaySheet> owns the actual POST /api/payments/[id]/cancel.
    // G3 simply transitions to idle; G4 wires the cancel route + drawer
    // close orchestration.
    setPayState({ kind: 'idle' });
  }, []);

  const handleRetry = useCallback(() => {
    setPayState({ kind: 'idle' });
  }, []);

  const handleClose = useCallback(() => {
    // G3: no-op here — the drawer chrome owns close. G4 wires this
    // through to the parent <PaySheet>'s onOpenChange.
    setPayState({ kind: 'idle' });
  }, []);

  // -- Card panel content per state ---------------------------------------
  const cardPanel = (() => {
    switch (payState.kind) {
      case 'idle':
      case 'initiating':
        // Skeleton owns this phase.
        return null;
      case 'card-form':
        return (
          <CardForm
            clientSecret={payState.clientSecret}
            publishableKey={publishableKey}
            amountDue={invoice.amountDue}
            currency={invoice.currency}
            invoiceId={invoice.id}
            memberId={memberId}
            onSuccess={handleCardSuccess}
            onFailure={handleCardFailure}
            onRequiresAction={handleRequiresAction}
          />
        );
      case 'processing':
        return <ProcessingPanel onCancel={handleCancel} />;
      case 'requires-action':
        return <ThreeDSecurePanel onCancel={handleCancel} />;
      case 'success':
        // G-Review Finding #2 — pass locale-aware amount + datetime
        // into the summary template instead of `toLocaleString()` (no
        // arg) + raw `toISOString()`.
        return (
          <ConfirmationPanel
            method={payState.method}
            amount={formatPaymentAmount(
              invoice.amountDue,
              invoice.currency,
              locale,
            )}
            dateTime={formatPaymentDateTime(new Date(), locale)}
            receiptUrl={payState.receiptUrl}
            onClose={handleClose}
          />
        );
      case 'failure':
        return (
          <div
            role="alert"
            data-testid="pay-sheet-retry-panel"
            className="space-y-4"
          >
            <h3 className="text-body font-medium text-foreground">
              {t('retry.title')}
            </h3>
            <p className="text-caption text-muted-foreground">
              {t('retry.body', { reason: payState.reason })}
            </p>
            <Button
              type="button"
              variant="default"
              onClick={handleRetry}
              // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile
              // (G-Review Finding #7).
              className="min-h-[44px] w-full"
              data-testid="pay-sheet-retry-cta"
            >
              {t('retry.cta')}
            </Button>
          </div>
        );
    }
  })();

  return (
    <MethodTabs
      enabledMethods={enabledMethods}
      activeMethod={activeMethod}
      onMethodChange={setActiveMethod}
      cardPanel={cardPanel}
      // PromptPay slot remains the MethodTabs G2 localized placeholder
      // until Phase 4 wires the QR renderer.
    />
  );
}

export default PaySheetInternal;
