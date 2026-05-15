/**
 * T166-05 — Render receipt PDF (async worker callback).
 *
 * Counterpart to the `record-payment` H+I block when the
 * `FEATURE_F5_ASYNC_RECEIPT_PDF` flag is on. Triggered by the
 * `receipt_pdf_render` outbox dispatcher under
 * `runInTenant(payload.tenantId)`. Reads the paid invoice + tenant
 * settings, renders the receipt PDF using the pinned identity
 * snapshots (FR-038), uploads to Vercel Blob at the deterministic key
 * the dispatcher already knows, and flips
 * `receipt_pdf_status` from 'pending' → 'rendered' atomically with
 * the blob fields.
 *
 * Idempotent — the dispatcher may invoke this multiple times for the
 * same row (at-least-once semantics). The `applyReceiptPdf` repo
 * method skips the UPDATE when status is already 'rendered', and
 * the audit emit fires only on a real transition (kind detected via
 * the row's prior status).
 *
 * On render or upload failure, the use-case calls
 * `applyReceiptPdfFailure` to bump the attempt counter + record the
 * error message, then returns a typed `err`. The reconciliation cron
 * (T166-11) re-enqueues `failed` rows up to 3 attempts before
 * surfacing `pdf_render_permanently_failed`.
 *
 * Tax-document invariants preserved:
 *   - Sequential receipt-document numbering already happened at
 *     `record-payment` time — the receipt sequence sits in
 *     `tenant_document_sequences`. The number itself is encoded in
 *     `invoice.documentNumber` (combined-mode) or computed from the
 *     `tenant_document_sequences` snapshot at the moment the worker
 *     re-derives it.
 *   - Receipt PDF sha256 is the integrity anchor — emitted in the
 *     `receipt_rendered` audit row (10y retention).
 *
 * Cross-tenant isolation: caller (outbox dispatcher T166-07) is
 * responsible for the `runInTenant(payload.tenantId, …)` wrapper.
 * This use-case operates on the bound tenant only.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';

import type { AuditPort } from '../ports/audit-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { ClockPort } from '../ports/clock-port';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { TxAbort } from '../lib/tx-abort';
import { asInvoiceId, type Invoice } from '@/modules/invoicing/domain/invoice';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';

export interface RenderReceiptPdfInput {
  readonly tenantId: string;
  readonly invoiceId: string;
  readonly fiscalYear: number;
  readonly templateVersion: number;
  readonly requestId?: string | null;
  readonly actorUserId?: string;
}

export type RenderReceiptPdfError =
  | { readonly code: 'invoice_not_found' }
  | {
      readonly code: 'invalid_state';
      readonly status: Invoice['status'];
      readonly receiptStatus: 'pending' | 'rendered' | 'failed' | null;
    }
  | { readonly code: 'no_snapshot_on_invoice' }
  | { readonly code: 'settings_missing' }
  | { readonly code: 'render_failed'; readonly reason: string }
  | { readonly code: 'blob_upload_failed'; readonly reason: string }
  | { readonly code: 'document_number_overflow' }
  /**
   * review-20260428-102639.md S8 closure — surfaced when the worker
   * detects deterministic data corruption (missing or unparseable
   * `receipt_document_number_raw`). Dispatcher MUST treat this as a
   * permanent failure (skip retry ladder; emit
   * `pdf_render_permanently_failed` immediately).
   */
  | { readonly code: 'data_corruption'; readonly reason: string };

// review-20260428-102639.md S8 closure — `data_corruption` short-
// circuits the dispatcher's retry ladder for deterministic data
// failures (missing receipt_document_number_raw, parse error).
// Retrying these wastes the 3-attempt budget on a deterministic
// no-op and produces a misleading `pdf_render_permanently_failed`
// page when the actual cause is data integrity.
class RenderReceiptInternalError extends TxAbort<{
  readonly kind: 'pdf_render_failed' | 'blob_upload_failed' | 'data_corruption';
  readonly reason: string;
}> {
  override readonly name = 'RenderReceiptInternalError';
}

