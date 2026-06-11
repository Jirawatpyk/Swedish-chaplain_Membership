/**
 * T052 — Presentation serialiser for Invoice → JSON DTO.
 *
 * Domain types (Money, DocumentNumber, etc.) don't serialise natively —
 * `JSON.stringify` on a `Money` returns `{"satang":"..."}` because BigInt
 * throws. We map to a plain object here so the HTTP envelope is simple.
 */
import type { Invoice } from '@/modules/invoicing';

/**
 * Strip the `reason` field from a typed error object before returning
 * it to an HTTP client. `reason` is infrastructure detail (raw
 * `String(e)` from @react-pdf or Vercel Blob) that may include font
 * paths, blob URLs, or stack-trace fragments — the full context is
 * already captured by the use-case logger.
 */
export function stripReason<E extends { code: string }>(error: E): Omit<E, 'reason'> {
  if ('reason' in error) {
    const clone: Record<string, unknown> = { ...error };
    delete clone.reason;
    return clone as Omit<E, 'reason'>;
  }
  return error;
}

/**
 * Wave-4 S16 — shared HTTP status map for the two issuance routes
 * (/issue and /issue-as-paid), which previously duplicated an 11-arm
 * ternary. Codes BOTH use-cases can emit live here; codes only one route
 * can see go in that route's explicit `overrides` (kept per-route so a
 * reviewer sees the route-specific surface next to the handler).
 *
 * Rationale pins (carried from the former inline ternaries):
 *   - registration_refunded → 422: registration refunded between draft and
 *     issuance (TOCTOU re-check) — unprocessable business state, mirrors
 *     the event-draft route. `registration_lookup_failed` is deliberately
 *     ABSENT (internal verification error → the 500 default).
 *   - pdf_render_failed / blob_upload_failed → 500: infrastructure
 *     failures after rollback.
 *
 * Exported (065 review follow-up) ONLY for the unit pin in
 * tests/unit/invoicing/issue-error-status.test.ts, which asserts the full
 * map INCLUDING the deliberate `registration_lookup_failed` absence — a
 * semantic `issueErrorStatus` alone cannot distinguish (absent and
 * mapped-to-500 are behaviourally identical). Routes must keep calling
 * `issueErrorStatus`, never index this map directly.
 */
export const ISSUE_ERROR_STATUS_BASE: Readonly<Record<string, number>> = {
  invoice_not_found: 404,
  member_not_found: 404,
  invoice_already_issued: 409,
  member_archived: 409,
  settings_missing: 409,
  registration_refunded: 422,
  invalid_lines: 422,
  no_buyer_snapshot: 422,
  overflow: 422,
  pdf_render_failed: 500,
  blob_upload_failed: 500,
};

/** Resolve the response status for an issuance-route error code (default 500). */
export function issueErrorStatus(
  code: string,
  overrides?: Readonly<Record<string, number>>,
): number {
  return overrides?.[code] ?? ISSUE_ERROR_STATUS_BASE[code] ?? 500;
}

/**
 * 065 M-4 — issuance failures that are SERVER faults (infrastructure outage
 * or §87 number-space exhaustion), never operator mistakes. The /issue and
 * /issue-as-paid route handlers log these at ERROR severity so ops alerting
 * catches them; every other code (validation, races, business rejects) stays
 * at WARN. Mirrors the severity split inside the two use-cases' catches.
 */
const ISSUANCE_SERVER_FAULT_CODES: ReadonlySet<string> = new Set([
  'overflow',
  'pdf_render_failed',
  'blob_upload_failed',
]);

export function isIssuanceServerFault(code: string): boolean {
  return ISSUANCE_SERVER_FAULT_CODES.has(code);
}

export function serialiseInvoice(invoice: Invoice) {
  return {
    tenant_id: invoice.tenantId,
    invoice_id: invoice.invoiceId,
    member_id: invoice.memberId,
    plan_id: invoice.planId,
    plan_year: invoice.planYear,
    status: invoice.status,
    fiscal_year: invoice.fiscalYear,
    sequence_number: invoice.sequenceNumber,
    document_number: invoice.documentNumber?.raw ?? null,
    issue_date: invoice.issueDate,
    due_date: invoice.dueDate,
    paid_at: invoice.paidAt,
    voided_at: invoice.voidedAt,
    currency: invoice.currency,
    subtotal_satang: invoice.subtotal?.satang.toString() ?? null,
    vat_rate: invoice.vatRate?.raw ?? null,
    vat_satang: invoice.vat?.satang.toString() ?? null,
    total_satang: invoice.total?.satang.toString() ?? null,
    credited_total_satang: invoice.creditedTotal.satang.toString(),
    // n20: internal Vercel Blob object keys (`invoicing/{tenantId}/{fy}/{uuid}`)
    // are NOT surfaced — they expose infra/tenant structure and are unused by
    // the admin UI (which fetches PDFs via the dedicated /api/invoices/[id]/pdf
    // route). pdf_sha256 (content hash for integrity) is retained.
    pdf_sha256: invoice.pdf?.sha256 ?? null,
    pdf_template_version: invoice.pdf?.templateVersion ?? null,
    // Receipt-PDF surface (separate-mode keeps its own §87 sequence
    // number + its own rendered bytes; combined-mode reuses the
    // invoice document number with `receipt_document_number_raw` = null).
    receipt_document_number_raw: invoice.receiptDocumentNumberRaw,
    receipt_pdf_status: invoice.receiptPdfStatus,
    // n20: receipt blob key withheld (same rationale as pdf_blob_key above).
    receipt_pdf_sha256: invoice.receiptPdf?.sha256 ?? null,
    receipt_pdf_template_version: invoice.receiptPdf?.templateVersion ?? null,
    auto_email_on_issue: invoice.autoEmailOnIssue,
    created_at: invoice.createdAt,
    updated_at: invoice.updatedAt,
    lines: invoice.lines.map((l) => ({
      line_id: l.lineId,
      kind: l.kind,
      description_th: l.descriptionTh,
      description_en: l.descriptionEn,
      unit_price_satang: l.unitPrice.satang.toString(),
      quantity: l.quantity,
      pro_rate_factor: l.proRateFactor,
      total_satang: l.total.satang.toString(),
      position: l.position,
    })),
  };
}
