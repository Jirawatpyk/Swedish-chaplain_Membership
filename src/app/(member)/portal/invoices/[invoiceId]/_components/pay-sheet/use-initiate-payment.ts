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

  // R5 canonical fix (2026-04-25): `initialInitiate` is read via ref
  // instead of being a useEffect dep. The previous shape included
  // `initialInitiate` in the deps array, so when the parent set the
  // cached initiate to `null` AFTER a successful payment (to invalidate
  // its cache), this effect re-fired and overwrote `payState='success'`
  // back to `card-form` with a fresh PaymentIntent — the user saw
  // ConfirmationPanel flash then revert to the card form (with the now-
  // terminal old clientSecret raising "PaymentIntent in terminal state"
  // inside Stripe Elements). The fix: only the FIRST render reads
  // `initialInitiate` to decide whether to skip the fetch; subsequent
  // changes are inert. This is correct because the cache exists ONLY to
  // skip the initial fetch on a re-opened drawer; once the effect has
  // run, the cache is no longer relevant — payState owns the truth.
  //
  // R5 review B1 (2026-04-25): only freeze the cached value when the
  // hook is enabled on first mount. Otherwise, a user who lands on the
  // PromptPay tab first (card hook starts disabled) would freeze a
  // potentially-stale `opts.initialInitiate` that the parent later
  // populated; when the user switches to Card the effect would skip
  // the fetch forever (`initialInitiateRef.current !== null`) and
  // `payState` would stay at `idle` — card form never renders.
  //
  // Concurrent React caveat (R5 N2): in React 18+ Concurrent Mode the
  // initializer runs in any candidate render — including ones React
  // may discard (e.g. via <Offscreen>). The committed render's first
  // run is the one whose value the ref keeps. Today's caller mounts
  // <PaySheetInternal> via `{hasOpened && ...}`, gated on a state
  // flip, so the first-rendered tree IS committed. If a future React
  // version pre-renders this subtree, revisit this assumption.
  const initialInitiateRef = useRef<CachedInitiate | null>(
    opts.enabled ? opts.initialInitiate : null,
  );

  useEffect(() => {
    if (!enabled) return;
    // Read once-frozen `initialInitiate` from ref — not the latest prop.
    if (initialInitiateRef.current !== null && retryCount === 0) return;

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
    // `initialInitiate` removed from deps — see ref-based pattern
    // documented above; `method` retained because switching tabs is a
    // legitimate cause for a re-fire with a new method body.

  }, [enabled, invoiceId, retryCount, method]);
}
