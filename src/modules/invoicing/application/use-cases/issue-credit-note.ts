/**
 * T078 — issue-credit-note use case (F4 / US6).
 *
 * Transitions a paid OR partially_credited invoice by creating a new
 * credit-note tax document with its own sequential number. Partial
 * credits accumulate on `invoices.credited_total_satang` until the
 * remainder reaches zero, at which point the parent flips to `credited`.
 *
 * Canonical lock order (mirror of issue-invoice for deadlock-safety):
 *   1. invoice row FOR UPDATE          (lockForUpdate)
 *   2. advisory xact lock (inside seq allocator)
 *   3. tenant_document_sequences FOR UPDATE (inside allocator)
 *
 * Operations (single DB transaction):
 *   A. load tenant settings
 *   B. lockForUpdate on invoice
 *   C. verify status ∈ {paid, partially_credited} + load row
 *   D. enforce partial-accumulation invariant (proposed ≤ remainder)
 *   E. compute proportional VAT (policy)
 *   F. allocate credit_note sequence number
 *   G. render bilingual credit-note PDF (kind='credit_note')
 *   H. upload PDF to Blob (content-addressed)
 *   I. insert credit_notes row
 *   J. update invoices.credited_total + status (rollup)
 *   K. emit `credit_note_issued` audit
 *   L. enqueue auto-email outbox row
 *   M. COMMIT
 *
 * Any throw in A–L rolls back the whole tx — seq is NOT consumed,
 * credited_total stays intact, Blob upload leaves a deterministic
 * content-addressed orphan that the post-commit sweeper reclaims.
 *
 * RBAC: admin only (route handler guard).
 * Concurrent race: two admins issuing partial credit notes against the
 * same invoice serialise via the invoice row FOR UPDATE — exactly one
 * succeeds if the combined amount would exceed total.
 */
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import type { AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { asInvoiceLineId } from '@/modules/invoicing/domain/invoice-line';
import {
  asCreditNoteId,
  type CreditNote,
} from '@/modules/invoicing/domain/credit-note';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { calculateCreditNoteVat } from '@/modules/invoicing/domain/policies/calculate-credit-note-vat';
import { enforceCreditCannotExceedRemainder } from '@/modules/invoicing/domain/policies/enforce-credit-cannot-exceed-remainder';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';

export const issueCreditNoteSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  /** Gross amount to credit (in satang, incl. VAT). Must be > 0. */
  creditTotalSatang: z.bigint().positive(),
  /** Free-text reason (required, max 500 char). Persisted + rendered on PDF. */
  reason: z.string().trim().min(1).max(500),
});

export type IssueCreditNoteInput = z.infer<typeof issueCreditNoteSchema>;

export type IssueCreditNoteError =
  | { code: 'invoice_not_found' }
  | { code: 'invalid_status'; status: InvoiceStatus }
  | { code: 'no_snapshot_on_invoice' }
  | { code: 'settings_missing' }
  | {
      code: 'credit_exceeds_remainder';
      invoiceTotalSatang: bigint;
      alreadyCreditedSatang: bigint;
      proposedSatang: bigint;
      remainingSatang: bigint;
    }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'concurrent_state_change' };

class IssueCreditNoteInternalError extends TxAbort<IssueCreditNoteError> {
  override readonly name = 'IssueCreditNoteInternalError';
}

export interface IssueCreditNoteDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly creditNoteRepo: CreditNoteRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  readonly currentTemplateVersion: number;
}

