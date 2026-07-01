/**
 * 088 T021a / FR-032 — issue-invoice error routing (pure).
 *
 * Issuing pins an IMMUTABLE §86/4 tax snapshot (void-only to change); a failure
 * is irreversible-in-effect, so the dialog surfaces it INLINE (focused
 * role="alert"), never on a transient toast. Sibling of
 * `record-payment-error-routing.ts` (they carry different code sets):
 *   - `concurrent` — `invoice_already_issued` (a stale-write 409 replay) →
 *     inline "already issued — refresh";
 *   - `failure`    — a dedicated operator-actionable message
 *     (`event_no_tin_requires_paid_issue`, `registration_refunded`), a
 *     codeFallback carrying the raw code, or the generic unknown copy.
 *
 * Pure `.ts` leaf (no React import graph) so the classification + i18n-key
 * selection are unit-testable and the dialog stays a thin shell. Defensive —
 * any unlisted code degrades to codeFallback.
 */

export type IssueErrorRouting =
  | { readonly kind: 'concurrent' }
  | {
      readonly kind: 'failure';
      /** i18n key relative to `admin.invoices.issue.`. */
      readonly messageKey: string;
      /** Raw code passed to `errors.codeFallback` interpolation, when used. */
      readonly codeArg?: string;
    };

/** Stale-write 409 → inline "already issued — refresh". */
const CONCURRENT_CODES: ReadonlySet<string> = new Set(['invoice_already_issued']);

/** Codes with dedicated, operator-actionable inline copy (existing keys). */
const DEDICATED_MESSAGE_CODES: ReadonlySet<string> = new Set([
  'event_no_tin_requires_paid_issue',
  'registration_refunded',
]);

export function routeIssueError(
  code: string | undefined | null,
): IssueErrorRouting {
  if (code && CONCURRENT_CODES.has(code)) return { kind: 'concurrent' };
  if (code && DEDICATED_MESSAGE_CODES.has(code)) {
    return { kind: 'failure', messageKey: `errors.${code}` };
  }
  if (code) return { kind: 'failure', messageKey: 'errors.codeFallback', codeArg: code };
  return { kind: 'failure', messageKey: 'errors.unknown' };
}
