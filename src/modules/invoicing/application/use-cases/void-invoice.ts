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
 * --- R-1 Reliability fix (2026-04-22) ---
 * Two-phase commit avoids Blob↔DB desync under partial failure:
 *
 *   Phase 1 — atomic DB transaction (THIS IS THE CRITICAL PATH):
 *     A. lockForUpdate on invoice (cross-tenant probe audit on not-found)
 *     B. verify status == 'issued'
 *     C. load invoice row + verify snapshots present
 *     D. re-render PDF with VOID overlay using the PINNED issue-time
 *        templateVersion (R3-E4 / FR-016 — layout integrity preserved)
 *     E. applyVoid UPDATE (status + void_reason + voided_by + voided_at
 *        — does NOT touch pdf_sha256)
 *     F. emit `invoice_voided` audit (carries member_id per FR-033,
 *        void_reason_sha256 per PDPA B-1 redaction)
 *     G. enqueue cancellation email outbox row (FR-036)
 *     H. COMMIT
 *
 *   Phase 2 — post-commit Blob sync (best-effort with logged failure):
 *     I. uploadPdf (overwrite at the same content-addressed key)
 *     J. applyInvoicePdfRegeneration (update pdf_sha256 to the new hash)
 *
 *   If Phase 2 fails, the invoice is ALREADY committed as void in the
 *   DB; the Blob still holds the original un-stamped bytes and DB
 *   holds the original sha256. State is CONSISTENT (bytes match hash)
 *   but INCOMPLETE (the VOID overlay has not yet been applied). A
 *   sweeper + admin re-render action can reconcile. The void is
 *   irreversible per spec so there is no "undo" path either way.
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
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { logger } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { loadTenantLogo } from '../lib/load-tenant-logo';

export const voidInvoiceSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  /** Free-text reason, required, 1-500 chars. Persisted + audited (hashed). */
  voidReason: z.string().trim().min(1).max(500),
});

export type VoidInvoiceInput = z.infer<typeof voidInvoiceSchema>;

export type VoidInvoiceError =
  | { code: 'invoice_not_found' }
  | { code: 'invalid_status'; status: InvoiceStatus }
  | { code: 'no_snapshot_on_invoice' }
  | { code: 'settings_missing' }
  | { code: 'pdf_render_failed'; reason: string }
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

/**
 * PG-3 — sanitise a potentially PII-laden error message before it lands
 * in a typed error returned across the Application boundary. Truncate
 * to 200 chars and redact 13-digit sequences that could be Thai tax IDs.
 *
 * Exported for unit testing (T-SAN). Callers within the module use it
 * directly; external consumers SHOULD NOT — the return-value semantics
 * ("best-effort redacted, not a security guarantee") are
 * call-site-specific.
 */
