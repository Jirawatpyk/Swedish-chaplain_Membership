'use client';

/**
 * #608 security review, LOW 1 — after a 3DS redirect Stripe appends
 * `payment_intent`, `payment_intent_client_secret` and `redirect_status` to
 * `return_url` (pay-sheet/card-form.tsx). Nothing reads them (status comes
 * from the webhook), and left in the address bar the client secret lands in
 * history and in an idle sign-out's `returnTo`. On mount this removes exactly
 * those keys and keeps the rest of the query (`paid`, `pay`).
 *
 * Rendered UNCONDITIONALLY by the detail page: after 3DS the invoice is
 * usually already paid, where the pay sheet never mounts.
 */
import { useEffect } from 'react';

import { STRIPE_RETURN_PARAMS } from '@/lib/return-url';

export function StripStripeReturnParams(): null {
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!STRIPE_RETURN_PARAMS.some((key) => url.searchParams.has(key))) return;
    for (const key of STRIPE_RETURN_PARAMS) url.searchParams.delete(key);
    // Native replaceState: Next syncs it with the router, no refetch.
    window.history.replaceState(window.history.state, '', url.pathname + url.search + url.hash);
  }, []);
  return null;
}
