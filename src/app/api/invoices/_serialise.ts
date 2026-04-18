/**
 * T052 — Presentation serialiser for Invoice → JSON DTO.
 *
 * Domain types (Money, DocumentNumber, etc.) don't serialise natively —
 * `JSON.stringify` on a `Money` returns `{"satang":"..."}` because BigInt
 * throws. We map to a plain object here so the HTTP envelope is simple.
 */
import type { Invoice } from '@/modules/invoicing';

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
    pdf_blob_key: invoice.pdfBlobKey,
    pdf_sha256: invoice.pdfSha256,
    pdf_template_version: invoice.pdfTemplateVersion,
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
