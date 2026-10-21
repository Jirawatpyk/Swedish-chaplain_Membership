/**
 * #608 security review, LOW 1 — after a 3DS redirect Stripe appends
 * `payment_intent`, `payment_intent_client_secret` and `redirect_status` to the
 * invoice URL (`return_url` in pay-sheet/card-form.tsx). Nothing reads them,
 * and left in the address bar the client secret travels into history and into
 * an idle sign-out's `returnTo`. <StripStripeReturnParams> removes exactly
 * those three keys on mount and keeps the rest of the query.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { StripStripeReturnParams } from '@/app/(member)/portal/invoices/[invoiceId]/_components/strip-stripe-return-params';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('StripStripeReturnParams', () => {
  it('removes the Stripe redirect parameters and keeps pay, paid and the path', () => {
    window.history.replaceState(
      null,
      '',
      '/portal/invoices/i1?paid=1&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x&redirect_status=succeeded&pay=1',
    );
    render(<StripStripeReturnParams />);
    expect(window.location.pathname).toBe('/portal/invoices/i1');
    expect(window.location.search).toBe('?paid=1&pay=1');
  });

  it('leaves a bare path when only Stripe parameters were present', () => {
    window.history.replaceState(null, '', '/portal/invoices/i1?payment_intent=pi_1&redirect_status=failed');
    render(<StripStripeReturnParams />);
    expect(window.location.pathname + window.location.search).toBe('/portal/invoices/i1');
  });

  // Next's App Router keeps `__NA` in history.state and skips its router sync
  // for any replaceState that carries it — a later router.refresh() would then
  // write the old URL (secret included) back. Passing null lets Next copy its
  // own state and update the URL it remembers.
  it('hands Next a null state so the router learns the clean URL', () => {
    window.history.replaceState(
      { __NA: true },
      '',
      '/portal/invoices/i1?paid=1&payment_intent=pi_1&payment_intent_client_secret=pi_1_secret_x',
    );
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<StripStripeReturnParams />);
    expect(replace).toHaveBeenCalledWith(null, '', '/portal/invoices/i1?paid=1');
  });

  it('does not touch the history entry when there is nothing to remove', () => {
    window.history.replaceState(null, '', '/portal/invoices/i1?pay=1');
    const replace = vi.spyOn(window.history, 'replaceState');
    render(<StripStripeReturnParams />);
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.search).toBe('?pay=1');
  });
});
