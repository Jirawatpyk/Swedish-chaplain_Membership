/**
 * 088 — explicit tri-state for the tax-at-payment flag, replacing a
 * `boolean | undefined` whose three states were read three different ways.
 *  - 'on'            → FEATURE_088_TAX_AT_PAYMENT enabled (new bill→RC flow)
 *  - 'off'           → flag explicitly disabled (legacy §86/4-at-issue)
 *  - 'not-forwarded' → the caller does not carry the flag (webhook / confirm-
 *                      payment reconciliation path) → money guards stay DORMANT
 */
export type TaxAtPaymentFlag = 'on' | 'off' | 'not-forwarded';
export const taxAtPaymentFlag = (on: boolean): TaxAtPaymentFlag => (on ? 'on' : 'off');
