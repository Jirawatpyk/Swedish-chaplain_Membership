/**
 * PG-3 — sanitise a potentially PII-laden error message before it lands
 * in a typed error returned across the Application boundary. Truncate
 * to 200 chars and redact 13-digit sequences that could be Thai tax IDs.
 *
 * Extracted from `void-invoice.ts` (unchanged) so `build-void-render-targets`
 * can reuse it without importing the use-case (which would cycle:
 * void-invoice → build-void-render-targets → void-invoice). `void-invoice`
 * re-exports it so the existing T-SAN unit test import stays valid.
 *
 * Exported for unit testing (T-SAN). Callers within the module use it
 * directly; external consumers SHOULD NOT — the return-value semantics
 * ("best-effort redacted, not a security guarantee") are
 * call-site-specific.
 */
export function sanitiseErrorReason(raw: unknown): string {
  const s = String(raw).replace(/\d{13}/g, '[REDACTED-TAXID]');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}
