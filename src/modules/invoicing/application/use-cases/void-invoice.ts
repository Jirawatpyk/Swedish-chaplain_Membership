/**
 * T100 — void-invoice use case (F4 / US5 Phase 9).
 *
 * Transitions an ISSUED-UNPAID invoice → `void` with a required reason.
 * Void is terminal: the invoice keeps its sequential tax-document
 * number (§87 no-gap — never reused), the PDF is re-rendered with a
 * diagonal "VOID / ยกเลิก" overlay at the SAME content-addressed
 * Blob key (FR-008), and an `invoice_voided` audit event + cancellation
 * email outbox row ship inside the same transaction.
 *
 * Refusals:
 *   - `paid`                → direct admin to credit-note workflow (US6).
 *   - `void` / `credited` / `partially_credited` → terminal, re-void
 *                              / edit / further action blocked.
 *   - `draft`               → can't void a draft; use deleteInvoiceDraft.
 *
 * Canonical lock order (mirror of issue-invoice / record-payment):
 *   1. invoice row FOR UPDATE (lockForUpdate — serialises pay/void/CN)
 *
 * Operations (single DB transaction):
 *   A. lockForUpdate on invoice (cross-tenant probe audit on not-found)
 *   B. verify status == 'issued'
 *   C. load invoice row + verify snapshots present
 *   D. re-render PDF with VOID overlay using the PINNED issue-time
 *      templateVersion (R3-E4 / FR-016 — layout integrity preserved)
 *   E. overwrite Blob at the SAME content-addressed key
 *      (allowOverwrite: true — the re-rendered bytes differ by design)
 *   F. applyVoid UPDATE (status + void_reason + voided_by + voided_at
 *      + pdf_sha256)
 *   G. emit `invoice_voided` audit — `member_id` present so the F3
 *      timeline surfaces the void (FR-033 / US7 coupling)
 *   H. enqueue cancellation email outbox row with the VOID-stamped
 *      PDF attachment reference (FR-036) — gated on
 *      auto_email_on_issue per-invoice → tenant settings default
 *   I. COMMIT
 *
 * Any throw in A-H rolls back the whole tx — the sequence number is
 * NOT re-allocated (void keeps the original), the Blob overwrite is
 * idempotent (same key), and audit + outbox rows are reverted.
 *
 * RBAC: admin only (route handler guard).
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
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
import { logger } from '@/lib/logger';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';

export const voidInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  /** Free-text reason, required, 1-500 chars. Persisted + audited. */
  voidReason: z.string().trim().min(1).max(500),
});

export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

export type VoidInvoiceError =
  | { code: 'invoice_not_found' }
  | { code: 'invalid_status'; status: InvoiceStatus }
  | { code: 'no_snapshot_on_invoice' }
  | { code: 'settings_missing' }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string }
  | { code: 'concurrent_state_change' };

class VoidInvoiceInternalError extends TxAbort<VoidInvoiceError> {
  override readonly name = 'VoidInvoiceInternalError';
}

export interface VoidInvoiceDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
}

