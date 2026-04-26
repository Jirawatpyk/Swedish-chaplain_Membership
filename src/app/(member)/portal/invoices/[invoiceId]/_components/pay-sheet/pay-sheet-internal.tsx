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
 * PromptPay runs a parallel `PromptPayState` machine (`{idle, initiating,
 * qr, expired, failure}`) so the user can toggle between tabs without
 * losing the QR. See `PromptPayPanel` for the rendered surface.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

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
import { StatusPanel } from './status-panel';
import { ConfirmationPanel } from './confirmation-panel';
import { OrderSummary } from './order-summary';
import { SecurityFooter } from './security-footer';
import { useInitiatePayment } from './use-initiate-payment';
import type { TranslateFn } from './pay-sheet-translation-types';
import { CardPaymentRegion } from './card-payment-region';
import { PromptPayPanel } from './promptpay-panel';

// shared Stripe.js cache (deduplicated with `<CardForm>`).
// See `stripe-cache.ts` header for rationale + bounded LRU details.
import { getStripeInstance } from './stripe-cache';

// -- State machines --------------------------------------------------------
//
// Two parallel state machines drive the drawer body:
//   - `PayState` — the visible UI machine for the active payment
//     (drives card lifecycle + post-success/failure render)
//   - `PromptPayState` — the PromptPay-tab machine (initiate fetch,
//     QR rendered, countdown expired, recoverable failure)
//
// Lifting both to named exported types lets unit tests narrow on
// `kind` and lets the `handlePromptPayFailed` extracted helper
// (testable in isolation) consume the same union.
export type PromptPayState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'initiating' }
  | {
      readonly kind: 'qr';
      readonly clientSecret: string;
      readonly qrSvgUrl: string;
      readonly expirySeconds: number;
    }
  | { readonly kind: 'expired' }
  | { readonly kind: 'failure'; readonly reason: string };

/**
 * Pure transition function for the PromptPay PI poll-failure event.
 * Extracted so a unit test can assert the `card_declined` → failure
 * branch without rendering the full PaySheetInternal subtree.
 *
 * `card_declined` indicates Stripe rejected the PromptPay charge
 * (e.g. issuer block, amount mismatch on the rail) — the user needs
 * a proper failure panel with a localized reason; a blind
 * "QR expired — Refresh" prompt would mislead them into infinite retry.
 *
 * `canceled` and `3ds_timeout` indicate the QR scan window expired
 * or the system canceled the PI — the `expired` panel + Refresh CTA
 * is the correct UX.
 */
export function nextPromptPayStateOnPollFailure(
  reason: '3ds_timeout' | 'canceled' | 'card_declined',
  cardDeclinedMessage: string,
): PromptPayState {
  if (reason === 'card_declined') {
    return { kind: 'failure', reason: cardDeclinedMessage };
  }
  return { kind: 'expired' };
}

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

