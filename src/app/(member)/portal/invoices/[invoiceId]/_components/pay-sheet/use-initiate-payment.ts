'use client';

/**
 * `useInitiatePayment` — extracted from `pay-sheet-internal.tsx` (audit
 * 2026-04-26 round-2 #1 refactor — split 648-line file into orchestrator
 * + this hook + the card-panel renderer).
 *
 * Owns the POST /api/payments/initiate fetch lifecycle for the card
 * payment method:
 *
 *   - StrictMode double-invoke safety via AbortController + cancelled flag
 *   - Backend Idempotency-Key (`inv-{invoiceId}-attempt-{seq}`) dedupes at
 *     Stripe, so duplicate fetches do NOT create duplicate PaymentIntents
 *   - Retry safety: bumping `retryCount` triggers cleanup which aborts
 *     prior fetch — no in-flight-flag deadlock
 *   - Unmount safety: cleanup aborts + flips `cancelled` so late-arriving
 *     resolves no longer mutate parent state
 *   - Cached-initiate skip: when parent supplies `initialInitiate` AND
 *     `retryCount === 0`, the fetch is skipped and the cached secret is
 *     reused (T082 UX feedback — preserves rate-limit budget across
 *     close/reopen drawer cycles)
 *
 * The hook produces a small set of imperative state setters that the
 * orchestrator consumes — it does NOT own the `payState` enum (that
 * stays in pay-sheet-internal as the source of truth for the visible UI
 * state machine).
 */

import { useEffect, useRef } from 'react';
// Audit 2026-04-26 round-2 self-review #R2-A8: ref updates run inside
// useEffect (idiomatic) instead of direct render-phase write — the
// behaviour is identical (refs aren't part of React's reconciler), but
// the useEffect form satisfies React strict-mode auditors + future
// lint rules (e.g. react-compiler) that flag render-phase mutations.

import type { CachedInitiate } from './pay-sheet-internal';
import type { TranslateFn } from './pay-sheet-translation-types';

export interface InitiateResponse {
  readonly payment: { readonly id: string };
  readonly stripe: {
    readonly clientSecret: string;
    readonly publishableKey: string;
    readonly paymentIntentId: string;
    readonly promptpayQrSvgUrl?: string | null;
  };
  readonly correlationId: string;
}

export interface UseInitiatePaymentOptions {
  readonly enabled: boolean;
  readonly invoiceId: string;
  readonly initialInitiate: CachedInitiate | null;
  readonly retryCount: number;
  /** Stable translator ref so locale changes don't re-fire the effect. */
  readonly translateRef: React.MutableRefObject<TranslateFn>;
  readonly onInitiating: () => void;
  readonly onSuccess: (payload: InitiateResponse) => void;
  readonly onFailure: (reason: string) => void;
}

export function useInitiatePayment(opts: UseInitiatePaymentOptions): void {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const {
    enabled,
    invoiceId,
    initialInitiate,
    retryCount,
  } = opts;

  useEffect(() => {
    if (!enabled) return;
    if (initialInitiate !== null && retryCount === 0) return;

    const abortController = new AbortController();
    let cancelled = false;
    optsRef.current.onInitiating();

    (async () => {
      try {
        const response = await fetch('/api/payments/initiate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoiceId, method: 'card' }),
          signal: abortController.signal,
        });
        if (cancelled) return;
        if (!response.ok) {
          const t = optsRef.current.translateRef.current;
          let reason: string;
          if (response.status === 429) {
            const retryAfter = response.headers.get('Retry-After');
            const seconds = retryAfter
              ? Number.parseInt(retryAfter, 10)
              : NaN;
            reason =
              Number.isFinite(seconds) && seconds > 0
                ? t('retry.reasonRateLimitedWithSeconds', { seconds })
                : t('retry.reasonRateLimited');
          } else if (response.status === 401 || response.status === 403) {
            reason = t('retry.reasonAuth');
          } else if (response.status >= 500) {
            reason = t('retry.reasonServer');
          } else {
            reason = t('retry.genericReason');
          }
          optsRef.current.onFailure(reason);
          return;
        }
        const payload = (await response.json()) as InitiateResponse;
        if (cancelled) return;
        optsRef.current.onSuccess(payload);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === 'AbortError') return;
        optsRef.current.onFailure(
          optsRef.current.translateRef.current('retry.reasonNetwork'),
        );
      }
    })();

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, [enabled, invoiceId, initialInitiate, retryCount]);
}
