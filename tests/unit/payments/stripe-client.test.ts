/**
 * F5 review — stripe-client singleton + reset-for-testing coverage.
 *
 * Verifies `getStripeClient()` returns the same reference across calls
 * and that `__resetStripeClientForTesting()` lets tests re-initialise
 * between cases without accidental pollution.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import {
  __resetStripeClientForTesting,
  getStripeClient,
} from '@/modules/payments/infrastructure/stripe/stripe-client';

describe('getStripeClient — singleton + reset', () => {
  beforeEach(() => {
    __resetStripeClientForTesting();
  });

  it('returns the same instance on repeated calls', () => {
    const a = getStripeClient();
    const b = getStripeClient();
    expect(a).toBe(b);
  });

  it('returns a fresh instance after reset', () => {
    const a = getStripeClient();
    __resetStripeClientForTesting();
    const b = getStripeClient();
    expect(a).not.toBe(b);
  });

  it('exposes the narrow StripeClient contract surface', () => {
    const client = getStripeClient();
    expect(client.paymentIntents).toBeDefined();
    expect(client.refunds).toBeDefined();
    expect(client.charges).toBeDefined();
    expect(client.webhooks).toBeDefined();
    expect(client.accounts).toBeDefined();
  });
});
