/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — Bangkok month-start anchor derivation.
 *
 * Consumed by `resolveUnlinkedMembershipPaymentInTx` (the unlinked-invoice
 * on-paid hook) for both the `heal_no_cycle` and `first_payment`
 * classification branches. A future linked-path task (markCycleCompleteInTx
 * first-payment classification) reuses the same helper — single source of
 * truth for "what date does this payment anchor to".
 */

import { bangkokLocalDate } from '@/lib/fiscal-year';

/** Rolling anchor = FIRST DAY of the payment month, Bangkok time (spec rev 3 —
 *  verified against TSCC's records: paid 2026-03-16 → period 2026-03-01;
 *  TSCC operates month-boundary periods). Prefer the admin-entered paymentDate
 *  (Bangkok-local YYYY-MM-DD); fall back to paidAt converted to the
 *  Asia/Bangkok calendar date.
 *
 *  FIX-8(f) (PR #173 review, 2026-07-09) — the `paidAt` leg now derives the
 *  Bangkok calendar date via the project's canonical `bangkokLocalDate`
 *  helper (js-joda + real Asia/Bangkok zone) instead of a hand-rolled
 *  "+7 hours then read UTC fields" `Date` shift — same effective instant
 *  (Asia/Bangkok is a fixed UTC+7 offset, no DST, so the two approaches
 *  always agree), but now shares the ONE canonical implementation every
 *  other Bangkok-date site in this codebase uses. */
export function paymentAnchorMonthStartUtc(evt: {
  readonly paymentDate: string | null;
  readonly paidAt: string;
}): string {
  const dateOnly = evt.paymentDate ?? bangkokLocalDate(evt.paidAt);
  const y = dateOnly.slice(0, 4);
  const m = dateOnly.slice(5, 7);
  return `${y}-${m}-01T00:00:00.000Z`;
}
