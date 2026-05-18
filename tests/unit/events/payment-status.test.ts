/**
 * R2-6 (2026-05-18 /speckit-review Round 2) — unit tests for the
 * `PaymentStatus` Domain VO. Pre-R2 the VO had no test suite at all:
 * the `isPaymentStatus` runtime guard guarded URL inputs, the
 * `isQuotaCountedStatus` predicate gated the F6.1 Option B+ credit/
 * debit semantics, and the `PAYMENT_STATUSES` tuple was the source of
 * truth for the closed set — but none had regression coverage.
 *
 * This suite locks in:
 *   1. `isPaymentStatus` accepts every member, rejects everything else
 *      (including case-variants and SQL-injection-shaped strings).
 *   2. `isQuotaCountedStatus` returns true iff the status is `paid` or
 *      `free`. Round-tripping the tuple confirms no member silently
 *      becomes quota-counted on future additions.
 *   3. The `PAYMENT_STATUSES` tuple membership round-trips through the
 *      guard — guarantees the tuple itself stays in sync with the
 *      `PaymentStatus` type.
 *
 * Pure Domain — no DB, no framework.
 */
import { describe, it, expect } from 'vitest';
import {
  PAYMENT_STATUSES,
  isPaymentStatus,
  isQuotaCountedStatus,
  type PaymentStatus,
} from '@/modules/events/domain/value-objects/payment-status';

describe('PaymentStatus VO (R2-6 unit)', () => {
  describe('PAYMENT_STATUSES tuple', () => {
    it('contains exactly the 6 known members', () => {
      expect(PAYMENT_STATUSES).toEqual([
        'paid',
        'pending',
        'refunded',
        'free',
        'waitlisted',
        'no_show',
      ]);
    });

    it('has no duplicate members', () => {
      const set = new Set<string>(PAYMENT_STATUSES);
      expect(set.size).toBe(PAYMENT_STATUSES.length);
    });
  });

  describe('isPaymentStatus guard', () => {
    it.each(PAYMENT_STATUSES)('accepts canonical member %s', (s) => {
      expect(isPaymentStatus(s)).toBe(true);
    });

    it.each([
      'PAID',
      'Pending',
      'Refunded',
      'FREE',
      'No_Show',
      'no-show',
    ])('rejects case/format variant %s', (bad) => {
      expect(isPaymentStatus(bad)).toBe(false);
    });

    it.each([
      '',
      ' ',
      'unknown',
      'invoiced',
      'attending', // EventCreate upstream literal — not a payment status
      '__all__', // sentinel from attendee-table.tsx Select
    ])('rejects unknown literal %s', (bad) => {
      expect(isPaymentStatus(bad)).toBe(false);
    });

    it.each([
      "'%' OR 1=1 --",
      '; DROP TABLE event_registrations; --',
      '<script>alert(1)</script>',
      '../../etc/passwd',
    ])('rejects adversarial injection-shaped string %s', (bad) => {
      expect(isPaymentStatus(bad)).toBe(false);
    });

    it.each([null, undefined, 0, 1, {}, [], true, false])(
      'rejects non-string %s',
      (bad) => {
        expect(isPaymentStatus(bad)).toBe(false);
      },
    );

    it('narrows the type when true', () => {
      const value: unknown = 'paid';
      // Assert guard accepts before narrowing — if this fails, the
      // subsequent block is skipped by vitest's failed-assertion exit.
      expect(isPaymentStatus(value)).toBe(true);
      if (isPaymentStatus(value)) {
        // Compile-time: `value` is now `PaymentStatus`. The assignment
        // would be a type error if the guard didn't narrow.
        const narrowed: PaymentStatus = value;
        expect(narrowed).toBe('paid');
      }
    });
  });

  describe('isQuotaCountedStatus predicate (R2-3)', () => {
    it('returns true for paid', () => {
      expect(isQuotaCountedStatus('paid')).toBe(true);
    });

    it('returns true for free', () => {
      expect(isQuotaCountedStatus('free')).toBe(true);
    });

    it.each<PaymentStatus>([
      'pending',
      'refunded',
      'waitlisted',
      'no_show',
    ])('returns false for non-counted status %s', (s) => {
      expect(isQuotaCountedStatus(s)).toBe(false);
    });

    it('matches the F6.1 Option B+ documented rule for every tuple member', () => {
      // Lock the rule: only `paid` + `free` count. If a future
      // PaymentStatus addition needs to be quota-counted, this test
      // forces an explicit update to both the predicate AND the
      // expected-set so the change is visible in code review.
      const counted = PAYMENT_STATUSES.filter(isQuotaCountedStatus);
      expect(counted).toEqual(['paid', 'free']);
    });
  });
});