// `InitiateResponse` moved to `./use-initiate-payment.ts` (audit
// 2026-04-26 round-2 #1 refactor — extracted with the fetch hook).

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
   * Callback requesting the drawer to close WITHOUT canceling the
   * PaymentIntent. Fired from ConfirmationPanel (payment already
   * settled — nothing to cancel) and any other "dismiss without
   * abandoning" path. Parent keeps the cache so a reopen reuses the
   * same PaymentIntent (rate-limit friendly).
   */
  readonly onRequestClose?: () => void;
  /**
   * Callback for EXPLICIT cancellation paths — ProcessingPanel /
   * 3DS "Cancel payment" buttons. Parent fires the
   * /api/payments/{id}/cancel API, clears its cached initiate, and
   * closes the drawer. Subsequent reopens initiate a fresh
   * PaymentIntent (audit 2026-04-25 finding #2 — previous code just
   * transitioned to `idle`, which re-mounted CardForm with the
   * just-canceled clientSecret).
   */
  readonly onExplicitCancel?: () => void;
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
  onExplicitCancel,
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

  // Phase 4 / T091 — independent retry counter for the PromptPay tab.
  // Bumped by the PromptPayPanel's "Refresh QR" CTA so the parent's
  // card-tab initiate cycle is not perturbed when the user is on
  // PromptPay. The PromptPay initiate is gated on `activeMethod ===
  // 'promptpay'` — switching tabs doesn't fire two parallel fetches.
  const [promptpayRetryCount, setPromptpayRetryCount] = useState(0);
  // PromptPay payState is held in a parallel state slot. This avoids
  // collapsing card + promptpay into one machine and lets the user
  // toggle between tabs without losing the QR. We do NOT persist this
  // across drawer reopens — fresh QR per drawer-open is acceptable for
  // PromptPay (no rate-limit pressure equivalent to the card flow,
  // because PromptPay PIs are server-confirmed and can resume).
  const [promptpayState, setPromptpayState] = useState<PromptPayState>({
    kind: 'idle',
  });

  // Keep latest callback/translator refs so the initiate effect does
  // not re-fire on parent re-render (inline arrow props). Avoids the
  // `onInitiateResolved in deps → effect re-runs → fetch abort loop`
  // class of bug (audit 2026-04-25 finding #4).
  const onInitiateResolvedRef = useRef(onInitiateResolved);
  const onPaymentSettledRef = useRef(onPaymentSettled);
  const tRef = useRef<TranslateFn>(t);
  useEffect(() => {
    onInitiateResolvedRef.current = onInitiateResolved;
    onPaymentSettledRef.current = onPaymentSettled;
    tRef.current = t;
  }, [onInitiateResolved, onPaymentSettled, t]);

  // Fire `onPaymentSettled` exactly once per PaymentIntent lifecycle.
  // Reset on every fresh initiate (new PI) AND on retry so the parent
  // cache is invalidated correctly on the failure → retry → success
  // path (audit 2026-04-25 finding #1).
  const settledRef = useRef(false);
  useEffect(() => {
    if (settledRef.current) return;
    if (payState.kind === 'success' || payState.kind === 'failure') {
      settledRef.current = true;
      onPaymentSettledRef.current?.();
    }
  }, [payState.kind]);
  // `publishableKey` is initialised from the cached initiate response
  // when available, else the tenant prop. The /initiate response is
  // authoritative when a new fetch runs — it may return a different
  // key if the tenant has multiple Stripe accounts.
  const [publishableKey, setPublishableKey] = useState<string>(
    initialInitiate?.publishableKey ?? tenantPublishableKey,
  );

  // -- Initiate fetch lifecycle delegated to `useInitiatePayment` -----
  // Audit 2026-04-26 round-2 #1 refactor: 110-line in-place effect
  // extracted to `./use-initiate-payment.ts`. The hook owns
  // AbortController + StrictMode safety + Idempotency-Key dedupe; this
  // file owns the UI state machine + outcome dispatch.
  useInitiatePayment({
    // R5 fix: `initialInitiate` is read via ref inside the hook (not in
    // deps) — see `use-initiate-payment.ts` for full rationale.
    enabled: activeMethod === 'card',
    invoiceId: invoice.id,
    initialInitiate,
    retryCount,
    translateRef: tRef,
    onInitiating: () => setPayState({ kind: 'initiating' }),
    onSuccess: (payload) => {
      // Reset terminal-state guard for the fresh PaymentIntent (audit
      // 2026-04-25 finding #1).
      settledRef.current = false;
      setPublishableKey(payload.stripe.publishableKey);
      setPayState({
        kind: 'card-form',
        clientSecret: payload.stripe.clientSecret,
      });
      onInitiateResolvedRef.current?.({
        clientSecret: payload.stripe.clientSecret,
        publishableKey: payload.stripe.publishableKey,
        paymentIntentId: payload.stripe.paymentIntentId,
        paymentDbId: payload.payment.id,
      });
    },
    onFailure: (reason) => setPayState({ kind: 'failure', reason }),
  });

  // -- PromptPay initiate cycle (Phase 4 / T091) --------------------------
  // Independent of the card-tab `useInitiatePayment` above. Fires only
  // when the user is on the PromptPay tab AND we don't already have a
  // QR payload in `promptpayState`. The Refresh CTA bumps
  // `promptpayRetryCount` to force a re-initiate.
  useInitiatePayment({
    // Fire only when state is `idle` — explicitly excludes
    // `initiating` (in-flight de-dupe), `qr` (already loaded),
    // `failure`, and `expired` (all require an explicit user-driven
    // Refresh CTA via `handlePromptPayRefresh` which resets to
    // `idle` and bumps `promptpayRetryCount`). Any looser predicate
    // re-fires on parent re-render and burns the rate-limit budget
    // on a failed-attempt loop.
    enabled:
      activeMethod === 'promptpay' &&
      enabledMethods.includes('promptpay') &&
      promptpayState.kind === 'idle',
    invoiceId: invoice.id,
    method: 'promptpay',
    initialInitiate: null,
    retryCount: promptpayRetryCount,
    translateRef: tRef,
    onInitiating: () => setPromptpayState({ kind: 'initiating' }),
    onSuccess: (payload) => {
      const qrSvgUrl = payload.stripe.promptpayQrSvgUrl ?? null;
      if (qrSvgUrl === null) {
        // Either Stripe did not return a QR (server-confirm path failed
        // silently) or the use-case resumed an existing pending card PI
        // for the same actor+invoice. Surface a recoverable failure —
        // the user can click Refresh to bump retry + try again.
        setPromptpayState({
          kind: 'failure',
          reason: tRef.current('promptpay.loadFailed'),
        });
        return;
      }
      setPromptpayState({
        kind: 'qr',
        clientSecret: payload.stripe.clientSecret,
        qrSvgUrl,
        // Pin the tenant-configured QR expiry from the server
        // from server response; fallback 900s if older API still in flight.
        expirySeconds: payload.stripe.promptpayQrExpirySeconds ?? 900,
      });
    },
    onFailure: (reason) => setPromptpayState({ kind: 'failure', reason }),
  });

  // PromptPay PI status polling. Same `stripe.retrievePaymentIntent`
  // mechanism used for 3DS — when the PI flips to `succeeded` we
  // transition the outer payState to success. Inert unless we have a
  // QR clientSecret in hand.
  const promptpayClientSecret =
    promptpayState.kind === 'qr' ? promptpayState.clientSecret : null;
  const getStripeForPromptPayPoll = useMemo(
    () => () => getStripeInstance(publishableKey),
    [publishableKey],
  );
  const handlePromptPaySucceeded = useCallback(
    (paymentIntentId: string) => {
      setPayState({
        kind: 'success',
        paymentIntentId,
        method: 'promptpay',
        receiptUrl: `/portal/invoices/${invoice.id}/receipt`,
      });
    },
    [invoice.id],
  );
  const handlePromptPayFailed = useCallback(
    (reason: '3ds_timeout' | 'canceled' | 'card_declined') => {
      setPromptpayState(
        nextPromptPayStateOnPollFailure(
          reason,
          tRef.current('retry.reasonCardDeclined'),
        ),
      );
    },
    [],
  );
  useThreeDSecurePoll({
    enabled: promptpayState.kind === 'qr',
    clientSecret: promptpayClientSecret,
    getStripe: getStripeForPromptPayPoll,
    onSucceeded: handlePromptPaySucceeded,
    onFailed: handlePromptPayFailed,
  });

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
    // Processing / 3DS "Cancel payment" = explicit abandon. Parent
    // fires /api/payments/{id}/cancel, clears cache, closes drawer.
    // Falls back to plain close if parent did not wire onExplicitCancel
    // (older callers).
    if (onExplicitCancel) {
      onExplicitCancel();
    } else {
      onRequestClose?.();
    }
  }, [onExplicitCancel, onRequestClose]);

  const handlePromptPayRefresh = useCallback(() => {
    // Force a fresh PromptPay PI: clear the local QR state and bump
    // the retry counter. The initiate effect's cleanup aborts any
    // in-flight fetch from the previous attempt.
    setPromptpayState({ kind: 'idle' });
    setPromptpayRetryCount((n) => n + 1);
  }, []);

  // -- PromptPay panel content per state ---------------------------------
  const promptPayPanel = (() => {
    switch (promptpayState.kind) {
      case 'idle':
      case 'initiating':
        return <PaySheetSkeleton />;
      case 'qr':
        return (
          <PromptPayPanel
            qrSvgUrl={promptpayState.qrSvgUrl}
            amountSatang={invoice.amountDue}
            currency={invoice.currency}
            expirySeconds={promptpayState.expirySeconds}
            onRefresh={handlePromptPayRefresh}
            // Convert silent QR load failures (404, CSP block) into
            // the recoverable failure panel — user sees the localized
            // loadFailed message + Refresh CTA instead of a blank
            // box with a ticking countdown.
            onLoadError={() =>
              setPromptpayState({
                kind: 'failure',
                reason: tRef.current('promptpay.loadFailed'),
              })
            }
            status="pending"
          />
        );
      case 'expired':
        return (
          <PromptPayPanel
            qrSvgUrl=""
            amountSatang={invoice.amountDue}
            currency={invoice.currency}
            onRefresh={handlePromptPayRefresh}
            status="expired"
          />
        );
      case 'failure':
        return (
          <InlineAlert
            tone="destructive"
            data-testid="pay-sheet-promptpay-failure"
            className="space-y-4"
            role="alert"
            aria-live="assertive"
            aria-atomic="true"
          >
            <InlineAlertTitle>{t('retry.title')}</InlineAlertTitle>
            <InlineAlertDescription>
              {t('retry.body', { reason: promptpayState.reason })}
            </InlineAlertDescription>
            <Button
              type="button"
              variant="default"
              onClick={handlePromptPayRefresh}
              className="min-h-[44px] w-full"
              data-testid="pay-sheet-promptpay-retry"
            >
              {t('promptpay.refresh')}
            </Button>
          </InlineAlert>
        );
    }
  })();

  const handleRetry = useCallback(() => {
    // Reset the terminal-state guard so the NEXT settlement
    // (retry-succeeds path) fires `onPaymentSettled` to the parent.
    // Defense-in-depth with the initiate-success reset
    // (audit 2026-04-25 finding #1).
    settledRef.current = false;
    // Bump `retryCount` to re-arm the initiate effect; the effect's
    // cleanup will abort any in-flight fetch from the previous attempt.
    setPayState({ kind: 'idle' });
    setRetryCount((n) => n + 1);
  }, []);

  const handleClose = useCallback(() => {
    // Reset local payState AND request the parent to close the drawer.
    // Without the parent-close request, the drawer stays open on the
    // `idle` state which immediately re-triggers the initiate useEffect
    // → skeleton → card form again (user sees "bounced back to payment
    // form"; T082 empirical submit test 2026-04-24).
    //
    // R5 I5 (2026-04-25): also reset PromptPay state + the settled
    // guard. PaySheetInternal is mounted ONCE per invoice-page life
    // (not per drawer cycle) — `hasOpened` latches it true. Without
    // these resets, reopening the drawer after a settled payment
    // would land on stale `payState='success'` / `promptpayState`
    // and the post-mount `useEffect([payState.kind])` would re-fire
    // `onPaymentSettled` → parent re-runs `router.refresh()`.
    setPayState({ kind: 'idle' });
    setPromptpayState({ kind: 'idle' });
    settledRef.current = false;
    onRequestClose?.();
  }, [onRequestClose]);

  // -- Card panel content per state ---------------------------------------
  const cardPanel = (() => {
    switch (payState.kind) {
      case 'idle':
      case 'initiating':
        // No clientSecret yet — skeleton only. CardForm can't mount
        // until the initiate fetch returns a secret.
        return <PaySheetSkeleton />;
      case 'card-form':
        // Audit 2026-04-26 round-2 #1 refactor — extracted to
        // `<CardPaymentRegion>`. See that component for the single-
        // mount + skeleton-overlay invariant.
        return (
          <CardPaymentRegion
            clientSecret={payState.clientSecret}
            publishableKey={publishableKey}
            amountDue={invoice.amountDue}
            currency={invoice.currency}
            invoiceId={invoice.id}
            memberId={memberId}
            cardFormVisible={cardFormVisible}
            onSuccess={handleCardSuccess}
            onFailure={handleCardFailure}
            onRequiresAction={handleRequiresAction}
            onVisible={() => setCardFormVisible(true)}
          />
        );
      case 'processing':
        return <StatusPanel kind="processing" onCancel={handleCancel} />;
      case 'requires-action':
        return <StatusPanel kind="three-d-secure" onCancel={handleCancel} />;
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
          promptPayPanel={promptPayPanel}
        />
      ) : (
        cardPanel
      )}
      {showFooter ? <SecurityFooter /> : null}
    </div>
  );
}

export default PaySheetInternal;
