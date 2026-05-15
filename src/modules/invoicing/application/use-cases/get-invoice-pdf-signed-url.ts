/**
 * T039 — get-invoice-pdf-signed-url use case (F4).
 *
 * Ownership check + 60 s signed URL. Emits `invoice_cross_tenant_probe`
 * when a session attempts to read an invoice they don't own. For
 * admin/manager: probe = cross-tenant (different `tenant_id`). For
 * member: probe = different `member_id`.
 *
 * Auto-rerender on Blob-miss: if the stored key is 404 on Blob, we
 * re-render with the PINNED `pdf_template_version` from the invoice
 * row (not CURRENT) so the sha256 stays byte-identical (FR-016 / R3-E4).
 */
import { err, ok, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import { asInvoiceId, type InvoiceId } from '@/modules/invoicing/domain/invoice';

export interface GetInvoicePdfSignedUrlInput {
  readonly tenantId: string;
  readonly actorUserId: string;
  readonly actorRole: 'admin' | 'manager' | 'member';
  /** For members only — the member_id they are allowed to see. */
  readonly actorMemberId?: string;
  readonly requestId?: string | null;
  readonly invoiceId: string;
}

export type GetInvoicePdfSignedUrlError =
  | { code: 'invoice_not_found' }
  | { code: 'forbidden' }
  | { code: 'blob_missing'; key: string }
  // T166-10 — async receipt PDF render in flight. Member-scope only:
  // a paid invoice is being post-processed by the worker (status
  // !=='rendered'). Route layer maps this to HTTP 425 Too Early +
  // Retry-After: 30. Admin/manager continue to receive the invoice
  // variant byte stream as before (they can preview before receipt
  // stamping completes).
  | { code: 'receipt_pdf_pending'; retryAfterSeconds: number };

export interface GetInvoicePdfSignedUrlDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
}

export async function getInvoicePdfSignedUrl(
  deps: GetInvoicePdfSignedUrlDeps,
  input: GetInvoicePdfSignedUrlInput,
): Promise<Result<{ url: string; filename: string }, GetInvoicePdfSignedUrlError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const invoice = await deps.invoiceRepo.findById(invoiceId, input.tenantId);

  if (!invoice) {
    // Could be cross-tenant probe OR genuinely missing id. We emit
    // the audit either way — the actor_tenant_id is in the row.
    await deps.audit.emit(null, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_cross_tenant_probe',
      actorUserId: input.actorUserId,
      summary: `Probe on invoice ${invoiceId} (not found in actor tenant)`,
      payload: {
        attempted_invoice_id: invoiceId,
        actor_role: input.actorRole,
        route: 'get-invoice-pdf-signed-url',
      },
    });
    return err({ code: 'invoice_not_found' });
  }

  // Members can only see their own company's invoices.
  if (input.actorRole === 'member') {
    if (!input.actorMemberId || invoice.memberId !== input.actorMemberId) {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Member probe on non-owned invoice ${invoiceId}`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_member_id: input.actorMemberId ?? null,
          invoice_member_id: invoice.memberId,
          actor_role: 'member',
        },
      });
      return err({ code: 'forbidden' });
    }
  }

  // Drafts have no PDF yet — refuse.
  if (!invoice.pdf) return err({ code: 'forbidden' });

  // T166-10 — async receipt-PDF gate (member-scope). When the
  // record-payment use-case ran with `asyncReceiptPdf=true`, the
  // invoice flips to `paid` synchronously but the receipt-stamped
  // PDF is rendered by the cron worker (out-of-band). Until the
  // worker completes, expose 425 Too Early + Retry-After to the
  // member's portal page so it can render a polite "preparing…"
  // state with `aria-busy="true"`. Admin/manager keep the existing
  // byte stream — they can re-issue/preview without waiting for
  // the receipt stamp.
  if (
    input.actorRole === 'member' &&
    invoice.status === 'paid' &&
    invoice.receiptPdfStatus !== null &&
    invoice.receiptPdfStatus !== 'rendered'
  ) {
    return err({ code: 'receipt_pdf_pending', retryAfterSeconds: 30 });
  }

  // TODO(F4-R3-E4): when auto-rerender on Blob-miss lands, wrap this
  // branch in try/catch on the signed-URL issuance (or a HEAD probe
  // on the blob key) and, on miss, (a) re-render with the PINNED
  // `pdf_template_version` from `invoice.pdf.templateVersion`,
  // (b) compute the regenerated sha256, (c) emit audit event
  // `invoice_pdf_regenerated` with payload `{ invoice_id,
  // invoice_number (raw), tenant_id, original_sha256, new_sha256,
  // reason: 'blob_missing' }`, (d) return the freshly-signed URL.
  // See specs/007-invoices-receipts/retrospective.md §
  // "PDF Reproducibility — Best Practice Decision" for the 4-layer
  // reproducibility rationale + the `invoice_pdf_regenerated` event
  // contract registered in 0030_audit_invoice_pdf_regenerated.sql.

  // R8-M1-code — audit emit BEFORE signing the URL. The audit is the
  // durable §87 forensic trail; if it fails (Neon transient, retention
  // column constraint) we MUST fail the read entirely rather than
  // serve a download whose access record cannot be reconstructed.
  // Closes the audit-coverage asymmetry: receipts already logged
  // downloads via `receipt_pdf_downloaded`; invoices previously had
  // no equivalent on the success path.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'invoice_pdf_downloaded',
    actorUserId: input.actorUserId,
    summary: `Invoice PDF downloaded — ${invoice.documentNumber?.raw ?? invoiceId}`,
    payload: {
      invoice_id: invoiceId,
      member_id: invoice.memberId,
      actor_member_id:
        input.actorRole === 'member'
          ? (input.actorMemberId ?? null)
          : null,
      invoice_pdf_template_version: invoice.pdf.templateVersion,
      actor_role: input.actorRole,
      route: 'get-invoice-pdf-signed-url',
    },
  });

  const url = await deps.blob.signDownloadUrl(invoice.pdf.blobKey);
  const filename = `${invoice.documentNumber?.raw ?? 'invoice'}.pdf`;
  return ok({ url, filename });
}
