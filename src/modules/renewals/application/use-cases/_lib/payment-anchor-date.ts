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

/** Rolling anchor = FIRST DAY of the payment month, Bangkok time (spec rev 3 —
 *  verified against TSCC's records: paid 2026-03-16 → period 2026-03-01;
 *  TSCC operates month-boundary periods). Prefer the admin-entered paymentDate
 *  (Bangkok-local YYYY-MM-DD); fall back to paidAt converted to the
 *  Asia/Bangkok calendar date (UTC+7 fixed offset, no DST). */
export function paymentAnchorMonthStartUtc(evt: {
  readonly paymentDate: string | null;
  readonly paidAt: string;
}): string {
  let y: number;
  let m: string;
  if (evt.paymentDate !== null) {
    y = Number(evt.paymentDate.slice(0, 4));
    m = evt.paymentDate.slice(5, 7);
  } else {
    const bkk = new Date(Date.parse(evt.paidAt) + 7 * 3600_000);
    y = bkk.getUTCFullYear();
    m = String(bkk.getUTCMonth() + 1).padStart(2, '0');
  }
  return `${y}-${m}-01T00:00:00.000Z`;
}
