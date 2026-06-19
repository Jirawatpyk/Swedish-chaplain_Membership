/**
 * DV-5 — pure client-side validation predicates for the cancel-cycle +
 * mark-paid-offline forms, extracted from `<CycleAdminActions>` so they are
 * unit-testable WITHOUT rendering the Base UI dialogs (which deadlock under
 * jsdom + React 19 `startTransition` — see the dialog-jsdom-hang memory). The
 * dialog INTERACTION (open → fill → submit) is covered by the Playwright e2e
 * (`tests/e2e/renewal-admin-actions.spec.ts`); these predicates carry the
 * field-level enable/disable rules a real-browser e2e shouldn't enumerate.
 */

/** Cancel reason length bounds — mirror the route's zod `min(1).max(500)`. */
export const REASON_MIN = 1;
export const REASON_MAX = 500;

/**
 * True when the cancel reason (trimmed) is empty or over the 500-char cap —
 * i.e. the Cancel confirm button must stay disabled. Trimming matches the
 * value the handler actually submits (`reason.trim()`).
 */
export function isCancelReasonInvalid(reason: string): boolean {
  const trimmed = reason.trim();
  return trimmed.length < REASON_MIN || trimmed.length > REASON_MAX;
}

/**
 * True when a required mark-paid-offline field is missing — i.e. the confirm
 * button must stay disabled. `payment_method` is always set (the Select
 * defaults to `bank_transfer` and offers no empty option), so only the
 * (trimmed) reference and the date can be blank.
 *
 * This is ONLY an enable/disable gate for required-field presence. It
 * deliberately does NOT replicate the route's deeper validation (reference
 * `max(100)` + PAN-like refine, `payment_date` YYYY-MM-DD regex) — the route
 * stays the source of truth and surfaces those as `invalid_body`. Do not
 * "tighten" this to duplicate server validation.
 */
export function isMarkPaidIncomplete(
  paymentReference: string,
  paymentDate: string,
): boolean {
  return paymentReference.trim().length === 0 || paymentDate.length === 0;
}
