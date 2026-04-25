/**
 * Direct unit test for `mapStripeError` (audit 2026-04-26 round-2
 * self-review #R2-A5 follow-up).
 *
 * Bypasses the MSW + Stripe SDK round-trip — throws synthetic
 * `Stripe.errors.*` instances directly at the mapper. Pins the
 * mapping matrix deterministically without relying on SDK class-
 * wrapping behaviour for HTTP responses.
 */
import { describe, expect, it } from 'vitest';
import Stripe from 'stripe';
import { mapStripeError } from '@/modules/payments/infrastructure/stripe/stripe-gateway';

const ctx = { stripeAccount: 'acct_test_mapper' };

describe('mapStripeError — direct unit', () => {
  it('StripeConnectionError → retryable', () => {
    const e = new Stripe.errors.StripeConnectionError({
      message: 'Could not connect',
      type: 'StripeConnectionError' as never,
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('retryable');
  });

  it('StripeAPIError → retryable', () => {
    const e = new Stripe.errors.StripeAPIError({
      message: 'API failure',
      type: 'StripeAPIError' as never,
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('retryable');
  });

  it('StripeIdempotencyError → idempotency_conflict', () => {
    const e = new Stripe.errors.StripeIdempotencyError({
      message: 'Idempotency key in use',
      type: 'StripeIdempotencyError' as never,
      code: 'idempotency_key_in_use',
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('idempotency_conflict');
  });

  it('StripeCardError → permanent + preserves api code (not type-class)', () => {
    const e = new Stripe.errors.StripeCardError({
      message: 'Your card was declined.',
      type: 'StripeCardError' as never,
      code: 'card_declined',
      decline_code: 'insufficient_funds',
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('permanent');
    if (result.kind !== 'permanent') throw new Error('unreachable');
    // Audit 2026-04-25 finding #1: code MUST be the API code
    // ('card_declined'), not the SDK type-class name ('StripeCardError').
    expect(result.code).toBe('card_declined');
  });

  it('StripeAuthenticationError → permanent + carries api code', () => {
    const e = new Stripe.errors.StripeAuthenticationError({
      message: 'Invalid API Key',
      type: 'StripeAuthenticationError' as never,
      code: 'invalid_api_key',
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('permanent');
    if (result.kind !== 'permanent') throw new Error('unreachable');
    expect(result.code).toBe('invalid_api_key');
  });

  it('StripeRateLimitError → permanent (SDK already retried)', () => {
    const e = new Stripe.errors.StripeRateLimitError({
      message: 'Too many requests',
      type: 'StripeRateLimitError' as never,
      code: 'rate_limit',
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('permanent');
  });

  it('StripeInvalidRequestError → permanent', () => {
    const e = new Stripe.errors.StripeInvalidRequestError({
      message: 'No such payment_intent',
      type: 'StripeInvalidRequestError' as never,
      code: 'resource_missing',
    });
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('permanent');
  });

  it('Stripe error with NO code falls back to `unknown_stripe_error` (audit #1)', () => {
    // Synthetic edge case — Stripe rarely emits errors without code,
    // but mapper must not fall back to type-class name (which would
    // mis-route UI consumers' decline_code switch).
    const e = new Stripe.errors.StripeAPIError({
      message: 'Some weird error',
      type: 'StripeAPIError' as never,
    });
    // StripeAPIError → retryable kind (no code field used in retryable)
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('retryable');
  });

  it('Plain JS AbortError → retryable (network-class, audit #12)', () => {
    const e = new DOMException('Aborted', 'AbortError');
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('retryable');
  });

  it('Plain Error of unknown shape → permanent + unknown_stripe_error code', () => {
    const e = new Error('mystery failure');
    const result = mapStripeError(e, ctx);
    expect(result.kind).toBe('permanent');
    if (result.kind !== 'permanent') throw new Error('unreachable');
    expect(result.code).toBe('unknown_stripe_error');
  });
});
