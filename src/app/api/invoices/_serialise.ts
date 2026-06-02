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
