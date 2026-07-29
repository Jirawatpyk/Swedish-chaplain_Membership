/**
 * L2/L3 hardening (renewals-coverage-window-hardening) — first-payment
 * over-block REGRESSION GUARD.
 *
 * BACKGROUND (the L2 over-block, now FIXED at L3): the ONLINE
 * `confirm-renewal.ts` used to stamp a first-payment bill's DB-EXCLUDE
 * `coverageWindow` with the RENEWAL formula `[periodTo, periodTo + term)` (the
 * NEXT period), UNCONDITIONALLY — even when `membershipCoverage` was omitted for a
 * first-payment classification. But a first-payment cycle KEEPS its own period
 * under the fixed-anchor re-anchor (`_lib/reanchor-first-payment.ts`; normal =
 * keep `[periodFrom, periodTo)`, comeback = snap forward), so the member's
 * correctly-computed FIRST renewal ALSO covered `[periodTo, periodTo+term)` —
 * IDENTICAL to the stamped window — and `findOverlappingMembershipCoverageBill`
 * (domain/membership-bill-coverage.ts) FALSE-REFUSED that legit first renewal
 * (money-safe: it blocks, never mints a duplicate, but a legit renewal shouldn't
 * be blocked).
 *
 * THE FIX (L3): confirm-renewal now stamps the first-payment branch with the
 * cycle's OWN CURRENT period `[periodFrom, periodTo)` (matching
 * `admin-renew-lapsed-member.ts:596`), NOT the next-period window. That window is
 * ADJACENT (half-open) to the member's next renewal `[periodTo, periodTo+term)`
 * → no overlap → no over-block. It is still NON-NULL (the renewal bridge requires
 * a coverage window by design), so a duplicate first-payment (double-confirm)
 * stamps the SAME `[periodFrom, periodTo)` and is rejected by the DB EXCLUDE at
 * issue — no dedup protection is lost. See
 * `.superpowers/sdd/coverage-hardening-report.md` § L2/L3.
 *
 * This property is the REGRESSION GUARD for that fix: it PURELY reproduces the
 * FIXED stamp formula (`[periodFrom, periodTo)`) + the re-anchor period math and
 * asserts the first-payment bill's coverage NEVER over-blocks the member's
 * correctly-computed next renewal — for BOTH the normal and comeback re-anchor
 * branches. It characterises the SHIPPED behaviour without a live DB.
 *
 * NOTE (the sibling rails): OFFLINE `mark-paid-offline` stamps NULL on
 * first-payment (safe via its own plan_year guard, L1); `admin-renew-lapsed-member`
 * stamps `[periodFrom, periodTo)` (the same current-period window this fix adopts).
 * All three first-payment rails are now over-block-safe.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addMonthsUtc } from '@/lib/dates';
import {
  paymentAnchorMonthStartUtc,
  paymentDateOnly,
} from '@/modules/renewals/application/use-cases/_lib/payment-anchor-date';
import {
  findOverlappingMembershipCoverageBill,
  type CoverageWindow,
  type MembershipBillCoverageRow,
} from '@/modules/renewals/domain/membership-bill-coverage';

const isoUtc = (y: number, m: number, d: number): string =>
  new Date(Date.UTC(y, m - 1, d)).toISOString();

/**
 * Reproduce, purely, what happens to a genuine first-payment member AFTER the L3
 * fix:
 *   - confirm-renewal STAMPS the CURRENT-period window `[periodFrom, periodTo)`
 *     on the paid first-payment bill (the FIXED formula);
 *   - the first payment RE-ANCHORS the cycle (fixed-anchor + comeback);
 *   - the member's later renewal covers `[activePeriodTo, activePeriodTo+term)`.
 * Returns the two computed windows + the guard's verdict (`hit` is `null` when
 * there is no over-block — the desired invariant).
 */
