/**
 * I6 fix — verify `getStripeApiVersion()` is a mockable getter (not a
 * frozen const) and returns the configured string.
 *
 * True build-time-safe import was the original ambition, but env.ts
 * runs its zod parse at import regardless of whether its properties
 * are read — see the module docstring for why we accepted that cost.
 * What this test DOES cover: the getter reads env.stripe.apiVersion
 * at call time (not captured at module init), so tests can stub env
 * and observe the updated value.
 */
import { describe, expect, it, vi } from 'vitest';

describe('getStripeApiVersion — mockable env-reader', () => {
  it('returns env.stripe.apiVersion on each call', async () => {
    vi.doMock('@/lib/env', () => ({
      env: { stripe: { apiVersion: '2099-01-01.test' } },
    }));
    vi.resetModules();
    const mod = await import(
      '@/modules/payments/infrastructure/stripe/stripe-api-version'
    );
    expect(mod.getStripeApiVersion()).toBe('2099-01-01.test');
    vi.doUnmock('@/lib/env');
  });

  it('picks up a changed env between calls (getter, not const)', async () => {
    let current = 'v-one';
    vi.doMock('@/lib/env', () => ({
      env: {
        get stripe() {
          return { apiVersion: current };
        },
      },
    }));
    vi.resetModules();
    const mod = await import(
      '@/modules/payments/infrastructure/stripe/stripe-api-version'
    );
    expect(mod.getStripeApiVersion()).toBe('v-one');
    current = 'v-two';
    expect(mod.getStripeApiVersion()).toBe('v-two');
    vi.doUnmock('@/lib/env');
  });
});
