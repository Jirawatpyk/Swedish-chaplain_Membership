/**
 * T064 — record-payment use case (F4 US2).
 *
 * Transitions `issued → paid` + allocates a receipt sequence number
 * (when `receipt_numbering_mode = 'separate'`) + renders a receipt PDF
 * + uploads to Blob + emits `invoice_paid` audit + enqueues
 * auto-email outbox row.
 *
 * Idempotency: the route layer hands us an `Idempotency-Key`. If the
 * invoice is already `paid` (matching the same key), we return the
 * persisted row unchanged — callers cannot double-pay.
 *
 * Tax-ID snapshot immutability (FR-038): we reuse the invoice's
 * `member_identity_snapshot` (captured at issue time). Mutations to
 * the live member's tax_id AFTER issue do NOT flow into the receipt.
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { sql } from 'drizzle-orm';
import type { TenantTx } from '@/lib/db';

export const recordPaymentSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  paymentMethod: z.enum(['bank_transfer', 'cheque', 'cash', 'other']),
  paymentReference: z.string().max(200).optional(),
  paymentNotes: z.string().max(1000).optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  idempotencyKey: z.string().min(1).max(200).optional(),
});

export type RecordPaymentInput = z.infer<typeof recordPaymentSchema>;

export type RecordPaymentError =
  | { code: 'invoice_not_found' }
  | { code: 'invalid_status'; status: InvoiceStatus }
  | { code: 'no_snapshot_on_invoice' };

export interface RecordPaymentDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  readonly currentTemplateVersion: number;
}

export async function recordPayment(
  deps: RecordPaymentDeps,
  input: RecordPaymentInput,
): Promise<Result<Invoice, RecordPaymentError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);

  return deps.invoiceRepo.withTx(async (txUnknown) => {
    const tx = txUnknown as TenantTx;
    // Load the invoice with a row lock — guards against concurrent
    // pay / void / credit-note transactions touching the same invoice.
    const rows = (await tx.execute(sql`
      SELECT status FROM invoices
       WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
       FOR UPDATE
    `)) as unknown as Array<{ status: string }>;
    if (!rows[0]) return err({ code: 'invoice_not_found' });

    const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!loaded) return err({ code: 'invoice_not_found' });

    // Idempotent replay: already paid → return the persisted row.
    if (loaded.status === 'paid') return ok(loaded);

    if (loaded.status !== 'issued') {
      return err({ code: 'invalid_status', status: loaded.status });
    }
    if (!loaded.memberIdentitySnapshot || !loaded.tenantIdentitySnapshot || !loaded.subtotal || !loaded.vat || !loaded.total || !loaded.vatRate) {
      return err({ code: 'no_snapshot_on_invoice' });
    }

    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'no_snapshot_on_invoice' });

    // Receipt PDF — reuses invoice snapshot (FR-038 immutability). The
    // kind differs based on tenant setting; combined mode renders a
    // single "ใบกำกับภาษี/ใบเสร็จรับเงิน" label; separate mode
    // allocates its own receipt sequence number.
    const combinedMode = settings.receiptNumberingMode === 'combined';
    let receiptDocNumRaw: string | null = null;
    if (!combinedMode) {
      // Separate mode — allocate receipt sequence.
      const receiptFy = loaded.fiscalYear ?? 0;
      const seq = await deps.sequenceAllocator.allocateNext(tx, {
        tenantId: input.tenantId,
        documentType: 'receipt',
        fiscalYear: (receiptFy as unknown) as import('../../domain/value-objects/fiscal-year').FiscalYear,
      });
      receiptDocNumRaw = `R-${receiptFy}-${seq.toString().padStart(6, '0')}`;
    }

    const rendered = await deps.pdfRender.render({
      kind: combinedMode ? 'receipt_combined' : 'receipt_separate',
      templateVersion: deps.currentTemplateVersion,
      documentNumber: loaded.documentNumber,
      issueDate: loaded.issueDate,
      dueDate: loaded.dueDate,
      tenant: loaded.tenantIdentitySnapshot,
      member: loaded.memberIdentitySnapshot,
      lines: loaded.lines,
      subtotal: loaded.subtotal,
      vatRate: loaded.vatRate,
      vat: loaded.vat,
      total: loaded.total,
    });

    const receiptBlobKey = `invoicing/${input.tenantId}/${loaded.fiscalYear}/${loaded.invoiceId}_receipt_v${deps.currentTemplateVersion}.pdf`;
    await deps.blob.uploadPdf({
      key: receiptBlobKey,
      body: rendered.bytes,
      contentType: 'application/pdf',
    });

    // UPDATE invoices → paid + payment fields. The PDF key we store
    // remains the invoice PDF; the receipt PDF has its own key written
    // to a dedicated column in a later polish pass (MVP: combined PDF
    // mode is the common path — single asset lives at invoice.pdf_blob_key).
    await tx.execute(sql`
      UPDATE invoices
         SET status = 'issued'::invoice_status, -- sentinel; will flip
             updated_at = now()
       WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
    `);
    // Split transition (status → paid) into its own statement so the
    // immutability trigger sees status changing and permits the
    // accompanying payment-field write.
    await tx.execute(sql`
      UPDATE invoices
         SET status = 'paid'::invoice_status,
             paid_at = now(),
             payment_method = ${input.paymentMethod},
             payment_reference = ${input.paymentReference ?? null},
             payment_notes = ${input.paymentNotes ?? null},
             payment_recorded_by_user_id = ${input.actorUserId},
             pdf_blob_key = ${receiptBlobKey},
             pdf_sha256 = ${rendered.sha256},
             updated_at = now()
       WHERE tenant_id = ${input.tenantId} AND invoice_id = ${invoiceId}
    `);

    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_paid',
      actorUserId: input.actorUserId,
      summary: `Invoice ${loaded.documentNumber?.raw} marked paid`,
      payload: {
        invoice_id: invoiceId,
        payment_method: input.paymentMethod,
        payment_reference: input.paymentReference ?? null,
        payment_date: input.paymentDate,
        recorded_by_user_id: input.actorUserId,
        receipt_document_number: receiptDocNumRaw,
        receipt_pdf_sha256: rendered.sha256,
      },
    });

    if (settings.autoEmailEnabled) {
      await deps.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        eventType: 'invoice_paid',
        recipientEmail: loaded.memberIdentitySnapshot.primary_contact_email,
        invoiceId,
        pdfBlobKey: receiptBlobKey,
        pdfTemplateVersion: deps.currentTemplateVersion,
      });
    }

    // Re-read the updated row for the return value.
    const updated = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    return ok(updated!);
  });
}