const SYSTEM_ACTOR_ID = 'system:f4-async-render';

export interface RenderReceiptPdfDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
}

export async function renderReceiptPdf(
  deps: RenderReceiptPdfDeps,
  input: RenderReceiptPdfInput,
): Promise<Result<Invoice, RenderReceiptPdfError>> {
  const invoiceId = asInvoiceId(input.invoiceId);
  const actorUserId = input.actorUserId ?? SYSTEM_ACTOR_ID;
  const requestId = input.requestId ?? null;

  // Settings read happens OUTSIDE the writing tx for the same
  // pool-deadlock reason record-payment.ts:131 documents. Settings
  // are immutable across a payment lifecycle so the read-outside
  // pattern is safe.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  if (!settings) return err({ code: 'settings_missing' });

  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      // No row lock — the worker doesn't transition `paid → x`. A
      // read is sufficient. If the row is concurrently being voided
      // / credited, our applyReceiptPdf write would still land
      // (status='paid' isn't part of the WHERE clause), but that's
      // fine — the receipt sha256 hash is informational once the
      // invoice has transitioned past 'paid'.
      const loaded = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
      if (!loaded) {
        return err({ code: 'invoice_not_found' as const });
      }

      // Idempotent re-arm: already rendered → no-op. Status guard
      // protects against the dispatcher accidentally double-firing
      // (at-least-once delivery semantics).
      const currentStatus = loaded.receiptPdfStatus ?? null;
      if (currentStatus === 'rendered') {
        return ok(loaded);
      }
      if (loaded.status !== 'paid') {
        return err({
          code: 'invalid_state' as const,
          status: loaded.status,
          receiptStatus: currentStatus,
        });
      }

      // Snapshots required for the render — same invariant as
      // record-payment.ts:188.
      if (
        !loaded.memberIdentitySnapshot ||
        !loaded.tenantIdentitySnapshot ||
        !loaded.subtotal ||
        !loaded.vat ||
        !loaded.total ||
        !loaded.vatRate ||
        !loaded.fiscalYear ||
        !loaded.documentNumber
      ) {
        return err({ code: 'no_snapshot_on_invoice' as const });
      }

      // Combined-mode: receipt IS the invoice; reuse the invoice
      // document number.
      //
      // Separate-mode: read the pre-allocated receipt doc number from
      // the invoice row. record-payment.ts allocated it inside the
      // same tx as the `paid` flip (atomic with sequential numbering),
      // and persisted it on `invoices.receipt_document_number_raw` so
      // the worker can pick it up here without re-allocating.
      //
      // Re-allocating in the worker (the original T166-05 shape) is a
      // §87 NO-GAPS violation: every retry burns a fresh receipt
      // sequence number, leaving the prior allocations as gaps in
      // `tenant_document_sequences.receipt`. R1-C1 review fix.
      const combinedMode = settings.receiptNumberingMode === 'combined';
      let receiptDocNum = loaded.documentNumber;
      if (!combinedMode) {
        if (!loaded.receiptDocumentNumberRaw) {
          // Defensive guard. record-payment.ts MUST have stamped this
          // when running under `asyncReceiptPdf=true` + separate-mode.
          // Treat as a permanent state corruption — surface it to the
          // reconcile cron as `render_failed` so on-call investigates.
          throw new RenderReceiptInternalError({
            kind: 'data_corruption',
            reason:
              'separate_mode_receipt_doc_num_missing — invoice row has no receipt_document_number_raw; record-payment did not persist it (pre-T166 row?)',
          });
        }
        const docResult = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
        if (!docResult.ok) {
          throw new RenderReceiptInternalError({
            kind: 'data_corruption',
            reason: `receipt_doc_num_parse_failed: ${loaded.receiptDocumentNumberRaw}`,
          });
        }
        receiptDocNum = docResult.value;
      }

      const receiptBlobKey = `invoicing/${input.tenantId}/${loaded.fiscalYear}/${loaded.invoiceId}_receipt_v${input.templateVersion}.pdf`;
      const tenantLogo = await loadTenantLogo(
        deps.blob,
        loaded.tenantIdentitySnapshot.logo_blob_key,
      );
      const rendered = await renderAndUploadPdf(
        { pdfRender: deps.pdfRender, blob: deps.blob },
        {
          renderInput: {
            kind: combinedMode ? 'receipt_combined' : 'receipt_separate',
            templateVersion: input.templateVersion,
            documentNumber: receiptDocNum,
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
          },
          blobKey: receiptBlobKey,
          // Allow overwrite — failed-retry path may upload twice.
          allowOverwrite: true,
        },
        (kind, reason) => new RenderReceiptInternalError({ kind, reason }),
      );

      // Atomic flip pending → rendered.
      const updated = await deps.invoiceRepo.applyReceiptPdf(tx, {
        tenantId: input.tenantId,
        invoiceId,
        blobKey: receiptBlobKey,
        sha256: rendered.sha256,
        templateVersion: input.templateVersion,
      });

      // Audit — `receipt_rendered` (10y retention, tax-doc-touching).
      // Adapter computes retention via `f4RetentionFor` on the event
      // type so emitters don't carry it.
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId,
        eventType: 'receipt_rendered',
        actorUserId,
        summary: `Receipt rendered for invoice ${loaded.documentNumber.raw}`,
        payload: {
          invoice_id: invoiceId,
          member_id: loaded.memberId,
          receipt_blob_key: receiptBlobKey,
          receipt_pdf_sha256: rendered.sha256,
          receipt_document_number: combinedMode ? null : receiptDocNum.raw,
          template_version: input.templateVersion,
        },
      });

      return ok(updated);
    });
  } catch (e) {
    if (e instanceof RenderReceiptInternalError) {
      // Mark the row failed (separate tx — outer one already rolled
      // back). The reconciliation cron (T166-11) re-enqueues up to 3
      // attempts before raising `pdf_render_permanently_failed`.
      //
      // R2-C-NEW-1 — applyReceiptPdfFailure returns a discriminated
      // outcome. When `kind='race_won_by_success'`, a concurrent
      // worker (worker B) had already flipped the row to 'rendered'
      // between our render attempt + this failure write. Treat that
      // as a SUCCESS and return ok(invoice) so the dispatcher does
      // NOT bump attempts or schedule a retry — the row is already
      // good. Without this branch, every successful concurrent
      // resolution would burn an extra retry slot + emit a bogus
      // 'render_failed' err.
      try {
        const failureOutcome = await deps.invoiceRepo.withTx(async (tx) =>
          deps.invoiceRepo.applyReceiptPdfFailure(tx, {
            tenantId: input.tenantId,
            invoiceId,
            errorMessage: e.error.reason,
          }),
        );
        if (failureOutcome.kind === 'race_won_by_success') {
          logger.info(
            {
              tenantId: input.tenantId,
              invoiceId,
              originalErrorReason: e.error.reason,
            },
            'renderReceiptPdf: failure write lost the race to a concurrent success; treating as ok',
          );
          return ok(failureOutcome.invoice);
        }
      } catch (markErr) {
        logger.error(
          {
            tenantId: input.tenantId,
            invoiceId,
            err: markErr instanceof Error ? markErr.message : String(markErr),
          },
          'renderReceiptPdf: failed to mark row as failed (suppressed)',
        );
        // OTel counter — fires when the failure-mark write itself
        // fails. Under sustained DB issues this can stack up beyond
        // the 3-retry budget without surfacing as
        // `pdf_render_permanently_failed`. Alert on any non-zero rate.
        invoicingMetrics.receiptFailureMarkSuppressed();
      }
      const code: RenderReceiptPdfError['code'] =
        e.error.kind === 'pdf_render_failed'
          ? 'render_failed'
          : e.error.kind === 'blob_upload_failed'
            ? 'blob_upload_failed'
            : 'data_corruption';
      return err({ code, reason: e.error.reason } as RenderReceiptPdfError);
    }
    throw e;
  }
}
