/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — `paymentAnchorMonthStartUtc`.
 *
 * Pins the FIRST-DAY-OF-PAYMENT-MONTH (Bangkok) anchor derivation: prefer
 * the admin-entered `paymentDate` (already Bangkok-local YYYY-MM-DD) and
 * fall back to `paidAt` converted to the Asia/Bangkok calendar date
 * (UTC+7 fixed offset, no DST).
 */
import { describe, expect, it } from 'vitest';
import { paymentAnchorMonthStartUtc } from '@/modules/renewals/application/use-cases/_lib/payment-anchor-date';

describe('paymentAnchorMonthStartUtc', () => {
  it('paymentDate mid-month → 1st of the same month', () => {
    expect(
      paymentAnchorMonthStartUtc({
        paymentDate: '2026-03-16',
        paidAt: '2026-03-16T04:12:00Z',
      }),
    ).toBe('2026-03-01T00:00:00.000Z');
  });

  it('paymentDate precedence over paidAt even when they disagree', () => {
    expect(
      paymentAnchorMonthStartUtc({
        paymentDate: '2026-01-05',
        // paidAt says March — paymentDate must win.
        paidAt: '2026-03-31T23:30:00Z',
      }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });

  it('paymentDate null → falls back to paidAt converted to Bangkok calendar date', () => {
    expect(
      paymentAnchorMonthStartUtc({
        paymentDate: null,
        paidAt: '2026-03-16T10:00:00Z', // Bangkok 17:00 same day
      }),
    ).toBe('2026-03-01T00:00:00.000Z');
  });

  it('UTC-vs-Bangkok month-boundary: 2026-03-31T23:30Z = Bangkok 2026-04-01T06:30 → April anchor', () => {
    expect(
      paymentAnchorMonthStartUtc({
        paymentDate: null,
        paidAt: '2026-03-31T23:30:00Z',
      }),
    ).toBe('2026-04-01T00:00:00.000Z');
  });

  it('single-digit month is zero-padded', () => {
    expect(
      paymentAnchorMonthStartUtc({
        paymentDate: '2026-01-20',
        paidAt: '2026-01-20T00:00:00Z',
      }),
    ).toBe('2026-01-01T00:00:00.000Z');
  });
});
