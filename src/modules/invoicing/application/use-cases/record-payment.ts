/**
 * T064 — record-payment use case (F4 US2).
 *
 * Transitions `issued → paid` + allocates a receipt sequence number
 * (when `receipt_numbering_mode = 'separate'`) + renders a receipt PDF
 * + uploads to Blob + emits `invoice_paid` audit + enqueues
 * auto-email outbox row.
 *
 * Idempotency: status-based replay detection. If the invoice is
 * already `paid` we short-circuit and return the persisted row
 * unchanged — callers cannot double-pay the same invoice, regardless
 * of retry. The `idempotencyKey` field in the input schema is
 * RESERVED for the future key-persistence upgrade tracked in F4
 * Phase 10 polish (see specs/007-invoices-receipts/tasks.md § Phase
 * 10 — idempotency-key storage). It is accepted to stabilise the
 * request shape now, but ignored by the use case today.
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
import type { MemberIdentityPort } from '../ports/member-identity-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { logger } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';

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
 * the sequence increment. See `lib/tx-abort.ts` for the shared pattern.
 */
class RecordPaymentInternalError extends TxAbort<RecordPaymentError> {
  // Hardcode the class name so production minifiers can't mangle it
  // in logger output (L3).
  override readonly name = 'RecordPaymentInternalError';
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
  readonly memberIdentity: MemberIdentityPort;
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
    // transactions on the same invoice. Branch on the locked status
    // directly so the idempotent-replay and invalid-status paths don't
    // require a second read that could race with a concurrent delete.
    const lockedStatus = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
    if (!lockedStatus) {
      // R7-W1 — probe on not-found (RLS-hidden vs. truly-missing is
      // indistinguishable from the app layer; audit either way per
      // Constitution Principle I clause 4). Emit via `null` tx so
      // the audit survives the outer withTx's commit/rollback.
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_cross_tenant_probe',
        actorUserId: input.actorUserId,
        summary: `Probe on invoice ${invoiceId} (not found on record-payment)`,
        payload: {
          attempted_invoice_id: invoiceId,
          actor_role: 'admin',
          route: 'record-payment',
        },
      });
      return err({ code: 'invoice_not_found' });
    }

    // Idempotent replay: already paid → fetch + return the persisted row.
    if (lockedStatus === 'paid') {
      const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
      if (!loaded) return err({ code: 'invoice_not_found' });
      return ok(loaded);
    }

    if (lockedStatus !== 'issued') {
      return err({ code: 'invalid_status', status: lockedStatus });
    }

    const loaded = await deps.invoiceRepo.findDraftById(tx, invoiceId, input.tenantId);
    if (!loaded) return err({ code: 'invoice_not_found' });
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
    let receiptDocNum: DocumentNumber | null = null;
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
      receiptDocNum = receiptDoc.value;
      receiptDocNumRaw = receiptDoc.value.raw;
    }

    // H. Render PDF — throw (not return err) on failure so withTx rolls
    // back and the sequence increment is NOT consumed.
    let rendered: Awaited<ReturnType<typeof deps.pdfRender.render>>;
    try {
      rendered = await deps.pdfRender.render({
        kind: combinedMode ? 'receipt_combined' : 'receipt_separate',
        templateVersion: deps.currentTemplateVersion,
        // Separate-mode receipt MUST use its own document number (the
        // one just allocated); combined-mode reuses the invoice
        // number because the document IS the same physical page
        // (one combined ใบกำกับภาษี/ใบเสร็จรับเงิน).
        documentNumber: combinedMode ? loaded.documentNumber : receiptDocNum,
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
        // R7-W5 — persist admin-entered payment date on the invoice
        // row (separate from paidAt = server-side mark-paid ts).
        paymentDate: input.paymentDate,
        receiptPdf: {
          blobKey: receiptBlobKey,
          sha256: rendered.sha256,
          templateVersion: deps.currentTemplateVersion,
        },
      });
    } catch (e) {
      if (e instanceof InvoiceApplyConflictError && e.kind === 'applyPayment') {
        throw new RecordPaymentInternalError({ code: 'concurrent_state_change' });
      }
      throw e;
    }

    // W9 fix — payment_reference is a free-form admin-entered string
    // that commonly carries partial bank account numbers / cheque
    // numbers / other PII that falls under the Constitution's
    // forbidden-in-logs rule. Audit retention is 10 years (FR-029),
    // which makes the exposure window long even if audit access is
    // tightly restricted. We persist a sha256 instead so reviewers
    // can still detect duplicates, correlate with the plaintext on
    // the invoice row (short-term lookup), and verify against a
    // submitted reference — without storing the plaintext.
    const paymentReferenceSha256 = input.paymentReference
      ? sha256Hex(input.paymentReference)
      : null;
    await deps.audit.emit(tx, {
      tenantId: input.tenantId,
      requestId: input.requestId ?? null,
      eventType: 'invoice_paid',
      actorUserId: input.actorUserId,
      summary: `Invoice ${loaded.documentNumber?.raw} marked paid`,
      payload: {
        invoice_id: invoiceId,
        payment_method: input.paymentMethod,
        payment_reference_sha256: paymentReferenceSha256,
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

    // Spec § 398 — "registration fee once per member lifecycle". If
    // the paid invoice contained a registration_fee line, flip
    // members.registration_fee_paid = true so the NEXT invoice
    // doesn't double-charge. Runs inside the same transaction as
    // applyPayment so a rollback unwinds both writes atomically.
    // Idempotent — the adapter's WHERE registration_fee_paid=FALSE
    // makes replay on an already-true row a no-op.
    const hasRegistrationFee = loaded.lines.some(
      (l) => l.kind === 'registration_fee',
    );
    if (hasRegistrationFee) {
      await deps.memberIdentity.markRegistrationFeePaid(
        tx,
        input.tenantId,
        loaded.memberId,
      );
    }

    // `applyPayment` returns the refreshed row via RETURNING — no need
    // for a second findDraftById round-trip.
    return ok(updated);
  });
  } catch (e) {
    if (e instanceof RecordPaymentInternalError) {
      logger.warn(
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
