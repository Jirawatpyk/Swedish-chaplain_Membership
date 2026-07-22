/**
 * 088 T021a / FR-032 — void-invoice error routing (pure).
 *
 * Voiding RETIRES the invoice's sequential §87 document number (it can never be
 * reused), re-stamps the PDF VOID, and emails a cancellation notice — a
 * terminal, irreversible-in-effect mutation. So a void FAILURE must never
 * surface on a transient toast; the confirm dialog surfaces it INLINE (focused
 * role="alert"). This pure router classifies the void route's error codes:
 *
 *   - `concurrent` — a stale-write 409: the invoice is no longer issued-unpaid
 *     (`invalid_status` — already voided / paid in another session) or the
 *     optimistic lock lost (`concurrent_state_change`). Show an inline "already
 *     voided — refresh", NOT a red error, so the admin reloads the fresh state.
 *   - `failure`    — every other typed code (`invoice_not_found`,
 *     `settings_missing`, `no_snapshot_on_invoice`, `pdf_render_failed`) has no
 *     dedicated operator-actionable copy, so it degrades to a codeFallback
 *     carrying the raw code (or the generic unknown copy for a missing code).
 *
 * Pure `.ts` leaf (no React import graph) so the classification + i18n-key
 * selection are unit-testable and the dialog stays a thin shell. Sibling of
 * `credit-note-error-routing.ts` / the invoices `issue-error-routing.ts` /
 * `record-payment-error-routing.ts` — they carry different code sets. Defensive:
 * any unlisted code degrades to codeFallback.
 */

export type VoidErrorRouting =
  | { readonly kind: 'concurrent' }
  | {
      readonly kind: 'failure';
      /** i18n key relative to `admin.invoices.void.`. */
      readonly messageKey: string;
      /** Raw code passed to `errors.codeFallback` interpolation, when used. */
      readonly codeArg?: string;
    };

/** 409 stale-write codes → an inline "already voided — refresh". */
const CONCURRENT_CODES: ReadonlySet<string> = new Set([
  'invalid_status',
  'concurrent_state_change',
]);

export function routeVoidError(
  code: string | undefined | null,
): VoidErrorRouting {
  if (code && CONCURRENT_CODES.has(code)) return { kind: 'concurrent' };
  // 8A — a refund is settling on this invoice; voiding now would strand it.
  // A dedicated actionable message, NOT `concurrent` (the invoice is still
  // voidable, just temporarily blocked) nor a raw code dump.
  if (code === 'refund_in_progress') {
    return { kind: 'failure', messageKey: 'errors.refundInProgress' };
  }
  if (code) return { kind: 'failure', messageKey: 'errors.codeFallback', codeArg: code };
  return { kind: 'failure', messageKey: 'errors.unknown' };
}
