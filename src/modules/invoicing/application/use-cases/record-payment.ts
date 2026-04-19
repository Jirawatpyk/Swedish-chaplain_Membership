/**
 * T064 — record-payment use case (F4 US2).
 *
 * Transitions `issued → paid` + allocates a receipt sequence number
 * (when `receipt_numbering_mode = 'separate'`) + renders a receipt PDF
 * + uploads to Blob + emits `invoice_paid` audit + enqueues
 * auto-email outbox row.
 *
 * Idempotency: status-based replay detection. If the invoice is already
 * `paid` we short-circuit and return the persisted row unchanged —
 * callers cannot double-pay the same invoice, regardless of retry.
 * The `idempotencyKey` field in the input schema is RESERVED for a
 * future upgrade that stores the key on the row and validates matching
 * keys on replay; it is accepted but not currently persisted.
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
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { logger } from '@/lib/logger';

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
  | { code: 'no_snapshot_on_invoice' }
  | { code: 'settings_missing' }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'concurrent_state_change' };

/**
 * Internal throw-carrier: aborts the transaction AND propagates a typed
 * error up to the outer `try/catch`. Required for errors that occur
 * AFTER `sequenceAllocator.allocateNext` runs — returning `err(...)`
 * normally from the withTx callback resolves the promise and commits
 * the sequence increment.
 */
class RecordPaymentInternalError extends Error {
  readonly error: RecordPaymentError;
  constructor(error: RecordPaymentError) {
    super(`RecordPayment: ${error.code}`);
    this.error = error;
  }
}

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

  try {
  return await deps.invoiceRepo.withTx(async (tx) => {
    // Row-lock first — guards against concurrent pay/void/credit-note
    // transactions on the same invoice.
    const lockedStatus = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
    if (!lockedStatus) return err({ code: 'invoice_not_found' });

    const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!loaded) return err({ code: 'invoice_not_found' });

    // Idempotent replay: already paid → return the persisted row.
    if (loaded.status === 'paid') return ok(loaded);

    if (loaded.status !== 'issued') {
      return err({ code: 'invalid_status', status: loaded.status });
    }
    if (
      !loaded.memberIdentitySnapshot ||
      !loaded.tenantIdentitySnapshot ||
      !loaded.subtotal ||
      !loaded.vat ||
      !loaded.total ||
      !loaded.vatRate ||
      !loaded.fiscalYear
    ) {
      return err({ code: 'no_snapshot_on_invoice' });
    }

    const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
    if (!settings) return err({ code: 'settings_missing' });

    // Receipt PDF — reuses invoice snapshot (FR-038 immutability). The
    // kind differs based on tenant setting; combined mode renders a
    // single "ใบกำกับภาษี/ใบเสร็จรับเงิน" label; separate mode
    // allocates its own receipt sequence number.
    const combinedMode = settings.receiptNumberingMode === 'combined';
    let receiptDocNumRaw: string | null = null;
    if (!combinedMode) {
      // Separate mode — allocate receipt sequence. fiscalYear presence
      // was validated above (no_snapshot_on_invoice), so loaded.fiscalYear
      // is the frozen issue-time FY, never 0.
      const seq = await deps.sequenceAllocator.allocateNext(tx, {
        tenantId: input.tenantId,
        documentType: 'receipt',
        fiscalYear: loaded.fiscalYear,
      });
      const receiptDoc = DocumentNumber.of(
        settings.receiptNumberPrefix ?? 'RE',
        loaded.fiscalYear,
        seq,
      );
      if (!receiptDoc.ok) {
        // Throw so the tx rolls back and the sequence allocation is NOT
        // consumed by a failed receipt number assignment.
        throw new RecordPaymentInternalError({
          code: 'overflow',
          fiscalYear: loaded.fiscalYear,
        });
      }
      receiptDocNumRaw = receiptDoc.value.raw;
    }

    // H. Render PDF — throw (not return err) on failure so withTx rolls
    // back and the sequence increment is NOT consumed.
    let rendered: { bytes: Uint8Array; sha256: string };
    try {
      rendered = await deps.pdfRender.render({
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
    } catch (e) {
      throw new RecordPaymentInternalError({
        code: 'pdf_render_failed',
        reason: String(e),
      });
    }

    const receiptBlobKey = `invoicing/${input.tenantId}/${loaded.fiscalYear}/${loaded.invoiceId}_receipt_v${deps.currentTemplateVersion}.pdf`;
    try {
      await deps.blob.uploadPdf({
        key: receiptBlobKey,
        body: rendered.bytes,
        contentType: 'application/pdf',
      });
    } catch (e) {
      throw new RecordPaymentInternalError({
        code: 'blob_upload_failed',
        reason: String(e),
      });
    }

    // Atomic issued→paid UPDATE with payment fields + receipt PDF
    // metadata. The repo throws `applyPayment: no row updated` when
    // the status guard (WHERE status='issued') doesn't match — maps
    // to a typed `concurrent_state_change` error instead of leaking a
    // raw 500.
    let updated: Invoice;
    try {
      updated = await deps.invoiceRepo.applyPayment(tx, {
        tenantId: input.tenantId,
        invoiceId,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference ?? null,
        paymentNotes: input.paymentNotes ?? null,
        paymentRecordedByUserId: input.actorUserId,
        receiptPdfBlobKey: receiptBlobKey,
        receiptPdfSha256: rendered.sha256,
      });
    } catch (e) {
      if ((e as Error).message?.includes('applyPayment: no row updated')) {
        throw new RecordPaymentInternalError({ code: 'concurrent_state_change' });
      }
      throw e;
    }

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

    // `applyPayment` returns the refreshed row via RETURNING — no need
    // for a second findDraftById round-trip.
    return ok(updated);
  });
  } catch (e) {
    if (e instanceof RecordPaymentInternalError) {
      logger.error(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'recordPayment: internal error, rolling back',
      );
      return err(e.error);
    }
    throw e;
  }
}
