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
 *   - Server-side dedupe: the `/api/payments/initiate` route's
 *     `findPendingByInvoiceAndActor` resume path returns the same
 *     clientSecret for repeat calls within the pending-PI window;
 *     additionally the use-case stamps Stripe `Idempotency-Key`
 *     (`inv-{invoiceId}-attempt-{seq}`) on createPaymentIntent so
 *     concurrent retries with the same sequence collapse to ONE PI.
 *     Client does NOT send the header — the server owns key generation.
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
    readonly promptpayQrExpirySeconds?: number;
  };
  readonly correlationId: string;
}

export interface UseInitiatePaymentOptions {
  readonly enabled: boolean;
  readonly invoiceId: string;
  /**
   * Payment method to initiate. Defaults to `'card'` for the historical
   * card-only call sites. Phase 4 (T091) passes `'promptpay'` so the
   * PromptPay panel can request a server-confirmed PaymentIntent that
   * Stripe returns with `next_action.promptpay_display_qr_code` populated.
   */
  readonly method?: 'card' | 'promptpay';
  readonly initialInitiate: CachedInitiate | null;
  readonly retryCount: number;
  /** Stable translator ref so locale changes don't re-fire the effect. */
  readonly translateRef: React.MutableRefObject<TranslateFn>;
  readonly onInitiating: () => void;
  readonly onSuccess: (payload: InitiateResponse) => void;
  readonly onFailure: (reason: string) => void;
}

/**
 * Cache-decision sub-hook (A-X-HOOK partial extraction, 2026-04-26).
 *
 * Invariants — DO NOT collapse back into the parent hook without the
 * test suite green:
 *   1. The cache value (`initialInitiate`) is FROZEN on the first
 *      render where `enabled === true`. Subsequent prop changes are
 *      inert — preserves the post-success path: parent invalidates
 *      its cache → setting it to null → the parent hook MUST NOT
 *      re-fetch with a now-terminal clientSecret.
 *   2. Frozen value is CONSUMED (set to null) immediately after the
 *      decision to skip the fetch — preserves the tab-switch path:
 *      effect re-runs → ref already null → fetch fires normally.
 *   3. Concurrent-React safety: if the frozen value disagrees with
 *      the latest prop on the FIRST enabled run, the latest prop is
 *      authoritative and the ref is corrected (Offscreen pre-render
 *      may have committed a stale value).
 *
 * Returns a one-shot decision function the parent calls inside its
 * effect: `true` = skip the fetch; `false` = proceed with fetch.
 */
function useShouldSkipInitialFetch(
  enabled: boolean,
  initialInitiate: CachedInitiate | null,
): () => boolean {
  const ref = useRef<CachedInitiate | null>(
    enabled ? initialInitiate : null,
  );
  // Concurrent-React safety lives in `useEffect`, NOT in the
  // returned closure. Without this separation, the closure would
  // overwrite `ref.current` every time the parent re-renders with
  // a changed `initialInitiate` (e.g. parent invalidating its
  // cache to null after success) — zeroing out a frozen-but-still-
  // valid cache before the skip decision was made. Effect dep
  // `[enabled, initialInitiate]` means the correction fires once
  // per genuine prop change (post-commit), not on every closure
  // invocation.
  const cacheWasEnabledOnMountRef = useRef<boolean>(enabled);
  useEffect(() => {
    if (!cacheWasEnabledOnMountRef.current && enabled) {
      // Hook is being enabled for the first time AFTER a cold mount
      // (e.g. user lands on PromptPay tab; later switches to Card and
      // the card hook's `enabled` flips true). The ref was initialised
      // to null on the cold mount; the latest prop is authoritative.
      ref.current = initialInitiate;
      cacheWasEnabledOnMountRef.current = true;
      return;
    }
    if (
      process.env.NODE_ENV !== 'production' &&
      enabled &&
      ref.current !== null &&
      ref.current !== initialInitiate &&
      initialInitiate !== null
    ) {
      // The ref-frozen value disagrees with the latest prop AND the
      // latest prop is itself non-null → Concurrent-React Offscreen
      // pre-render may have committed a stale value. Correct + warn.
      // (We do NOT correct when the latest prop is null — that's the
      // parent's normal post-success cache invalidation, which the
      // ref-frozen value is supposed to outlive per invariant #1.)
      console.warn(
        '[use-initiate-payment] ref-frozen initialInitiate differs from current prop — using current prop',
      );
      ref.current = initialInitiate;
    }
  }, [enabled, initialInitiate]);

  return () => {
    if (ref.current !== null) {
      // Consume so subsequent runs (tab toggle, retry bump) don't
      // re-skip on a now-irrelevant value.
      ref.current = null;
      return true;
    }
    return false;
  };
}

export function useInitiatePayment(opts: UseInitiatePaymentOptions): void {
  const optsRef = useRef(opts);
  useEffect(() => {
    optsRef.current = opts;
  });

  const {
    enabled,
    invoiceId,
    retryCount,
    method = 'card',
  } = opts;

  const shouldSkipFirstFetch = useShouldSkipInitialFetch(
    opts.enabled,
    opts.initialInitiate,
  );

  useEffect(() => {
    if (!enabled) return;
    if (retryCount === 0 && shouldSkipFirstFetch()) {
      return;
    }

    const abortController = new AbortController();
    let cancelled = false;
    optsRef.current.onInitiating();

    (async () => {
      try {
        const response = await fetch('/api/payments/initiate', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ invoiceId, method }),
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
        // Cache consumption is centralized in `useShouldSkipInitialFetch`
        // — the ref is cleared the moment the skip-decision is made,
        // not after fetch resolves. So a re-run on tab-toggle or retry
        // bump always proceeds to a fresh fetch.
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
    // `initialInitiate` is intentionally absent from deps — its
    // role is encapsulated in `useShouldSkipInitialFetch`. `method`
    // IS in deps because switching tabs is a legitimate cause for
    // a re-fire with a new method body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, invoiceId, retryCount, method]);
}
