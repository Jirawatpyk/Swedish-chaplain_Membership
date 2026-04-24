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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { loadStripe, type Stripe } from '@stripe/stripe-js';

import { Button } from '@/components/ui/button';
import {
  InlineAlert,
  InlineAlertDescription,
  InlineAlertTitle,
} from '@/components/ui/inline-alert';
import { useThreeDSecurePoll } from '@/hooks/use-three-d-secure-poll';
import { formatPaymentDateTime } from '@/lib/format-payment-summary';
import { formatSatangThb } from '@/app/(member)/portal/invoices/_utils/format';

import { PaySheetSkeleton } from '@/components/payments/pay-sheet-skeleton';

import { MethodTabs, type PaymentMethod } from './method-tabs';
import { CardForm } from './card-form';
import { ProcessingPanel } from './processing-panel';
import { ThreeDSecurePanel } from './three-d-secure-panel';
import { ConfirmationPanel } from './confirmation-panel';
import { OrderSummary } from './order-summary';
import { SecurityFooter } from './security-footer';

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

/**
 * Cached initiate response, lifted to the PaySheet parent so that
 * Radix Sheet's Portal unmount/remount on close/reopen doesn't throw
 * the Stripe PaymentIntent away + re-fire POST /api/payments/initiate
 * (which quickly exhausts the rate-limit budget — T082 UX feedback
 * 2026-04-24). The parent owns a ref/state pair; PaySheetInternal
 * reads it as `initialInitiate` and calls `onInitiateResolved` when
 * it fetches a fresh one after a retry / card cancel.
 */
export interface CachedInitiate {
  readonly clientSecret: string;
  readonly publishableKey: string;
  readonly paymentIntentId: string;
  /**
   * Our DB-side `payments.id` row — needed by the parent's
   * close-with-stale-cleanup path (FR-025c / W2): when the user
   * dismisses the drawer without paying, we call
   * POST /api/payments/{paymentDbId}/cancel server-side to cancel
   * the Stripe PaymentIntent so it does NOT linger until Stripe's
   * own ~1-hour auto-expiry.
   */
  readonly paymentDbId: string;
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
  /**
   * Parent-cached initiate response. When provided, <PaySheetInternal>
   * skips the initial POST /api/payments/initiate fetch and uses the
   * cached clientSecret. This preserves PCI SAQ-A because the cache
   * lives in React ref / state (ephemeral), never in persistent
   * browser storage.
   */
  readonly initialInitiate?: CachedInitiate | null;
  /**
   * Callback invoked whenever <PaySheetInternal> fetches a fresh
   * initiate response (first mount without cache, or after retry).
   * The parent uses it to populate / refresh the cache.
   */
  readonly onInitiateResolved?: (result: CachedInitiate) => void;
  /**
   * Callback invoked when the PaymentIntent reaches a terminal state
   * (success or failure). The parent uses it to INVALIDATE its
   * cached initiate so the next drawer-open creates a fresh
   * PaymentIntent — Stripe Elements rejects succeeded/canceled
   * clientSecrets with a 400 on `elements/sessions` (T082 empirical
   * submit test 2026-04-24).
   */
  readonly onPaymentSettled?: () => void;
  /**
   * Callback requesting the drawer to close. Fired from the
   * ConfirmationPanel auto-close countdown + user-initiated close
   * CTAs in processing / 3DS / retry panels. Previously these only
   * reset local `payState` to 'idle' which LEFT THE DRAWER OPEN and
   * immediately re-fired the initiate useEffect — producing a
   * "bounced back to payment form after confirmation" regression
   * (T082 empirical submit test 2026-04-24).
   */
  readonly onRequestClose?: () => void;
}

