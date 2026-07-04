/**
 * 088 T021a / FR-032 — issue-credit-note error routing (pure).
 *
 * A credit note (§86/10 ใบลดหนี้) mints a NEW sequential §87 tax-document
 * number in-tx and moves the original invoice to credited / partially_credited;
 * once committed it cannot be silently rolled back client-side. So a credit
 * FAILURE must never surface on a transient toast — the modal surfaces it
 * INLINE (focused role="alert"). This pure router classifies the credit-note
 * route's error codes so the form can pick the right INLINE surface:
 *
 *   - `concurrent` — a stale-write 409: the invoice is no longer creditable
 *     (`invalid_status` — voided / fully credited elsewhere), the optimistic
 *     lock lost (`concurrent_state_change`), or the creditable remainder shrank
 *     because a concurrent credit note landed after this form rendered
 *     (`credit_exceeds_remainder`). Show an inline "already credited/voided —
 *     refresh", NOT a red error, so the admin reloads the fresh remainder.
 *   - `failure`    — a dedicated operator-actionable message
 *     (`receipt_not_creditable` → refund/void guidance; `receipt_not_rendered`
 *     → "tax receipt still generating, retry / re-render"), a codeFallback
 *     carrying the raw code, or the generic unknown copy.
 *
 * Pure `.ts` leaf (no React import graph) so the classification + i18n-key
 * selection are unit-testable and the form stays a thin shell. The code sets
 * are literals rather than an import of the server-only `issue-credit-note`
 * use-case graph (which pulls pino + node crypto and must not enter the client
 * bundle); the router is defensive — any unlisted code degrades to codeFallback.
 */

export type CreditNoteErrorRouting =
  | { readonly kind: 'concurrent' }
  | {
      readonly kind: 'failure';
      /** i18n key relative to `admin.creditNotes.new.`. */
      readonly messageKey: string;
      /** Raw code passed to `errors.codeFallback` interpolation, when used. */
      readonly codeArg?: string;
    };

/** 409 stale-write codes → an inline "already credited/voided — refresh". */
const CONCURRENT_CODES: ReadonlySet<string> = new Set([
  'invalid_status',
  'concurrent_state_change',
  'credit_exceeds_remainder',
]);

/**
 * Codes with dedicated, operator-actionable inline copy — mapped to EXISTING
 * message keys (camelCase) rather than the `errors.${code}` convention so the
 * shipped `errors.receiptNotCreditable` copy is reused (DRY, no duplicate key).
 */
const DEDICATED_MESSAGE_KEYS: Readonly<Record<string, string>> = {
  // §86/10 ruling — a §105 ใบเสร็จรับเงิน (receipt_separate, no-TIN buyer)
  // cannot be credited; point the admin at refund / void instead of a raw code.
  receipt_not_creditable: 'errors.receiptNotCreditable',
  // 088 US6 (whole-feature review) — the paid invoice's §86/4 tax-receipt PDF
  // has not rendered yet (async worker still 'pending', or 'failed' after its
  // retry budget), so a §86/10 note cannot cite a rendered receipt. TRANSIENT:
  // give the admin the actionable "still generating — retry / re-render"
  // guidance instead of a raw `errors.codeFallback` code dump.
  receipt_not_rendered: 'errors.receiptNotRendered',
};

export function routeCreditNoteError(
  code: string | undefined | null,
): CreditNoteErrorRouting {
  if (code && CONCURRENT_CODES.has(code)) return { kind: 'concurrent' };
  if (code && code in DEDICATED_MESSAGE_KEYS) {
    return { kind: 'failure', messageKey: DEDICATED_MESSAGE_KEYS[code]! };
  }
  if (code) return { kind: 'failure', messageKey: 'errors.codeFallback', codeArg: code };
  return { kind: 'failure', messageKey: 'errors.unknown' };
}
