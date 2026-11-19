/**
 * #739 B3a — the admin receipt-download toast for a failed receipt PDF.
 *
 * `GET /api/invoices/[id]/receipt/pdf` answers 502 `receipt_pdf_failed` with
 * `reason` = the stored `receipt_pdf_last_error`, a closed code such as
 * `render:TypeError`, `upload:BlobError` or `legacy_redacted` (older rows,
 * scrubbed by migration 0330). The toast shows fixed copy for the failing
 * step and never echoes the code.
 */
export type ReceiptFailedCopyKey =
  | 'toast.receiptFailedRender'
  | 'toast.receiptFailedUpload'
  | 'toast.receiptFailedUnknown';

export function receiptFailedCopyKey(reason: string): ReceiptFailedCopyKey {
  if (/^render(?:[:_]|$)/.test(reason)) return 'toast.receiptFailedRender';
  if (/^upload(?:[:_]|$)/.test(reason)) return 'toast.receiptFailedUpload';
  return 'toast.receiptFailedUnknown';
}