export async function issueCreditNote(
  deps: IssueCreditNoteDeps,
  input: IssueCreditNoteInput,
): Promise<Result<CreditNote, IssueCreditNoteError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);
  const creditNoteId = asCreditNoteId(randomUUID());
  const now = deps.clock.nowIso();

  // A. Load settings BEFORE the withTx. The settings repo opens its own
  // `runInTenant` transaction under the hood; nesting that inside the
  // outer withTx deadlocks the pool when two credit-note issues run
  // concurrently (outer tx holds conn1, inner settings-read waits for
  // conn2 which is held by the other concurrent caller, and vice
  // versa). Settings are effectively immutable during an issue (the
  // immutability trigger on tenant_invoice_settings + the DB uniqueness
  // of the row make a mid-race mutation a no-op), so reading outside
  // the tx is safe.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);

  // T122 — track which render invocation was in-flight when a
  // `pdf_render_failed` is thrown so the post-rollback audit can
  // record the correct `render_kind`. `'credit_note'` covers G+H
  // (main CN PDF), `'annotation'` covers J2 (re-stamped original
  // invoice). Mutated inside the withTx closure, read from the outer
  // catch.
  let pendingRenderKind: 'credit_note' | 'annotation' | null = null;

  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      // B. Row-lock — serialises concurrent credit-note issues on the
      // same parent invoice so partial-accumulation is race-free.
      const lockedStatus = await deps.invoiceRepo.lockForUpdate(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!lockedStatus) {
        // Cross-tenant-probe on not-found. `null` tx so the audit row
        // survives regardless of the outer rollback.
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'credit_note_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Probe on invoice ${invoiceId} (not found on credit-note issue)`,
          payload: {
            attempted_invoice_id: invoiceId,
            actor_role: 'admin',
            route: 'issue-credit-note',
          },
        });
        return err({ code: 'invoice_not_found' });
      }
      if (lockedStatus !== 'paid' && lockedStatus !== 'partially_credited') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }

      // C. Load row (under the lock) — need snapshots, fiscal year,
      // totals, member id, and the current credited_total.
      const loaded = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
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
        !loaded.issueDate
      ) {
        return err({ code: 'no_snapshot_on_invoice' });
      }

      if (!settings) return err({ code: 'settings_missing' });

      const proposed = Money.fromSatangUnsafe(input.creditTotalSatang);

      // D. Partial-accumulation invariant (Domain policy).
      const remainderCheck = enforceCreditCannotExceedRemainder({
        invoiceTotal: loaded.total,
        alreadyCredited: loaded.creditedTotal,
        proposed,
      });
      if (!remainderCheck.ok) {
        return err({
          code: 'credit_exceeds_remainder',
          invoiceTotalSatang: remainderCheck.error.invoiceTotalSatang,
          alreadyCreditedSatang: remainderCheck.error.alreadyCreditedSatang,
          proposedSatang: remainderCheck.error.proposedSatang,
          remainingSatang: remainderCheck.error.remainingSatang,
        });
      }

      // E. Proportional VAT split.
      const vatCalc = calculateCreditNoteVat({
        creditTotal: proposed,
        originalVat: loaded.vat,
        originalTotal: loaded.total,
      });
      if (!vatCalc.ok) {
        // IM-7 (review 2026-04-20) — this branch is unreachable under
        // the remainder guard + the ZeroBalance DB CHECK, but a
        // defensive log is still emitted so a Money-arithmetic edge
        // case (e.g., a future refactor relaxing the remainder guard)
        // is diagnosable rather than silently collapsed. The caller
        // still sees a typed remainder error for uniform handling;
        // the logger line carries the REAL vatCalc.error for
        // operators who need to debug.
        logger.error(
          {
            tenantId: input.tenantId,
            invoiceId,
            vatErrorKind: vatCalc.error.kind,
            invoiceTotalSatang: loaded.total.satang.toString(),
            creditedTotalSatang: loaded.creditedTotal.satang.toString(),
            proposedSatang: proposed.satang.toString(),
          },
          'issueCreditNote: vat calculation failed after remainder guard (unreachable — investigate)',
        );
        return err({
          code: 'credit_exceeds_remainder',
          invoiceTotalSatang: loaded.total.satang,
          alreadyCreditedSatang: loaded.creditedTotal.satang,
          proposedSatang: proposed.satang,
          remainingSatang: loaded.total.satang - loaded.creditedTotal.satang,
        });
      }
      const { creditAmount, vat, total } = vatCalc.value;

      // --- POST-SEQUENCE zone begins. Every error path below MUST
      // throw IssueCreditNoteInternalError so withTx rolls back.

      // F. Allocate credit_note sequence (own stream, same fiscal year
      // as the parent invoice per Thai-RD consistency).
      const fy = loaded.fiscalYear;
      const seq = await deps.sequenceAllocator.allocateNext(tx, {
        tenantId: input.tenantId,
        documentType: 'credit_note',
        fiscalYear: fy,
      });
      const docNum = DocumentNumber.of(settings.creditNoteNumberPrefix, fy, seq);
      if (!docNum.ok) {
        throw new IssueCreditNoteInternalError({ code: 'overflow', fiscalYear: fy });
      }

      // Wall-clock Bangkok date for the credit note (distinct from the
      // original invoice's issueDate).
      const issueDate = bangkokLocalDate(now);

      // G. Render PDF (bilingual ใบลดหนี้ / Credit Note + original-invoice
      // reference block via `creditNote` context).
      //
      // Review C-1 — the CN PDF body shows a SINGLE synthetic line
      // whose amount equals the credit amount, not the original
      // invoice's itemised lines. Rationale: on a partial credit
      // (e.g. 10,700 of a 53,500 invoice), rendering the original
      // line amounts verbatim would leave line-sum ≠ totals-block,
      // which is both visually inconsistent and a Thai RD §86/4
      // interpretation risk. A single aggregated "Credit against
      // {original doc #}" line keeps the PDF arithmetically coherent
      // across full + partial + multi-partial credit notes.
      const syntheticLine = {
        lineId: asInvoiceLineId(creditNoteId),
        kind: 'registration_fee' as const,
        descriptionTh: `ลดหนี้ตาม ${loaded.documentNumber.raw}`,
        descriptionEn: `Credit against ${loaded.documentNumber.raw}`,
        unitPrice: creditAmount,
        quantity: '1.0000',
        proRateFactor: null,
        total: creditAmount,
        position: 1,
      };
      // G+H. Render CN PDF + upload to Blob (T126 shared helper).
      pendingRenderKind = 'credit_note';
      const blobKey = `invoicing/${input.tenantId}/${fy}/credit-note_${creditNoteId}_v${deps.currentTemplateVersion}.pdf`;
      const rendered = await renderAndUploadPdf(
        { pdfRender: deps.pdfRender, blob: deps.blob },
        {
          renderInput: {
            kind: 'credit_note',
            templateVersion: deps.currentTemplateVersion,
            documentNumber: docNum.value,
            issueDate,
            dueDate: null,
            tenant: loaded.tenantIdentitySnapshot,
            member: loaded.memberIdentitySnapshot,
            lines: [syntheticLine],
            // Money fields carry the credit-note's own amounts — the
            // template reads these for the totals block.
            subtotal: creditAmount,
            vatRate: loaded.vatRate,
            vat,
            total,
            creditNote: {
              originalDocumentNumber: loaded.documentNumber.raw,
              originalIssueDate: loaded.issueDate,
              reason: input.reason,
            },
          },
          blobKey,
        },
        (code, reason) => new IssueCreditNoteInternalError({ code, reason }),
      );

      // I. Insert credit_notes row.
      let cn: CreditNote;
      try {
        cn = await deps.creditNoteRepo.insertCreditNote(tx, {
          tenantId: input.tenantId,
          creditNoteId,
          originalInvoiceId: invoiceId,
          fiscalYear: fy,
          sequenceNumber: seq,
          documentNumber: docNum.value.raw,
          issueDate,
          issuedByUserId: input.actorUserId,
          reason: input.reason,
          creditAmountSatang: creditAmount.satang,
          vatSatang: vat.satang,
          totalSatang: total.satang,
          tenantIdentitySnapshot: loaded.tenantIdentitySnapshot,
          memberIdentitySnapshot: loaded.memberIdentitySnapshot,
          pdf: {
            blobKey,
            sha256: rendered.sha256,
            templateVersion: deps.currentTemplateVersion,
          },
        });
      } catch (e) {
        // Unique-constraint on (tenant, fiscal_year, sequence_number) is
        // prevented by the allocator FOR UPDATE lock; any insert error
        // here means the DB rejected snapshot/FK/check constraints —
        // surface as a typed concurrent_state_change and let the caller
        // decide whether to retry.
        logger.error(
          { err: String(e), creditNoteId, invoiceId },
          'issueCreditNote: insertCreditNote failed',
        );
        throw new IssueCreditNoteInternalError({ code: 'concurrent_state_change' });
      }

      // J. Rollup: bump credited_total_satang + flip invoice status.
      const newCreditedTotal = loaded.creditedTotal.satang + total.satang;
      const fullyCredited = newCreditedTotal === loaded.total.satang;
      try {
        await deps.invoiceRepo.applyCreditNoteRollup(tx, {
          tenantId: input.tenantId,
          invoiceId,
          newCreditedTotalSatang: newCreditedTotal,
          newStatus: fullyCredited ? 'credited' : 'partially_credited',
        });
      } catch (e) {
        if (
          e instanceof InvoiceApplyConflictError &&
          e.kind === 'applyCreditNoteRollup'
        ) {
          throw new IssueCreditNoteInternalError({ code: 'concurrent_state_change' });
        }
        throw e;
      }

      // J2. US6 AS4 — re-render the original invoice PDF with a
      // CREDITED / PARTIALLY CREDITED annotation + CN-reference
      // footer, then overwrite at the SAME Blob key (content-address
      // preserved). Mirrors the VOID-stamping pattern (FR-008) so
      // downstream readers (admin, member, bookkeeper email export)
      // see the status change on the invoice document itself. We
      // re-render with the PINNED `invoice.pdf.templateVersion` (NOT
      // currentTemplateVersion) so R3-E4 / FR-016 layout-integrity
      // rules hold — the annotation is additive, template layout is
      // unchanged.
      //
      // `pdfBlobKey` is guaranteed non-null here because the paid-
      // state guard at the top of the use case implies the invoice
      // was issued (has `pdf`). TypeScript can't prove this statically
      // so we re-check and bail cleanly if the snapshot is somehow
      // missing (this branch is unreachable under valid state).
      if (loaded.pdf) {
        const allCreditNotes = await deps.creditNoteRepo.findByOriginalInvoiceInTx(
          tx,
          invoiceId,
          input.tenantId,
        );
        // IM-6 — `total: Money` (not stringified satang) for uniformity
        // with the rest of PdfRenderInput's money fields. The template
        // adapter stringifies for display at render time.
        const annotationRefs = allCreditNotes
          .slice()
          .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
          .map((x) => ({
            documentNumber: x.documentNumber.raw,
            issueDate: x.issueDate,
            total: x.total,
          }));

        // J2 re-annotation (T126 shared helper, `annotation` prefix
        // differentiates from initial G+H failure). MUST overwrite
        // per Review CR-1 — the re-render produces DIFFERENT bytes
        // (adds the credit-annotation overlay) so DB pdf_sha256
        // diverges from the original; without allowOverwrite the
        // adapter silently treats already-exists as success.
        pendingRenderKind = 'annotation';
        const rerendered = await renderAndUploadPdf(
          { pdfRender: deps.pdfRender, blob: deps.blob },
          {
            renderInput: {
              kind: 'invoice',
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
              creditedAnnotation: {
                fullyCredited,
                references: annotationRefs,
              },
            },
            blobKey: loaded.pdf.blobKey,
            allowOverwrite: true,
            reasonPrefix: 'annotation',
          },
          (code, reason) => new IssueCreditNoteInternalError({ code, reason }),
        );

        try {
          await deps.invoiceRepo.applyInvoicePdfRegeneration(tx, {
            tenantId: input.tenantId,
            invoiceId,
            pdfSha256: rerendered.sha256,
          });
        } catch (e) {
          logger.error(
            { err: String(e), invoiceId, creditNoteId },
            'issueCreditNote: applyInvoicePdfRegeneration failed',
          );
          throw new IssueCreditNoteInternalError({ code: 'concurrent_state_change' });
        }

        // Companion audit event `invoice_pdf_regenerated` (introduced
        // in F4 alongside R3-E4 / CP-5.2 Best-Practice PDF integrity —
        // see audit-port.ts doc). Captures the before/after sha256 so
        // the 10-year audit trail can reconstruct the exact document
        // state at any point.
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_pdf_regenerated',
          actorUserId: input.actorUserId,
          summary: `Invoice ${loaded.documentNumber.raw} PDF regenerated with ${fullyCredited ? 'CREDITED' : 'PARTIALLY CREDITED'} annotation`,
          payload: {
            invoice_id: invoiceId,
            invoice_number: loaded.documentNumber.raw,
            original_sha256: loaded.pdf.sha256,
            new_sha256: rerendered.sha256,
            reason: 'credit_note_annotation',
            triggered_by_credit_note_id: creditNoteId,
          },
        });
      }

      // K. Audit.
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'credit_note_issued',
        actorUserId: input.actorUserId,
        summary: `Credit note ${docNum.value.raw} issued against ${loaded.documentNumber.raw}`,
        payload: {
          credit_note_id: creditNoteId,
          original_invoice_id: invoiceId,
          // US7 — surfaces in the F3 member timeline (filter is on
          // `payload->>'member_id'`).
          member_id: loaded.memberId,
          credit_amount_satang: creditAmount.satang.toString(),
          vat_satang: vat.satang.toString(),
          total_satang: total.satang.toString(),
          reason: input.reason,
          document_number: docNum.value.raw,
          pdf_sha256: rendered.sha256,
        },
      });

      // L. Outbox (auto-email). The `autoEmailOnIssue` flag name comes
      // from the invoice-issue flow but the per-invoice override
      // applies uniformly to credit-note dispatch; falling back to
      // tenant `autoEmailEnabled` when unset. Recipient is the
      // snapshotted primary contact on the invoice at issue time
      // (SG-5 — fixed citation: the snapshot rule is FR-038, but the
      // email-toggle rule is the tenant `autoEmailEnabled` setting;
      // keeping both here for clarity).
      const shouldAutoEmail = loaded.autoEmailOnIssue ?? settings.autoEmailEnabled;
      if (shouldAutoEmail) {
        await deps.outbox.enqueue(tx, {
          tenantId: input.tenantId,
          eventType: 'credit_note_issued',
          recipientEmail: loaded.memberIdentitySnapshot.primary_contact_email,
          creditNoteId,
          pdfBlobKey: blobKey,
          pdfTemplateVersion: deps.currentTemplateVersion,
        });
      }

      return ok(cn);
    });
  } catch (e) {
    if (e instanceof IssueCreditNoteInternalError) {
      logger.warn(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'issueCreditNote: internal error, rolling back',
      );
      // T122 — emit `pdf_render_failed` audit AFTER rollback so
      // forensic evidence survives (parity with issue-invoice.ts and
      // record-payment.ts). `pendingRenderKind` disambiguates which
      // of the two render sites (G+H main CN vs J2 annotation) was
      // in-flight. Fire-and-forget: never mask the original error.
      if (e.error.code === 'pdf_render_failed') {
        try {
          await deps.audit.emit(null, {
            tenantId: input.tenantId,
            requestId: input.requestId ?? null,
            eventType: 'pdf_render_failed',
            actorUserId: input.actorUserId,
            summary: `PDF render failed for ${pendingRenderKind ?? 'credit_note'} on invoice ${input.invoiceId}`,
            payload: {
              invoice_id: input.invoiceId,
              render_kind: pendingRenderKind ?? 'credit_note',
              reason: e.error.reason,
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr, invoiceId: input.invoiceId },
            'issueCreditNote: pdf_render_failed audit emit also failed',
          );
        }
      }
      return err(e.error);
    }
    throw e;
  }
}
