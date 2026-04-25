'use client';

/**
 * `useThreeDSecurePoll` — G4 3DS-polling hook (gap closeout).
 *
 * When a Stripe PaymentIntent is in `requires_action` state the bank-
 * issued 3DS challenge runs in an iframe owned by Stripe.js. The SPA
 * host cannot listen for the challenge's completion directly, so we
 * poll `stripe.retrievePaymentIntent(clientSecret)` every 2 s until
 * the PI settles. A 5-minute cap protects the drawer from an
 * indefinitely-stuck state on an issuer outage.
 *
 * Contract
 * --------
 *   - `enabled=false` OR `clientSecret=null` → hook is inert (no timer,
 *     no calls).
 *   - On `succeeded` → `onSucceeded(paymentIntent.id)`.
 *   - On `canceled` → `onFailed('canceled')`.
 *   - On `requires_payment_method` (issuer declined 3DS) →
 *     `onFailed('card_declined')`.
 *   - On 150 iterations without a terminal status (≈5 min) →
 *     `onFailed('3ds_timeout')`.
 *   - Transient errors (network, missing Stripe instance) swallow and
 *     retry on the next tick; the 5-min cap still bounds the loop.
 *
 * Cleanup: `clearInterval` on unmount AND on every dep change (e.g.
 * `enabled` flipping to false, or a fresh `clientSecret`).
 */
import { useEffect } from 'react';
import type { Stripe } from '@stripe/stripe-js';

export const THREE_DS_POLL_INTERVAL_MS = 2_000;
export const THREE_DS_POLL_MAX_ITERATIONS = 150; // 2 s × 150 = 5 min

export type ThreeDSecureFailureReason =
  | 'canceled'
  | 'card_declined'
  | '3ds_timeout';

export interface UseThreeDSecurePollArgs {
  readonly enabled: boolean;
  readonly clientSecret: string | null;
  readonly getStripe: () => Promise<Stripe | null>;
  readonly onSucceeded: (paymentIntentId: string) => void;
  readonly onFailed: (reason: ThreeDSecureFailureReason) => void;
}

export function useThreeDSecurePoll({
  enabled,
  clientSecret,
  getStripe,
  onSucceeded,
  onFailed,
}: UseThreeDSecurePollArgs): void {
  useEffect(() => {
    if (!enabled || clientSecret === null) return;
    let iteration = 0;
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      iteration += 1;
      if (iteration > THREE_DS_POLL_MAX_ITERATIONS) {
        onFailed('3ds_timeout');
        return;
      }
      try {
        const stripe = await getStripe();
        if (cancelled || !stripe) return;
        const result = await stripe.retrievePaymentIntent(clientSecret);
        if (cancelled) return;
        const pi = result.paymentIntent;
        if (!pi) return;
        if (pi.status === 'succeeded') {
          onSucceeded(pi.id);
          return;
        }
        if (pi.status === 'canceled') {
          onFailed('canceled');
          return;
        }
        if (pi.status === 'requires_payment_method') {
          onFailed('card_declined');
          return;
        }
        // `processing` / `requires_action` → keep polling on the
        // next interval tick.
      } catch (e) {
        // Review I-11: log transient errors so a Stripe outage during
        // 3DS doesn't leave the user staring at the skeleton for the
        // full 5-min cap with no forensic trail. Dev-only console.warn
        // (no PII) — the next tick retries automatically.
        if (process.env.NODE_ENV !== 'production') {
          // eslint-disable-next-line no-console
          console.warn('[3ds-poll] transient retrievePaymentIntent error', {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    };

    const intervalId = setInterval(() => {
      void poll();
    }, THREE_DS_POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [enabled, clientSecret, getStripe, onSucceeded, onFailed]);
}