function firstPaymentOverBlockProbe(input: {
  periodFromIso: string;
  termMonths: number;
  paymentYmd: string;
}): {
  firstPaymentCoverage: CoverageWindow;
  nextRenewal: CoverageWindow;
  hit: MembershipBillCoverageRow | null;
} {
  const { periodFromIso, termMonths, paymentYmd } = input;
  const periodToIso = addMonthsUtc(periodFromIso, termMonths);

  // (1) confirm-renewal.ts (L3 fix) — first-payment stamps the CURRENT period.
  const firstPaymentCoverage: CoverageWindow = {
    from: periodFromIso,
    to: periodToIso,
  };

  // (2) reanchor-first-payment.ts — fixed-anchor keeps [periodFrom, periodTo)
  // unless the fixed period already elapsed by the payment date (comeback).
  const evt = {
    paymentDate: paymentYmd,
    paidAt: `${paymentYmd}T05:00:00.000Z`,
  };
  const anchoredAtStamp = paymentAnchorMonthStartUtc(evt);
  const periodExpiredAtPayment =
    Date.parse(periodToIso) <= Date.parse(paymentDateOnly(evt));
  const activePeriodToIso = periodExpiredAtPayment
    ? addMonthsUtc(anchoredAtStamp, termMonths)
    : periodToIso;

  // (3) the member's CORRECT next renewal window, from the re-anchored period.
  const nextRenewal: CoverageWindow = {
    from: activePeriodToIso,
    to: addMonthsUtc(activePeriodToIso, termMonths),
  };

  const paidFirstPaymentBill: MembershipBillCoverageRow = {
    invoiceId: 'first-payment-bill',
    status: 'paid',
    coverage: firstPaymentCoverage,
  };

  return {
    firstPaymentCoverage,
    nextRenewal,
    hit: findOverlappingMembershipCoverageBill(
      [paidFirstPaymentBill],
      nextRenewal,
    ),
  };
}

describe('first-payment current-period coverage — over-block regression guard (L2/L3)', () => {
  it('a paid first-payment CURRENT-period window never over-blocks the next renewal (normal + comeback)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 2024, max: 2030 }), // periodFrom year
        fc.integer({ min: 1, max: 12 }), // periodFrom month
        fc.integer({ min: 1, max: 28 }), // periodFrom day (day-of-month safe)
        fc.constantFrom(1, 3, 6, 12, 24), // frozen term months
        fc.integer({ min: 0, max: 900 }), // first-payment offset (days after periodFrom)
        (y, m, d, termMonths, payOffsetDays) => {
          const periodFromIso = isoUtc(y, m, d);
          const paymentYmd = new Date(
            Date.parse(periodFromIso) + payOffsetDays * 86_400_000,
          )
            .toISOString()
            .slice(0, 10);

          const { hit } = firstPaymentOverBlockProbe({
            periodFromIso,
            termMonths,
            paymentYmd,
          });
          // Safety property (now HOLDS after the L3 fix): no over-block.
          expect(hit).toBeNull();
        },
      ),
      { numRuns: 500 },
    );
  });

  // Deterministic, RNG-free characterisation of the NORMAL re-anchor case (the one
  // the OLD next-period stamp got wrong — the L2 over-block). periodFrom 2024-01-01
  // + 12mo → periodTo 2025-01-01; paid 2024-06-05 (before expiry) KEEPS the period,
  // so the first-payment bill covers [2024-01-01, 2025-01-01) and the next renewal
  // covers [2025-01-01, 2026-01-01) — exactly ADJACENT (half-open) → no overlap.
  it('normal re-anchor: current-period bill is adjacent to the next renewal → no over-block', () => {
    const { firstPaymentCoverage, nextRenewal, hit } =
      firstPaymentOverBlockProbe({
        periodFromIso: '2024-01-01T00:00:00.000Z',
        termMonths: 12,
        paymentYmd: '2024-06-05',
      });
    expect(firstPaymentCoverage).toEqual({
      from: '2024-01-01T00:00:00.000Z',
      to: '2025-01-01T00:00:00.000Z',
    });
    expect(nextRenewal).toEqual({
      from: '2025-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
    // The bill's coverage ends EXACTLY where the next renewal begins, so the two
    // half-open [from, to) intervals do not overlap. This is precisely what the
    // old next-period stamp (== the next renewal window) violated.
    expect(firstPaymentCoverage.to).toBe(nextRenewal.from);
    expect(hit).toBeNull();
  });

  // Deterministic COMEBACK case (period already expired at payment): the re-anchor
  // snaps the active period to the payment month, so the next renewal sits AFTER
  // the current-period bill — still no overlap. Pins that the fix is safe on both
  // re-anchor branches.
  it('comeback re-anchor: next renewal moves forward, current-period bill stays behind → no over-block', () => {
    const { firstPaymentCoverage, nextRenewal, hit } =
      firstPaymentOverBlockProbe({
        periodFromIso: '2024-01-01T00:00:00.000Z',
        termMonths: 12,
        // Paid well AFTER periodTo (2025-01-01) → comeback → active period snaps to
        // the 2026-03 payment month, pushing the next renewal clear of the
        // current-period bill [2024-01-01, 2025-01-01).
        paymentYmd: '2026-03-10',
      });
    expect(firstPaymentCoverage).toEqual({
      from: '2024-01-01T00:00:00.000Z',
      to: '2025-01-01T00:00:00.000Z',
    });
    // Next renewal starts strictly after the current-period bill's window ends.
    expect(Date.parse(nextRenewal.from)).toBeGreaterThan(
      Date.parse(firstPaymentCoverage.to),
    );
    expect(hit).toBeNull();
  });
});