export async function voidInvoice(
  deps: VoidInvoiceDeps,
  input: VoidInvoiceInput,
): Promise<Result<Invoice, VoidInvoiceError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);

  // Settings read outside the outer tx (same reason as issue-credit-note
  // § 134 — nested `runInTenant` on concurrent voids would deadlock).
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);

  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      // A. Row-lock + status read in one round-trip.
      const lockedStatus = await deps.invoiceRepo.lockForUpdate(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!lockedStatus) {
        // Cross-tenant-probe on not-found (mirror issue-invoice
        // § 167). `null` tx so the probe row survives regardless of
        // outer commit/rollback.
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Probe on invoice ${invoiceId} (not found on void)`,
          payload: {
            attempted_invoice_id: invoiceId,
            actor_role: 'admin',
            route: 'void-invoice',
          },
        });
        return err({ code: 'invoice_not_found' });
      }

      // B. Only `issued` is voidable. `paid` → direct to credit-note;
      // `void` / `credited` / `partially_credited` → terminal; `draft`
      // → use deleteInvoiceDraft instead.
      if (lockedStatus !== 'issued') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }

      // C. Load the full row (under the lock) — need snapshots + PDF
      // metadata for the VOID re-render.
      const loaded = await deps.invoiceRepo.findByIdInTx(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!loaded) return err({ code: 'invoice_not_found' });
      if (
        !loaded.memberIdentitySnapshot ||
        !loaded.tenantIdentitySnapshot ||
        !loaded.subtotal ||
        !loaded.vat ||
        !loaded.total ||
        !loaded.vatRate ||
        !loaded.fiscalYear ||
        !loaded.documentNumber ||
        !loaded.issueDate ||
        !loaded.pdf
      ) {
        return err({ code: 'no_snapshot_on_invoice' });
      }
      if (!settings) return err({ code: 'settings_missing' });

      // D. Re-render with VOID overlay. `templateVersion` is pinned to
      // the issue-time value (FR-016 / R3-E4 layout-integrity rule) —
      // the overlay is additive, not a template change.
      let rerendered;
      try {
        rerendered = await deps.pdfRender.render({
          kind: 'void_stamped_invoice',
          templateVersion: loaded.pdf.templateVersion,
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
          voidReason: input.voidReason,
        });
      } catch (e) {
        throw new VoidInvoiceInternalError({
          code: 'pdf_render_failed',
          reason: String(e),
        });
      }

      // E. Overwrite Blob at the same content-addressed key. `allow
      // Overwrite: true` is MANDATORY — the re-rendered bytes differ
      // from the stored invoice by design (the diagonal overlay). Same
      // rationale as the US6 AS4 rollup re-render (see issue-credit-
      // note § 451).
      try {
        await deps.blob.uploadPdf({
          key: loaded.pdf.blobKey,
          body: rerendered.bytes,
          contentType: 'application/pdf',
          allowOverwrite: true,
        });
      } catch (e) {
        throw new VoidInvoiceInternalError({
          code: 'blob_upload_failed',
          reason: String(e),
        });
      }

      // F. applyVoid — status/void_reason/voided_by/voided_at +
      // pdf_sha256 (whitelisted by the immutability trigger). Throws
      // on WHERE-guard miss (concurrent pay/void race).
      let voided: Invoice;
      try {
        voided = await deps.invoiceRepo.applyVoid(tx, {
          tenantId: input.tenantId,
          invoiceId,
          voidReason: input.voidReason,
          voidedByUserId: input.actorUserId,
          pdfSha256: rerendered.sha256,
        });
      } catch (e) {
        if (e instanceof InvoiceApplyConflictError && e.kind === 'applyVoid') {
          throw new VoidInvoiceInternalError({ code: 'concurrent_state_change' });
        }
        throw e;
      }

      // G. Audit. `member_id` in payload → F3 timeline filter picks
      // this up (FR-033 / US7 coupling).
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_voided',
        actorUserId: input.actorUserId,
        summary: `Invoice ${loaded.documentNumber.raw} voided`,
        payload: {
          invoice_id: invoiceId,
          member_id: loaded.memberId,
          document_number: loaded.documentNumber.raw,
          void_reason: input.voidReason,
          original_pdf_sha256: loaded.pdf.sha256,
          new_pdf_sha256: rerendered.sha256,
          voided_by_user_id: input.actorUserId,
        },
      });

      // H. Cancellation email outbox. FR-036 — bilingual (handled by
      // the auto-email template), references the original document
      // number (via the outbox `invoiceId` context), attaches the
      // VOID-stamped PDF (same Blob key, new sha256 on the invoice
      // row → the dispatcher always fetches current bytes).
      const shouldAutoEmail =
        loaded.autoEmailOnIssue ?? settings.autoEmailEnabled;
      if (shouldAutoEmail) {
        await deps.outbox.enqueue(tx, {
          tenantId: input.tenantId,
          eventType: 'invoice_voided',
          recipientEmail: loaded.memberIdentitySnapshot.primary_contact_email,
          invoiceId,
          pdfBlobKey: loaded.pdf.blobKey,
          pdfTemplateVersion: loaded.pdf.templateVersion,
          // FR-036 — snapshotted doc number for cancellation email copy.
          documentNumber: loaded.documentNumber.raw,
        });
      }

      return ok(voided);
    });
  } catch (e) {
    if (e instanceof VoidInvoiceInternalError) {
      logger.warn(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'voidInvoice: internal error, rolling back',
      );
      return err(e.error);
    }
    throw e;
  }
}
