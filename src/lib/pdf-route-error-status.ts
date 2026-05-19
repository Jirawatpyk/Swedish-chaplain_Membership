/**
 * Shared HTTP-status mapping for the six F4 PDF download routes
 * (admin + portal × invoice / receipt / credit-note).
 *
 * Each route's use-case Result.err carries a `code` discriminating
 * the failure mode; the same code must produce the same HTTP status
 * across all routes so operator dashboards can telemetry-split
 * "missing on Blob" (502) from "access denied" (403) from "not
 * found" (404). Inline status-ladder duplication drifted in the past
 * (one route mapped `blob_missing → 500` while siblings used 502);
 * a single helper closes that drift.
 *
 * Codes that have route-specific bodies (e.g. `receipt_pdf_pending`
 * + `Retry-After` header, or `receipt_pdf_failed` + `reason` field)
 * are handled inline at the call site BEFORE invoking this helper.
 */
export type PdfRouteErrorCode =
  | 'invoice_not_found'
  | 'credit_note_not_found'
  | 'blob_missing'
  | 'forbidden'
  | 'receipt_pdf_pending'
  | 'receipt_pdf_failed';

/**
 * Returns the HTTP status that the F4 PDF routes uniformly map a
 * use-case error code to. Falls back to 500 for unrecognised codes —
 * the route's pino warn log will surface the unmapped value so
 * operators see the drift before users do.
 */
export function pdfRouteErrorStatus(code: string): number {
  switch (code) {
    case 'invoice_not_found':
    case 'credit_note_not_found':
      return 404;
    case 'blob_missing':
    case 'receipt_pdf_failed':
      return 502;
    case 'receipt_pdf_pending':
      return 425;
    case 'forbidden':
      return 403;
    default:
      return 500;
  }
}
