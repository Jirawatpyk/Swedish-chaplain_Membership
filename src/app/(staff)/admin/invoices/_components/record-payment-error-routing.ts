/**
 * 088 T018a / FR-028 + FR-032 — record-payment error routing (pure).
 *
 * `recordPayment` mints the §87 `RC` tax number IN-TX at the payment moment; it
 * cannot be silently rolled back client-side. So its money-mutation modal must
 * never surface a failure on a transient toast (the admin could miss that the
 * mint did not complete). This pure router classifies the pay route's error
 * codes so the modal can render the right INLINE surface:
 *
 *   - `concurrent` — a stale-write 409 (`invalid_status` replay on an already-
 *     `paid` invoice, or `concurrent_state_change`): show an inline
 *     "already paid — refresh" message, NOT a red error, and prompt a reload so
 *     the admin picks up the already-minted `RC` number.
 *   - `failure`    — an irreversible §87-mint failure (`overflow`,
 *     `pdf_render_failed`, `blob_upload_failed`, the legacy-row guards, the
 *     088 flag-rollback guard, …): show an inline `role="alert"` (focused) with
 *     a dedicated message, a codeFallback carrying the raw code, or the generic
 *     unknown copy.
 *
 * Pure `.ts` leaf (no React import graph) so the i18n-key selection is unit-
 * testable and the modal stays a thin shell. The code sets are literals rather
 * than an import of the server-only `record-payment` use-case graph (which
 * pulls pino + node crypto and must not enter the client bundle); the router is
 * defensive — any unlisted code degrades to codeFallback.
 */

export type RecordPaymentErrorRouting =
  | { readonly kind: 'concurrent' }
  | {
      readonly kind: 'failure';
      /** i18n key relative to `admin.invoices.pay.`. */
      readonly messageKey: string;
      /** Raw code passed to `errors.codeFallback` interpolation, when used. */
      readonly codeArg?: string;
    };

/** 409 stale-write codes → an inline "already paid — refresh", not an error. */
const CONCURRENT_CODES: ReadonlySet<string> = new Set([
  'invalid_status',
  'concurrent_state_change',
]);

/** Codes with dedicated, operator-actionable inline copy. */
const DEDICATED_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'legacy_no_tin_event_needs_remediation',
  'legacy_invoice_needs_reissue',
  'new_flow_bill_requires_flag_on',
  // 066 §4.4(1) — terminated member: refuse the admin-manual payment with
  // the reactivate-first comeback copy (§4.4(4)).
  'membership_terminated',
]);

export function routeRecordPaymentError(
  code: string | undefined | null,
): RecordPaymentErrorRouting {
  if (code && CONCURRENT_CODES.has(code)) return { kind: 'concurrent' };
  if (code && DEDICATED_MESSAGE_CODES.has(code)) {
    return { kind: 'failure', messageKey: `errors.${code}` };
  }
  if (code) return { kind: 'failure', messageKey: 'errors.codeFallback', codeArg: code };
  return { kind: 'failure', messageKey: 'errors.unknown' };
}
