/**
 * Simplify S1 — shared Stripe.js singleton cache.
 *
 * `<PaySheetInternal>` (3DS poll) and `<CardForm>` (Elements provider)
 * BOTH need to call `loadStripe(publishableKey)`. Stripe.js memoises
 * internally, but each call wires extra logic (publishable-key
 * validation, error path) — keeping a module-level cache means each
 * key resolves to the same `Promise<Stripe | null>` instance across
 * components, eliminating the prior duplication where each component
 * owned its own Map (review I-4 + S1 closeout).
 *
 * Bounded LRU cap defends future multi-tenant Connect (F11) where
 * each tenant carries a distinct `pk_live_*` — without the cap the
 * Map grows for the lifetime of the Vercel function worker.
 *
 * No circular-dep risk because this file is leaf-only — neither
 * `card-form.tsx` nor `pay-sheet-internal.tsx` re-export from here.
 */
import { loadStripe, type Stripe } from '@stripe/stripe-js';

const MAX_STRIPE_CACHE_SIZE = 8;
const cache = new Map<string, Promise<Stripe | null>>();

export function getStripeInstance(publishableKey: string): Promise<Stripe | null> {
  let cached = cache.get(publishableKey);
  if (!cached) {
    if (cache.size >= MAX_STRIPE_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) cache.delete(oldestKey);
    }
    cached = loadStripe(publishableKey);
    cache.set(publishableKey, cached);
  }
  return cached;
}