export function PaySheetInternal({
  invoice,
  enabledMethods,
  tenantPublishableKey,
  memberId = '',
  initialInitiate = null,
  onInitiateResolved,
  onPaymentSettled,
  onRequestClose,
}: PaySheetInternalProps) {
  const t = useTranslations('portal.payment');
  const locale = useLocale();

  const initialMethod: PaymentMethod =
    enabledMethods.find((m) => m === 'card') ??
    enabledMethods[0] ??
    'card';

  const [activeMethod, setActiveMethod] =
    useState<PaymentMethod>(initialMethod);
  // `cardFormVisible` — set by <CardForm> once its PaymentElement is
  // fully painted (Stripe onReady + 300ms skeleton floor). Used to
  // gate the trust-signal footer so it does not show below the
  // skeleton (T082 UX feedback 2026-04-24: "skeleton ค้างนาน เห็น
  // Encrypted · Secured by Stripe ข้างหลัง"). Starts `true` when the
  // parent passes a cached initiate — the PaymentElement re-uses the
  // cached iframe and is already visible on mount.
  const [cardFormVisible, setCardFormVisible] = useState<boolean>(
    initialInitiate !== null,
  );
  // When the parent supplies a cached initiate response, skip the
  // `idle → initiating → card-form` bootstrap and start directly in
  // `card-form` with the cached clientSecret.
  const [payState, setPayState] = useState<PayState>(() =>
    initialInitiate !== null
      ? { kind: 'card-form', clientSecret: initialInitiate.clientSecret }
      : { kind: 'idle' },
  );
  // T082b — re-arm counter for manual retry after failure. Bumped in
  // `handleRetry`; consumed by the initiate useEffect dep array.
  const [retryCount, setRetryCount] = useState(0);
  // T082b — flight guard against React's StrictMode double-invoke +
  // the idle→initiating state transition re-firing the effect.
  const initiateInFlightRef = useRef(false);

  // Fire `onPaymentSettled` exactly once when the PayState enters a
  // terminal kind (success or failure). Guard with a ref so the
  // parent cache is invalidated only once per drawer session.
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (payState.kind === 'success' || payState.kind === 'failure') {
      settledRef.current = true;
      onPaymentSettled?.();
    }
  }, [payState.kind, onPaymentSettled]);
  // `publishableKey` is initialised from the cached initiate response
  // when available, else the tenant prop. The /initiate response is
  // authoritative when a new fetch runs — it may return a different
  // key if the tenant has multiple Stripe accounts.
  const [publishableKey, setPublishableKey] = useState<string>(
    initialInitiate?.publishableKey ?? tenantPublishableKey,
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
    // Skip the fetch when the parent provided a cached initiate
    // response AND we are still on the first attempt (no retry yet).
    // On retry (`retryCount > 0`) we always re-fetch because the
    // previous PaymentIntent may have been consumed / canceled.
    if (initialInitiate !== null && retryCount === 0) return;
    // T082b empirical E2E discovery (2026-04-24): `payState.kind` MUST
    // NOT be in the dep array. Previously the effect transitioned
    // `idle → initiating` via `setPayState`, the state change re-
    // triggered the effect, the cleanup immediately aborted the fetch,
    // and the component stuck in `initiating` forever — surfaced as
    // the G2 placeholder "Card form coming in G3" via the cardPanel
    // null-fallback in MethodTabs. Use a ref to guard against double-
    // firing on retry (retry sets state back to `idle`, then bumps
    // `retryCount` to re-arm this effect).
    if (initiateInFlightRef.current) return;
    initiateInFlightRef.current = true;
    // T082b empirical discovery #3 (2026-04-24): dropped BOTH the
    // `AbortController` (StrictMode double-invoke abort loop) AND
    // the closure `cancelled` flag (StrictMode's cleanup would set
    // cancelled=true on invocation-1, invocation-2 early-returned
    // on inFlightRef, then the invocation-1 fetch response arrived
    // and its `if (cancelled) return` dropped the setState → stuck
    // in `initiating` forever). The `inFlightRef` guard alone is
    // enough for StrictMode; on real unmount (drawer close via ?pay=
    // toggle or route change), React 19 silently no-ops setState
    // calls on unmounted components (dev warning only, no crash).
    // Stripe's `Idempotency-Key` (invoice + attempt) protects
    // against any rapid-retry overlap.
    (async () => {
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
        });
        if (!response.ok) {
          // T082 UX feedback 2026-04-24: map status → user-visible reason
          // so rate-limit / auth / server errors surface distinctly
          // instead of the generic "Payment could not be completed".
          let reason: string;
          if (response.status === 429) {
            // Prefer the server's Retry-After header (seconds) when set.
            const retryAfter = response.headers.get('Retry-After');
            const seconds = retryAfter ? Number.parseInt(retryAfter, 10) : NaN;
            reason = Number.isFinite(seconds) && seconds > 0
              ? t('retry.reasonRateLimitedWithSeconds', { seconds })
              : t('retry.reasonRateLimited');
          } else if (response.status === 401 || response.status === 403) {
            reason = t('retry.reasonAuth');
          } else if (response.status >= 500) {
            reason = t('retry.reasonServer');
          } else {
            reason = t('retry.genericReason');
          }
          setPayState({ kind: 'failure', reason });
          return;
        }
        const payload = (await response.json()) as InitiateResponse;
        setPublishableKey(payload.stripe.publishableKey);
        setPayState({
          kind: 'card-form',
          clientSecret: payload.stripe.clientSecret,
        });
        // Hoist the fresh initiate response up so the parent cache
        // keeps the drawer reusable across close/reopen without a
        // new fetch.
        onInitiateResolved?.({
          clientSecret: payload.stripe.clientSecret,
          publishableKey: payload.stripe.publishableKey,
          paymentIntentId: payload.stripe.paymentIntentId,
          paymentDbId: payload.payment.id,
        });
      } catch {
        setPayState({ kind: 'failure', reason: t('retry.reasonNetwork') });
      } finally {
        initiateInFlightRef.current = false;
      }
    })();
    // No cleanup — React 19 no-ops setState on unmounted components.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeMethod, invoice.id, retryCount, t]);

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
    // T082b — bump `retryCount` to re-arm the initiate effect (idle
    // state alone no longer triggers it because the effect deps list
    // excludes `payState.kind` to avoid the mount-time abort loop).
    setPayState({ kind: 'idle' });
    setRetryCount((n) => n + 1);
  }, []);

  const handleClose = useCallback(() => {
    // Reset local payState AND request the parent to close the drawer.
    // Without the parent-close request, the drawer stays open on the
    // `idle` state which immediately re-triggers the initiate useEffect
    // → skeleton → card form again (user sees "bounced back to payment
    // form"; T082 empirical submit test 2026-04-24).
    setPayState({ kind: 'idle' });
    onRequestClose?.();
  }, [onRequestClose]);

  // -- Card panel content per state ---------------------------------------
  const cardPanel = (() => {
    switch (payState.kind) {
      case 'idle':
      case 'initiating':
      case 'card-form': {
        // Simple conditional render — NOT absolute overlay (T082 UX
        // feedback 2026-04-24: absolute + inset-0 collapsed the
        // parent's intrinsic height to 0, making the drawer body
        // shorter than the viewport + producing a scrollbar + cut-off
        // content). Skeleton renders in normal flow until CardForm
        // reports it's visible; then we swap to CardForm (whose own
        // opacity transition smooths the swap-in).
        const showCardForm = payState.kind === 'card-form';
        if (!showCardForm || !cardFormVisible) {
          // Mount CardForm off-screen (aria-hidden) so Stripe can
          // still fire `onReady` + drive `onVisible`. Visible region
          // shows ONLY the skeleton in normal flow.
          return (
            <>
              <PaySheetSkeleton />
              {showCardForm ? (
                <div className="sr-only" aria-hidden="true">
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
                    onVisible={() => setCardFormVisible(true)}
                  />
                </div>
              ) : null}
            </>
          );
        }
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
            onVisible={() => setCardFormVisible(true)}
          />
        );
      }
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
            amount={formatSatangThb(
              BigInt(Math.round(invoice.amountDue)),
              locale,
            )}
            dateTime={formatPaymentDateTime(new Date(), locale)}
            receiptUrl={payState.receiptUrl}
            onClose={handleClose}
          />
        );
      case 'failure':
        return (
          // FR-028j — failure must be announced to SR via aria-live.
          // `role="alert"` (which InlineAlert sets) is implicitly
          // assertive; we keep it but ALSO pin aria-live="assertive" +
          // aria-atomic for AT compatibility across NVDA/VoiceOver/
          // TalkBack (G-Review audit 2026-04-24).
          <InlineAlert
            tone="destructive"
            data-testid="pay-sheet-retry-panel"
            className="space-y-4"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <InlineAlertTitle>{t('retry.title')}</InlineAlertTitle>
            <InlineAlertDescription>
              {t('retry.body', { reason: payState.reason })}
            </InlineAlertDescription>
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
          </InlineAlert>
        );
    }
  })();

  // Hide summary + security footer on success/processing/3DS states so
  // the confirmation / processing panels get the full visual focus.
  const showSummary =
    payState.kind !== 'success' &&
    payState.kind !== 'processing' &&
    payState.kind !== 'requires-action';

  // SecurityFooter should not appear until the card form is actually
  // visible — otherwise the "Encrypted · PCI-DSS compliant / Secured
  // by Stripe / We accept Visa..." strip shows beneath the skeleton on
  // first load and makes the skeleton feel "stuck" because the footer
  // implies content is loaded (T082 UX feedback 2026-04-24).
  const showFooter = showSummary && cardFormVisible;

  // In terminal / transitional states (success / processing / 3DS /
  // failure), the MethodTabs chrome adds noise — the user is no longer
  // choosing a method. Render the branch panel directly so the
  // ConfirmationPanel etc. get the full drawer body.
  const showChrome = showSummary; // same gate as OrderSummary
  return (
    <div className="space-y-4">
      {showSummary ? (
        <OrderSummary
          invoiceNumber={invoice.invoiceNumber}
          amountDue={invoice.amountDue}
          currency={invoice.currency}
        />
      ) : null}
      {showChrome ? (
        <MethodTabs
          enabledMethods={enabledMethods}
          activeMethod={activeMethod}
          onMethodChange={setActiveMethod}
          cardPanel={cardPanel}
          // PromptPay slot remains the MethodTabs G2 localized placeholder
          // until Phase 4 wires the QR renderer.
        />
      ) : (
        cardPanel
      )}
      {showFooter ? <SecurityFooter /> : null}
    </div>
  );
}

export default PaySheetInternal;
