/**
 * T080 — Presentation serialiser for CreditNote → JSON DTO (F4 / US6).
 */
import type { CreditNote } from '@/modules/invoicing';

export function serialiseCreditNote(cn: CreditNote) {
  return {
    tenant_id: cn.tenantId,
    credit_note_id: cn.creditNoteId,
    original_invoice_id: cn.originalInvoiceId,
    fiscal_year: cn.fiscalYear,
    sequence_number: cn.sequenceNumber,
    document_number: cn.documentNumber.raw,
    issue_date: cn.issueDate,
    issued_by_user_id: cn.issuedByUserId,
    reason: cn.reason,
    credit_amount_satang: cn.creditAmount.satang.toString(),
    vat_satang: cn.vat.satang.toString(),
    total_satang: cn.total.satang.toString(),
    pdf_blob_key: cn.pdf.blobKey,
    pdf_sha256: cn.pdf.sha256,
    pdf_template_version: cn.pdf.templateVersion,
    created_at: cn.createdAt,
    updated_at: cn.updatedAt,
  };
}
