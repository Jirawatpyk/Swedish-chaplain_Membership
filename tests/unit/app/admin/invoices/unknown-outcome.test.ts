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
    expect(isUnknownOutcome(504, undefined)).toBe(true);
    expect(isUnknownOutcome(502, null)).toBe(true);
  });
  it('a 5xx internal_error is unknown', () => {
    expect(isUnknownOutcome(500, 'internal_error')).toBe(true);
  });
  it('a 5xx with a named code is not', () => {
    expect(isUnknownOutcome(503, 'pdf_render_failed')).toBe(false);
  });
  it('a 4xx is not, coded or not', () => {
    expect(isUnknownOutcome(409, 'invalid_status')).toBe(false);
    expect(isUnknownOutcome(400, undefined)).toBe(false);
  });
});

describe('MONEY_POST_TIMEOUT_MS', () => {
  it('outlasts the routes’ 60 s maxDuration', () => {
    expect(MONEY_POST_TIMEOUT_MS).toBeGreaterThan(60_000);
  });
});
