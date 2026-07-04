/**
 * 088 — the tax-at-payment FLOW flag: a pure 2-state toggle for
 * FEATURE_088_TAX_AT_PAYMENT.
 *  - 'on'  → new bill→§86/4-RC-at-payment flow (bill numbered from the non-§87
 *            `SC` stream; the §87 `RC` receipt is minted later at payment)
 *  - 'off' → legacy §86/4-at-issue flow (§87 `invoice` number allocated at issue)
 *
 * This type encodes ONLY "is the 088 flow on?". It deliberately does NOT carry a
 * reconciliation/webhook state — that axis is orthogonal and is passed as an
 * EXPLICIT `reconciliationPath: boolean` on the one read that needs it
 * (`GetInvoiceForPaymentInput` + the payments bridge port input), so the
 * stranded-funds guard's dormancy is expressed by a named field, not by a third
 * union value that every flow reader would have to reason about.
 */
export type TaxAtPaymentFlag = 'on' | 'off';
export const taxAtPaymentFlag = (on: boolean): TaxAtPaymentFlag => (on ? 'on' : 'off');