export function sanitiseErrorReason(raw: unknown): string {
  const s = String(raw).replace(/\d{13}/g, '[REDACTED-TAXID]');
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

export async function voidInvoice(
  deps: VoidInvoiceDeps,
  input: VoidInvoiceInput,
): Promise<Result<Invoice, VoidInvoiceError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  // B-1 — hash void_reason for the audit payload so free-text PII
  // cannot leak into the 10-year append-only audit log. The raw
  // plaintext stays on the invoices row (legal-obligation retention
  // track, subject to the tax-document 10-year window, not audit's
  // append-only basis).
  const voidReasonHash = sha256Hex(input.voidReason);

  // Settings read outside the outer tx (same reason as issue-credit-note
  // § 134 — nested `runInTenant` on concurrent voids would deadlock).
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);

  // Phase 1 — DB-only atomic commit. Render happens inside so the new
  // bytes/sha are available for the audit payload + the Phase 2 upload.
  type Phase1Success = {
    readonly voided: Invoice;
    readonly blobKey: string;
    readonly rendered: { readonly bytes: Uint8Array; readonly sha256: Sha256Hex };
  };

  let phase1: Result<Phase1Success, VoidInvoiceError>;
  try {
    phase1 = await deps.invoiceRepo.withTx(async (tx) => {
      // A. Row-lock + status read in one round-trip.
      const lockedStatus = await deps.invoiceRepo.lockForUpdate(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!lockedStatus) {
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

      // B. Only `issued` is voidable.
      if (lockedStatus !== 'issued') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }

      // C. Load the full row (under the lock).
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

      // D. Re-render with VOID overlay (pinned template version per FR-016).
      const tenantLogo = await loadTenantLogo(
        deps.blob,
        loaded.tenantIdentitySnapshot.logo_blob_key,
      );
      let rendered;
      try {
        rendered = await deps.pdfRender.render({
          kind: 'void_stamped_invoice',
          templateVersion: loaded.pdf.templateVersion,
          documentNumber: loaded.documentNumber,
          issueDate: loaded.issueDate,
          dueDate: loaded.dueDate,
          tenant: loaded.tenantIdentitySnapshot,
          tenantLogo,
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
          reason: sanitiseErrorReason(e),
        });
      }

      // E. applyVoid (does NOT write pdf_sha256 — deferred to Phase 2).
      let voided: Invoice;
      try {
        voided = await deps.invoiceRepo.applyVoid(tx, {
          tenantId: input.tenantId,
          invoiceId,
          voidReason: input.voidReason,
          voidedByUserId: input.actorUserId,
        });
      } catch (e) {
        if (e instanceof InvoiceApplyConflictError && e.kind === 'applyVoid') {
          throw new VoidInvoiceInternalError({ code: 'concurrent_state_change' });
        }
        throw e;
      }

      // F. Audit — B-1 redaction: hash the reason; keep original sha
      // reference so the forensic trail can verify the plaintext on the
      // invoices row (still present under legal-obligation basis).
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
          void_reason_sha256: voidReasonHash,
          original_pdf_sha256: loaded.pdf.sha256,
          new_pdf_sha256: rendered.sha256,
          voided_by_user_id: input.actorUserId,
        },
      });

      // G. Outbox (cancellation email per FR-036).
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
          documentNumber: loaded.documentNumber.raw,
          // B-1 / FR-036 — admin-entered reason rendered into the
          // cancellation email body. Plaintext in the OUTBOX
          // context_data is acceptable (row purged after 90 days per
          // B-2 cron); the append-only audit log carries only
          // `void_reason_sha256` to avoid 10-year PII retention.
          voidReason: input.voidReason,
          // R17-02 — sha256 of the freshly-rendered VOID-stamped bytes
          // we WILL upload in Phase 2. The dispatcher uses this to
          // verify the Blob's prefetched bytes match what Phase 1
          // committed to audit — if Phase 2 never uploads (Blob
          // outage, cold-start timeout), the dispatcher would
          // otherwise attach the ORIGINAL un-stamped invoice bytes
          // to a cancellation email. Integrity check preempts that
          // by permanently-failing the row.
          expectedPdfSha256: rendered.sha256,
        });
      }

      return ok({
        voided,
        blobKey: loaded.pdf.blobKey,
        rendered,
      });
    });
  } catch (e) {
    if (e instanceof VoidInvoiceInternalError) {
      logger.warn(
        {
          errorCode: e.error.code,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'voidInvoice: phase 1 rollback',
      );
      return err(e.error);
    }
    throw e;
  }

  if (!phase1.ok) return err(phase1.error);
  const { voided, blobKey, rendered } = phase1.value;

  // Phase 2 — post-commit Blob overwrite + pdf_sha256 sync. Best-effort:
  // on failure the invoice is ALREADY committed as void in the DB.
  // State after failure:
  //   - blob upload fails     → (old sha + old bytes)  CONSISTENT, stale
  //   - sha-sync fails        → (old sha + new bytes)  SPLIT, detectable
  // Both are detectable via sha-mismatch check; the emitted
  // `invoice_pdf_sync_failed` audit event carries the `phase` so a
  // sweeper + ops dashboards can target the right recovery action.
  let blobUploaded = false;
  let syncFailure: { phase: 'blob_upload' | 'sha_sync'; err: unknown } | null =
    null;
  try {
    await deps.blob.uploadPdf({
      key: blobKey,
      body: rendered.bytes,
      contentType: 'application/pdf',
      allowOverwrite: true,
    });
    blobUploaded = true;
    await deps.invoiceRepo.withTx(async (tx2) => {
      await deps.invoiceRepo.applyInvoicePdfRegeneration(tx2, {
        tenantId: input.tenantId,
        invoiceId,
        pdfSha256: rendered.sha256,
      });
    });
  } catch (e) {
    syncFailure = {
      phase: blobUploaded ? 'sha_sync' : 'blob_upload',
      err: e,
    };
  }

  if (syncFailure) {
    // N-2 — DO NOT log blobKey (PG-1 regression — key embeds tenant +
    // invoice path segments). `invoiceId + tenantId` correlate the row
    // uniquely without leaking the storage layout.
    logger.error(
      {
        err: syncFailure.err,
        invoiceId: input.invoiceId,
        tenantId: input.tenantId,
        phase: syncFailure.phase,
      },
      'voidInvoice: phase 2 blob+sha sync failed; invoice voided but PDF overlay deferred',
    );
    // R-1a — emit an audit row so the partial state is visible in the
    // append-only compliance trail + monitoring. Reuses the existing
    // `pdf_render_failed` event type (the DB enum does not include a
    // dedicated `invoice_pdf_sync_failed` value and the semantic
    // umbrella "a PDF operation failed" fits). The `context` field
    // discriminates render-phase failures (already used by the Phase-1
    // render-throw path) from sync-phase failures (this branch).
    // `null` tx because the Phase-1 tx is long committed.
    //
    // M-1 — wrap in try/catch: if the audit insert itself fails
    // (connection pool exhaustion, DB outage), the Phase-2 signal
    // would otherwise bubble as an uncaught exception past the
    // use-case boundary — converting a (committed-void + deferred-
    // overlay) state into a `rejected promise` that the route
    // handler has to surface as a 500. The logger.error above
    // preserves the signal regardless; catching here keeps the
    // public API contract (Result<Invoice, VoidInvoiceError>).
    try {
      await deps.audit.emit(null, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'pdf_render_failed',
        actorUserId: input.actorUserId,
        summary: `Invoice ${invoiceId} voided but PDF overlay deferred (phase=${syncFailure.phase})`,
        payload: {
          context: 'invoice_void_phase2_sync',
          invoice_id: invoiceId,
          phase: syncFailure.phase,
          expected_sha256: rendered.sha256,
          blob_bytes_uploaded: blobUploaded,
        },
      });
    } catch (auditErr) {
      logger.error(
        {
          err: auditErr,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'voidInvoice: phase 2 audit emit failed; sync-gap signal preserved only via logger.error above',
      );
    }
    // Return the row with the Phase-1 state (void committed, old sha).
    // Caller sees a void invoice whose pdf_sha256 still matches the
    // (unchanged) blob bytes when blob_upload failed, or the
    // now-stale value when sha_sync failed.
    return ok(voided);
  }

  // R-1b — Phase 2 succeeded: the DB row now has the new sha256 but
  // `voided` was captured from `applyVoid`'s RETURNING (Phase 1, old
  // sha). Patch the in-memory representation so callers serialising
  // this Invoice (e.g., the route handler's JSON response) see the
  // freshly-committed sha matching the blob bytes.
  return ok({
    ...voided,
    pdf: voided.pdf
      ? { ...voided.pdf, sha256: rendered.sha256 }
      : voided.pdf,
  });
}
