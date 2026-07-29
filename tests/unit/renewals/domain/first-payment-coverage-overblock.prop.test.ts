/**
 * L2 hardening (renewals-coverage-window-hardening) — first-payment
 * over-block property.
 *
 * HAZARD (from the auto-invoice × renewal §86/4 investigation): the ONLINE
 * `confirm-renewal.ts` stamps a PROVISIONAL dup-guard `coverageWindow` on a
 * first-payment bill computed from the PRE-re-anchor cycle —
 * `[cycle.periodTo, cycle.periodTo + frozenPlanTermMonths)` (confirm-renewal.ts
 * ~822-828, UNCONDITIONAL, even when `membershipCoverage` is omitted for a
 * first_payment classification). But a first-payment cycle RE-ANCHORS its period
 * at payment (`_lib/reanchor-first-payment.ts`, FIXED-ANCHOR): normally it KEEPS
 * `[periodFrom, periodTo)`; only if the fixed period already elapsed by the
 * payment date (comeback) does it snap to the payment month.
 *
 * If the provisional window overlaps the member's CORRECTLY-computed next
 * renewal window, `findOverlappingMembershipCoverageBill` FALSE-REFUSES that
 * legit later renewal (money-safe — it blocks, never mints a duplicate — but a
 * legit renewal shouldn't be blocked).
 *
 * This property asserts the desired invariant: a PAID first-payment bill's
 * provisional coverage window does NOT over-block the correctly-computed next
 * renewal window. It is a PURE reproduction of the two window formulas
 * (confirm-renewal's stamp + reanchor-first-payment's period math), so it
 * characterises the SHIPPED behaviour without a live DB.
 *
 * NOTE (the OFFLINE `mark-paid-offline` rail is NOT affected): it stamps NULL
 * coverage on first-payment (L1), so its first-payment bill never participates
 * in the guard. `admin-renew-lapsed-member` stamps the CURRENT period
 * `[periodFrom, periodTo)` (adjacent to the next renewal → half-open, no
 * overlap). Only confirm-renewal stamps the NEXT-period provisional window.
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
 * Reproduce, purely, what happens to a genuine first-payment member:
 *   - confirm-renewal STAMPS the provisional window `[periodTo, periodTo+term)`
 *     on the paid first-payment bill;
 *   - the first payment RE-ANCHORS the cycle (fixed-anchor + comeback);
 *   - the member's later renewal covers `[activePeriodTo, activePeriodTo+term)`.
 * Returns `null` when the provisional window does NOT over-block the renewal.
 */
function overBlockedRenewal(input: {
  periodFromIso: string;
  termMonths: number;
  paymentYmd: string;
}): MembershipBillCoverageRow | null {
  const { periodFromIso, termMonths, paymentYmd } = input;
  const periodToIso = addMonthsUtc(periodFromIso, termMonths);

  // (1) confirm-renewal.ts:822-828 — first-payment provisional stamp.
  const provisional: CoverageWindow = {
    from: periodToIso,
    to: addMonthsUtc(periodToIso, termMonths),
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
    coverage: provisional,
  };

  return findOverlappingMembershipCoverageBill(
    [paidFirstPaymentBill],
    nextRenewal,
  );
}

describe('first-payment provisional coverage — over-block property (L2)', () => {
  // ────────────────────────────────────────────────────────────────────────
  // FINDING (2026-07-29): this SAFETY property does NOT hold on the ONLINE
  // confirm-renewal rail. In the NORMAL (pay-before-expiry) first-payment case
  // the fixed-anchor re-anchor KEEPS the period, so the member's next renewal
  // window is `[periodTo, periodTo+term)` — EXACTLY the provisional window
  // confirm-renewal stamped on the paid first-payment bill. The guard therefore
  // FALSE-REFUSES the legit later renewal. Money-safe (it blocks, never mints a
  // duplicate), but a legit renewal shouldn't be blocked.
  //
  // Shrunk counterexample: periodFrom 2024-01-01, term 1mo, paid same day →
  // provisional [2024-02-01, 2024-03-01) == next renewal [2024-02-01, 2024-03-01).
  //
  // Per the hardening brief this is STOP-AND-REPORT, not fix-here: the fix
  // (confirm-renewal / any online first-payment mint must stamp NULL — like
  // `mark-paid-offline` after L1 — or the CURRENT period `[periodFrom, periodTo)`
  // like `admin-renew-lapsed-member`, NEVER the next-period provisional window)
  // touches the online renewal path this brief must not change, so it belongs in
  // a follow-up spec. See `.superpowers/sdd/coverage-hardening-report.md` (L2).
  //
  // `it.fails` = committed-RED: the inner assertion is the UNWEAKENED safety
  // property (`toBeNull()` — no over-block). It is EXPECTED to fail today and
  // must be flipped back to a plain `it` (dropping `.fails`) when the online
  // first-payment stamp is fixed — at which point it becomes the regression guard.
  // ────────────────────────────────────────────────────────────────────────
  it.fails(
    'a paid first-payment provisional window does NOT over-block the next renewal — CURRENTLY FAILS (documents the confirm-renewal over-block, see coverage-hardening-report.md)',
    () => {
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

            const hit = overBlockedRenewal({
              periodFromIso,
              termMonths,
              paymentYmd,
            });
            // Safety property: no over-block (the guard returns null).
            expect(hit).toBeNull();
          },
        ),
        { numRuns: 500 },
      );
    },
  );

  // Deterministic, RNG-free characterisation of the exact over-block, so the
  // finding is pinned even if the fast-check seed changes. NORMAL re-anchor:
  // periodFrom 2024-01-01 + 12mo → periodTo 2025-01-01; paid 2024-06-05 (before
  // expiry) keeps the period, so the next renewal window and the provisional
  // window are the identical [2025-01-01, 2026-01-01) → guard blocks.
  it('DOCUMENTS the over-block concretely: provisional window == next-renewal window in the normal re-anchor case', () => {
    const hit = overBlockedRenewal({
      periodFromIso: '2024-01-01T00:00:00.000Z',
      termMonths: 12,
      paymentYmd: '2024-06-05',
    });
    expect(hit).not.toBeNull();
    expect(hit?.coverage).toEqual({
      from: '2025-01-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
    });
  });

  // The COMEBACK branch is safe: when the fixed period already elapsed by the
  // payment date, the re-anchor snaps the active period to the payment month, so
  // the next renewal window sits AFTER the provisional window (no overlap). This
  // pins that the over-block is specific to the normal (pay-before-expiry) case.
  it('does NOT over-block on the comeback branch (period already expired at payment → re-anchor moves it forward)', () => {
    const hit = overBlockedRenewal({
      periodFromIso: '2024-01-01T00:00:00.000Z',
      termMonths: 12,
      // Paid well AFTER periodTo (2025-01-01) → comeback → period snaps to
      // 2026-03-01, next renewal [2026-03-01, 2027-03-01) is clear of the
      // provisional [2025-01-01, 2026-01-01).
      paymentYmd: '2026-03-10',
    });
    expect(hit).toBeNull();
  });
});
