/**
 * #57 — which failed money POST leaves the outcome unknown. A 5xx that names
 * no refusal (a Vercel 504 page, our own internal_error) may come after the
 * issue or the payment committed; a named code or a 4xx says what happened.
 */
import { describe, expect, it } from 'vitest';
import {
  isUnknownOutcome,
  MONEY_POST_TIMEOUT_MS,
} from '@/app/(staff)/admin/invoices/_components/unknown-outcome';

describe('isUnknownOutcome', () => {
  it('a 5xx with no code is unknown', () => {
    expect(isUnknownOutcome(504, null)).toBe(true);
  });
  it('a 5xx internal_error is unknown', () => {
    expect(isUnknownOutcome(500, { code: 'internal_error', shape: 'nested' })).toBe(true);
  });
  it('a 5xx whose body is a flat string (not a route code) is unknown', () => {
    expect(isUnknownOutcome(500, { code: 'server-error', shape: 'flat' })).toBe(true);
  });
  it('a 5xx with a named route code is not', () => {
    expect(isUnknownOutcome(500, { code: 'pdf_render_failed', shape: 'nested' })).toBe(false);
  });
  it('a 4xx is not, coded or not', () => {
    expect(isUnknownOutcome(409, { code: 'invalid_status', shape: 'nested' })).toBe(false);
    expect(isUnknownOutcome(400, null)).toBe(false);
  });
});

describe('MONEY_POST_TIMEOUT_MS', () => {
  it('is well past the ~10 s a money POST takes, and under the 300 s platform limit', () => {
    expect(MONEY_POST_TIMEOUT_MS).toBeGreaterThan(30_000);
    expect(MONEY_POST_TIMEOUT_MS).toBeLessThan(300_000);
  });
});
