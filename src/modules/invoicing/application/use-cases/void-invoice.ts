/**
 * T100 — void-invoice use case (F4 / US5 · 088 T068).
 *
 * Transitions an ISSUED or PAID invoice → `void` with a required reason.
 * Void is terminal: the invoice keeps its sequential tax-document
 * number (§87 no-gap — never reused), the PDF(s) are re-rendered with a
 * diagonal "VOID / ยกเลิก" overlay at the SAME content-addressed
 * Blob key(s) (FR-008), and an `invoice_voided` audit event + cancellation
 * email outbox row ship inside the same transaction.
 *
 * 088 § F.3 — a voided document ALWAYS re-renders under the title it was
 * ORIGINALLY issued under (never re-titled): a new-flow ใบแจ้งหนี้ bill stays
 * ใบแจ้งหนี้ (never "Tax Invoice"), a §105 ใบเสร็จรับเงิน stays a receipt, etc.
 * Titling is driven by the persisted `pdf_doc_kind` (→ `voidUnderlyingKind`)
 * plus, for a bill, `billMode` (a new-flow bill carries a `billDocumentNumberRaw`).
 *
 * ROW-SHAPE dispatch (NOT flag-gated — the flag only decides which shape a row
 * was issued in; void handles all shapes so legacy + new-flow both cancel):
 *   - ISSUED bill (new-flow): documentNumber NULL, billDocumentNumberRaw set,
 *     one blob (the bill). Void re-renders the bill under ใบแจ้งหนี้.
 *   - ISSUED §86/4 (legacy) / §105 as-paid: one blob. Byte-identical re-render.
 *   - PAID membership (record-payment path): TWO distinct blobs — the ใบแจ้งหนี้
 *     `pdf` bill AND the §86/4 tax-receipt `receiptPdf`. Both are VOID-stamped so a
 *     voided sale never leaves an un-stamped downloadable document (§ F.3 / CHK027;
 *     both stay downloadable per FR-015). Normally an issued §86/4 is cancelled via
 *     a §86/10 credit note — void is the EDGE path.
 *   - PAID as-paid / legacy combined (ONE blob): stamps its single blob.
 *
 * Refusals:
 *   - `void` / `credited` / `partially_credited` → terminal / already-adjusted,
 *                              re-void / edit blocked (`invalid_status`).
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
 *     B. verify status ∈ {issued, paid}
 *     C. load invoice row + verify snapshots present
 *     D. re-render EACH blob (bill/main + separate §86/4 receipt when present)
 *        with the VOID overlay using each blob's PINNED templateVersion
 *        (R3-E4 / FR-016 — layout integrity preserved). Both renders happen
 *        here so the new bytes/shas are available for the audit + Phase 2.
 *     E. applyVoid UPDATE (status + void_reason + voided_by + voided_at
 *        — does NOT touch pdf_sha256 / receipt_pdf_sha256)
 *     F. emit `invoice_voided` audit (member rows carry member_id per
 *        FR-033; non-member EVENT rows route through the typed
 *        emitNonMemberInvoiceEvent helper with event_registration_id —
 *        064 W1 S32; void_reason_sha256 per PDPA B-1 redaction; the paid
 *        two-blob void additionally carries the receipt blob's before/after sha)
 *     G. enqueue cancellation email outbox row (FR-036)
 *     H. COMMIT
 *
 *   Phase 2 — post-commit Blob sync, PER BLOB (best-effort, logged failure):
 *     I. uploadPdf (overwrite at the same content-addressed key)
 *     J. applyInvoicePdfRegeneration / applyReceiptPdfRegeneration (sync the sha)
 *
 *   If Phase 2 fails for a blob, the invoice is ALREADY committed as void in the
 *   DB; that Blob still holds the original un-stamped bytes and the DB holds the
 *   original sha256. State is CONSISTENT (bytes match hash) but INCOMPLETE (the
 *   VOID overlay has not yet been applied). A sweeper + admin re-render action can
 *   reconcile. Each blob's failure emits its own `pdf_render_failed` audit with a
 *   `context` discriminator. The void is irreversible per spec so there is no
 *   "undo" path either way.
 *
 * RBAC: admin only (route handler guard).
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import { logger } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { resolveBuyerIsVatRegistrant } from '@/modules/invoicing/domain/document-kind';

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

  // Phase 1 — DB-only atomic commit. Render(s) happen inside so the new
  // bytes/shas are available for the audit payload + the Phase 2 upload(s).
  //
  // 088 T068 — a void re-render TARGET: one Blob to overwrite. A voided ISSUED
  // bill / legacy §86/4 / §105 has ONE target (the main `pdf`); a voided PAID
  // membership has TWO (the ใบแจ้งหนี้ `pdf` bill + the separate §86/4
  // `receiptPdf`). `persist` selects the sha column to sync in Phase 2;
  // `syncContext` discriminates the two blobs' Phase-2 failure audit rows.
  type VoidRenderTarget = {
    readonly blobKey: string;
    readonly rendered: { readonly bytes: Uint8Array; readonly sha256: Sha256Hex };
    readonly persist: 'invoice' | 'receipt';
    readonly syncContext:
      | 'invoice_void_phase2_sync'
      | 'invoice_void_phase2_receipt_sync';
  };
  type Phase1Success = {
    readonly voided: Invoice;
    /** Main blob (bill / §86/4 / §105) — always present. */
    readonly targetA: VoidRenderTarget;
    /** Separate §86/4 tax-receipt blob — only for a paid row with a distinct receiptPdf. */
    readonly targetB: VoidRenderTarget | null;
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

      // B. `issued` OR `paid` is voidable. Voiding a PAID membership is the
      // 088 § F.3 edge path (normal cancellation of a §86/4 is a §86/10 credit
      // note); it must still stamp VOID on both the bill + tax-receipt blobs.
      // void / credited / partially_credited / draft stay refused.
      if (lockedStatus !== 'issued' && lockedStatus !== 'paid') {
        return err({ code: 'invalid_status', status: lockedStatus });
      }

      // C. Load the full row (under the lock).
      const loaded = await deps.invoiceRepo.findByIdInTx(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!loaded) return err({ code: 'invoice_not_found' });
      // 088 T068 — `documentNumber` is NO LONGER in the completeness guard: a
      // new-flow ใบแจ้งหนี้ bill carries `document_number = NULL` (its number
      // lives in `bill_document_number_raw`), and a paid membership + β no-TIN
      // §105 as-paid row also carry NULL. The number the void re-render prints
      // is resolved below (`mainDocNum`) from whichever raw number the row has.
      if (
        !loaded.memberIdentitySnapshot ||
        !loaded.tenantIdentitySnapshot ||
        !loaded.subtotal ||
        !loaded.vat ||
        !loaded.total ||
        !loaded.vatRate ||
        !loaded.fiscalYear ||
        !loaded.issueDate ||
        !loaded.pdf
      ) {
        return err({ code: 'no_snapshot_on_invoice' });
      }
      // 064 W1 S32 — subject-aware member binding (record-payment Task-8
      // parity). A NON-member EVENT invoice legitimately has member_id NULL —
      // its BUYER lives in `member_identity_snapshot` (pinned at draft), and
      // the completeness guard above already enforced that snapshot. This is
      // the row shape the legacy no-TIN remediation runbook MUST be able to
      // void (Step 2.1); the previous blanket null-member reject made that
      // step impossible to execute for non-member rows.
      //
      // A MEMBERSHIP invoice with a null member stays a data-corruption
      // reject: `invoices_subject_fields_ck` guarantees member_id IS NOT NULL
      // for `invoice_subject='membership'`, so reaching here with one implies
      // a corrupted row (same `no_snapshot_on_invoice` class as a missing
      // snapshot — record-payment LOW-9 rationale applies verbatim).
      const memberId = loaded.memberId;
      if (memberId === null && loaded.invoiceSubject !== 'event') {
        return err({ code: 'no_snapshot_on_invoice' });
      }
      if (!settings) return err({ code: 'settings_missing' });

      // 059 / PR-A Task 6b — the retained §87/3 evidence copy must reproduce the
      // registrant status the ORIGINAL document was issued under. Both Target A
      // (main blob) and Target B (separate receipt blob, when present) share the
      // SAME buyer, so this is computed once and threaded to both re-renders.
      const buyerIsVatRegistrant = resolveBuyerIsVatRegistrant(
        memberId,
        loaded.memberIdentitySnapshot,
      );

      // 088 T068 — resolve the number the MAIN blob prints under. It is
      // whatever number the main document was ORIGINALLY issued with:
      //   - `documentNumber`         → legacy §87 §86/4 invoice / as-paid TIN combined
      //   - `billDocumentNumberRaw`  → new-flow ใบแจ้งหนี้ bill (SC)
      //   - `receiptDocumentNumberRaw` → β no-TIN as-paid §105 (main pdf IS the receipt)
      // Ordered bill-BEFORE-receipt so a paid new-flow membership (which carries
      // BOTH raw numbers) resolves the main bill to its SC number, not the RC.
      let mainDocNum: DocumentNumber;
      if (loaded.documentNumber !== null) {
        mainDocNum = loaded.documentNumber;
      } else if (loaded.billDocumentNumberRaw !== null) {
        const parsed = DocumentNumber.parse(loaded.billDocumentNumberRaw);
        if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
        mainDocNum = parsed.value;
      } else if (loaded.receiptDocumentNumberRaw !== null) {
        const parsed = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
        if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
        mainDocNum = parsed.value;
      } else {
        return err({ code: 'no_snapshot_on_invoice' });
      }
      // The main blob is a NON-tax ใบแจ้งหนี้ bill iff it was ISSUED as a bill:
      // pdf_doc_kind 'invoice' AND a bill number was allocated. A legacy §86/4
      // invoice also has pdf_doc_kind 'invoice' but NO bill number → billMode
      // stays absent → the void re-render keeps the ใบกำกับภาษี title (SC-003).
      const mainIsBill =
        loaded.pdfDocKind === 'invoice' && loaded.billDocumentNumberRaw !== null;

      // Zero-rate note inputs — threaded ONLY on a §80/1(5) row so a standard
      // re-render is byte-identical (undefined omitted from the deterministic
      // seed, SC-003). Mirrors record-payment / issue-credit-note.
      const zeroRateSpread =
        loaded.vatTreatment === 'zero_rated_80_1_5'
          ? {
              vatTreatment: loaded.vatTreatment,
              zeroRateCertNo: loaded.zeroRateCertNo,
              zeroRateCertDate: loaded.zeroRateCertDate,
            }
          : {};

      // D. Re-render the MAIN blob (Target A) with the VOID overlay, using its
      // PINNED template version per FR-016 / R3-E4 (v1 invoices re-render
      // byte-identical — logo suppressed for v1).
      const tenantLogoA = await loadTenantLogo(
        deps.blob,
        loaded.tenantIdentitySnapshot.logo_blob_key,
        loaded.pdf.templateVersion,
      );
      let renderedA;
      try {
        renderedA = await deps.pdfRender.render({
          kind: 'void_stamped_invoice',
          // 064 W1 S31 — kind-true void title: the template titles the VOID
          // document by what the ORIGINAL was (persisted at issue, migration
          // 0211), keeping the VOID watermark. A legacy §105 ใบเสร็จรับเงิน
          // original must not come back titled ใบกำกับภาษี. `?? 'invoice'`
          // is defensive only — `invoices_non_draft_has_doc_kind` makes a
          // null pdfDocKind unrepresentable on an issued row.
          voidUnderlyingKind: loaded.pdfDocKind ?? 'invoice',
          templateVersion: loaded.pdf.templateVersion,
          documentNumber: mainDocNum,
          issueDate: loaded.issueDate,
          dueDate: loaded.dueDate,
          tenant: loaded.tenantIdentitySnapshot,
          tenantLogo: tenantLogoA,
          member: loaded.memberIdentitySnapshot,
          lines: loaded.lines,
          subtotal: loaded.subtotal,
          vatRate: loaded.vatRate,
          vat: loaded.vat,
          total: loaded.total,
          voidReason: input.voidReason,
          // 088 US5 (T041 / FR-012 / SC-007) — a voided membership document is
          // the retained §87/3 evidence copy of what was cancelled: keep the WHT
          // note it originally carried (gated v>=7, so pre-v7 voids are byte-stable).
          invoiceSubject: loaded.invoiceSubject,
          // 088 T068 H-1 — preserve the VAT-inclusive annotation (event Model B)
          // on the VOID evidence copy. A one-blob EVENT as-paid receipt (§105
          // receipt_separate + as-paid-TIN receipt_combined) is stamped HERE by
          // Target A and carries vatInclusive=true (issue-event-invoice-as-paid);
          // dropping it would misstate a VAT-inclusive §87/3 retained copy as
          // VAT-exclusive (SC-003 infidelity). Mirrors Target B + record-payment
          // + issue-credit-note. Membership is vatInclusive=false (no annotation).
          vatInclusive: loaded.vatInclusive,
          // 088 T068 — a voided new-flow ใบแจ้งหนี้ bill keeps its non-tax bill
          // title (never re-titled "Tax Invoice"). `billMode` disambiguates it
          // from a legacy §86/4 void (which shares voidUnderlyingKind='invoice');
          // spread ONLY for a bill so every legacy/§86/4 void is byte-identical.
          ...(mainIsBill ? { billMode: true } : {}),
          ...zeroRateSpread,
        });
      } catch (e) {
        throw new VoidInvoiceInternalError({
          code: 'pdf_render_failed',
          reason: sanitiseErrorReason(e),
        });
      }
      const targetA: VoidRenderTarget = {
        blobKey: loaded.pdf.blobKey,
        rendered: renderedA,
        persist: 'invoice',
        syncContext: 'invoice_void_phase2_sync',
      };

      // D2. 088 § F.3 / CHK027 — a PAID membership carries a DISTINCT §86/4 tax
      // receipt blob (`receiptPdf`, the record-payment separate-receipt path).
      // Stamp it too so a voided sale never leaves an un-stamped downloadable
      // tax receipt. A one-blob paid row (as-paid combined, legacy combined,
      // event-no-TIN §105) has `receiptPdf === null` → Target B is skipped and
      // its single blob is stamped by Target A above. Mirrors issue-credit-note
      // § J2 (receipt number = RC; date = payment date on the new flow, issue
      // date on legacy reuse; the separate receipt is always the combined
      // §86/4+§105ทวิ document → voidUnderlyingKind='receipt_combined').
      let targetB: VoidRenderTarget | null = null;
      const originalReceiptPdfSha = loaded.receiptPdf?.sha256 ?? null;
      if (loaded.receiptPdf !== null) {
        let receiptDocNum: DocumentNumber;
        if (loaded.receiptDocumentNumberRaw !== null) {
          const parsed = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
          if (!parsed.ok) return err({ code: 'no_snapshot_on_invoice' });
          receiptDocNum = parsed.value;
        } else if (loaded.documentNumber !== null) {
          receiptDocNum = loaded.documentNumber;
        } else {
          return err({ code: 'no_snapshot_on_invoice' });
        }
        const receiptIssueDate =
          loaded.documentNumber === null ? loaded.paymentDate : loaded.issueDate;
        if (receiptIssueDate === null) {
          return err({ code: 'no_snapshot_on_invoice' });
        }
        const tenantLogoB = await loadTenantLogo(
          deps.blob,
          loaded.tenantIdentitySnapshot.logo_blob_key,
          loaded.receiptPdf.templateVersion,
        );
        let renderedB;
        try {
          renderedB = await deps.pdfRender.render({
            kind: 'void_stamped_invoice',
            // 088 T068 N-1 — Target B ASSUMES the separate `receiptPdf` blob is
            // always the combined §86/4+§105ทวิ receipt. That holds because the
            // ONLY path that writes a distinct receipt blob is record-payment
            // (membership + bill-first TIN event) → `receipt_combined`; the
            // event-no-TIN §105 `receipt_separate` path never reaches
            // record-payment (rejected at record-payment.ts as non-payable) and
            // its §105 doc is the SINGLE main `pdf` (stamped by Target A, not
            // here). If that guard is ever removed, a §105 separate receipt
            // would land here and be MIS-TITLED as ใบกำกับภาษี/ใบเสร็จรับเงิน —
            // gate this branch on the persisted receipt kind instead.
            voidUnderlyingKind: 'receipt_combined',
            templateVersion: loaded.receiptPdf.templateVersion,
            documentNumber: receiptDocNum,
            issueDate: receiptIssueDate,
            dueDate: loaded.dueDate,
            tenant: loaded.tenantIdentitySnapshot,
            tenantLogo: tenantLogoB,
            member: loaded.memberIdentitySnapshot,
            lines: loaded.lines,
            subtotal: loaded.subtotal,
            vatRate: loaded.vatRate,
            vat: loaded.vat,
            total: loaded.total,
            voidReason: input.voidReason,
            invoiceSubject: loaded.invoiceSubject,
            // Mirror issue-credit-note § J2 receipt re-render: preserve the
            // VAT-inclusive annotation (event Model B) on the cancelled receipt.
            vatInclusive: loaded.vatInclusive,
            ...zeroRateSpread,
          });
        } catch (e) {
          throw new VoidInvoiceInternalError({
            code: 'pdf_render_failed',
            reason: sanitiseErrorReason(e),
          });
        }
        targetB = {
          blobKey: loaded.receiptPdf.blobKey,
          rendered: renderedB,
          persist: 'receipt',
          syncContext: 'invoice_void_phase2_receipt_sync',
        };
      }

      // E. applyVoid (does NOT write pdf_sha256 / receipt_pdf_sha256 — both
      // deferred to Phase 2). CAS accepts issued|paid; a concurrent flip →
      // concurrent_state_change.
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
      //
      // 064 W1 S32 — branch on buyer kind, exactly as record-payment /
      // issue-invoice / issue-credit-note do for their lifecycle events:
      // MEMBERSHIP / matched-member → timeline branch (payload carries
      // `member_id`); NON-member event → typed `emitNonMemberInvoiceEvent`
      // (member_id FORBIDDEN at compile time; correlated via
      // event_registration_id). Payload parity: both carry the same
      // void facts. A paid two-blob void additionally carries the receipt
      // blob's before/after sha (088 T068).
      const voidedSummary = `Invoice ${mainDocNum.raw} voided`;
      const voidedPayloadBase: Record<string, unknown> = {
        invoice_id: invoiceId,
        document_number: mainDocNum.raw,
        void_reason_sha256: voidReasonHash,
        original_pdf_sha256: loaded.pdf.sha256,
        new_pdf_sha256: renderedA.sha256,
        voided_by_user_id: input.actorUserId,
        ...(targetB !== null
          ? {
              original_receipt_pdf_sha256: originalReceiptPdfSha,
              new_receipt_pdf_sha256: targetB.rendered.sha256,
            }
          : {}),
      };
      if (memberId !== null) {
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_voided',
          actorUserId: input.actorUserId,
          summary: voidedSummary,
          payload: {
            member_id: memberId,
            ...voidedPayloadBase,
          },
        });
      } else {
        // NON-member event invoice. The S32 guard above already returned
        // for a null-member NON-event invoice, so a null memberId here
        // implies `invoiceSubject === 'event'` → `invoices_subject_fields_ck`
        // guarantees `event_registration_id IS NOT NULL`. TS can't re-derive
        // that, so re-narrow on the column (record-payment idiom).
        if (loaded.eventRegistrationId === null) {
          throw new Error(
            'voidInvoice: non-member event invoice has null event_registration_id (violates invoices_subject_fields_ck)',
          );
        }
        await emitNonMemberInvoiceEvent(deps.audit, tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_voided',
          eventRegistrationId: loaded.eventRegistrationId,
          actorUserId: input.actorUserId,
          summary: voidedSummary,
          extraPayload: {
            event_id: loaded.eventId,
            ...voidedPayloadBase,
          },
        });
      }

      // G. Outbox (cancellation email per FR-036). Attaches the MAIN blob
      // (the ใบแจ้งหนี้ bill for a paid membership; the §86/4 / §105 document
      // otherwise) with Target A's freshly-rendered sha as the integrity anchor.
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
          documentNumber: mainDocNum.raw,
          // B-1 / FR-036 — admin-entered reason rendered into the
          // cancellation email body. Plaintext in the OUTBOX
          // context_data is acceptable (row purged after 90 days per
          // B-2 cron); the append-only audit log carries only
          // `void_reason_sha256` to avoid 10-year PII retention.
          voidReason: input.voidReason,
          // R17-02 — sha256 of the freshly-rendered VOID-stamped MAIN bytes
          // (Target A) we WILL upload in Phase 2. The dispatcher uses this to
          // verify the Blob's prefetched bytes match what Phase 1
          // committed to audit — if Phase 2 never uploads (Blob
          // outage, cold-start timeout), the dispatcher would
          // otherwise attach the ORIGINAL un-stamped invoice bytes
          // to a cancellation email. Integrity check preempts that
          // by permanently-failing the row.
          expectedPdfSha256: renderedA.sha256,
        });
      }

      return ok({ voided, targetA, targetB });
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
  const { voided, targetA, targetB } = phase1.value;

  // Phase 2 — post-commit Blob overwrite + sha sync, PER TARGET. Best-effort:
  // on failure the invoice is ALREADY committed as void in the DB. State after
  // a target fails:
  //   - blob upload fails → (old sha + old bytes)  CONSISTENT, un-stamped
  //   - sha-sync fails    → (old sha + new bytes)  SPLIT
  // 088 T068 M-1 — detectability is ASYMMETRIC (the prior "both detectable via
  // sha-mismatch" claim was WRONG): only the sha-sync failure is sha-mismatch
  // detectable (stored old sha ≠ new blob bytes). The blob-upload failure
  // leaves old-sha + old-bytes which MATCH, so a sha-mismatch sweep can NEVER
  // find it — its only durable signal is the best-effort `pdf_render_failed`
  // audit row below + the logger.error. Each failure carries a `context` +
  // `phase` so ops can target the right recovery blob.
  // TODO(T068 follow-up, out of scope): the correct recovery for the
  // un-stamped-blob case is a `status='void'` reconciliation sweep (re-render +
  // re-upload the VOID overlay for any void row whose blob bytes lack the
  // stamp), NOT a sha-mismatch sweep. No such sweeper exists yet — pre-existing
  // systemic gap shared with the single-blob void path.
  //
  // The targets are INDEPENDENT: the bill blob may sync while the receipt blob
  // fails (or vice-versa). We attempt BOTH regardless of the other's outcome
  // and patch each freshly-synced sha onto the returned Invoice.
  const targets: readonly VoidRenderTarget[] =
    targetB !== null ? [targetA, targetB] : [targetA];
  const syncedSha: { invoice?: Sha256Hex; receipt?: Sha256Hex } = {};

  for (const t of targets) {
    let blobUploaded = false;
    try {
      await deps.blob.uploadPdf({
        key: t.blobKey,
        body: t.rendered.bytes,
        contentType: 'application/pdf',
        allowOverwrite: true,
      });
      blobUploaded = true;
      await deps.invoiceRepo.withTx(async (tx2) => {
        if (t.persist === 'invoice') {
          await deps.invoiceRepo.applyInvoicePdfRegeneration(tx2, {
            tenantId: input.tenantId,
            invoiceId,
            pdfSha256: t.rendered.sha256,
          });
        } else {
          await deps.invoiceRepo.applyReceiptPdfRegeneration(tx2, {
            tenantId: input.tenantId,
            invoiceId,
            receiptPdfSha256: t.rendered.sha256,
          });
        }
      });
      if (t.persist === 'invoice') syncedSha.invoice = t.rendered.sha256;
      else syncedSha.receipt = t.rendered.sha256;
    } catch (e) {
      const phase: 'blob_upload' | 'sha_sync' = blobUploaded
        ? 'sha_sync'
        : 'blob_upload';
      // N-2 — DO NOT log blobKey (PG-1 regression — key embeds tenant +
      // invoice path segments). `invoiceId + tenantId` correlate the row
      // uniquely without leaking the storage layout.
      logger.error(
        {
          err: e,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
          phase,
          target: t.persist,
        },
        'voidInvoice: phase 2 blob+sha sync failed; invoice voided but PDF overlay deferred',
      );
      // R-1a — emit an audit row so the partial state is visible in the
      // append-only compliance trail + monitoring. Reuses the existing
      // `pdf_render_failed` event type (the DB enum has no dedicated
      // `invoice_pdf_sync_failed` value and the semantic umbrella "a PDF
      // operation failed" fits). The `context` field discriminates the two
      // blobs' sync failures (and, historically, render-phase failures).
      // `null` tx because the Phase-1 tx is long committed.
      //
      // M-1 — wrap in try/catch: if the audit insert itself fails
      // (connection pool exhaustion, DB outage), the Phase-2 signal would
      // otherwise bubble as an uncaught exception past the use-case boundary
      // — converting a (committed-void + deferred-overlay) state into a
      // rejected promise the route handler has to surface as a 500. The
      // logger.error above preserves the signal regardless; catching here
      // keeps the public API contract (Result<Invoice, VoidInvoiceError>).
      try {
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'pdf_render_failed',
          actorUserId: input.actorUserId,
          summary: `Invoice ${invoiceId} voided but PDF overlay deferred (phase=${phase}, target=${t.persist})`,
          payload: {
            context: t.syncContext,
            invoice_id: invoiceId,
            phase,
            expected_sha256: t.rendered.sha256,
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
    }
  }

  // R-1b — Phase 2 done: `voided` was captured from `applyVoid`'s RETURNING
  // (Phase 1, old shas). Patch the in-memory representation so callers
  // serialising this Invoice (e.g., the route handler's JSON response) see the
  // freshly-committed shas matching the blob bytes — but ONLY for the blob(s)
  // whose sync SUCCEEDED (a failed target keeps its Phase-1 sha, consistent
  // with the unchanged bytes).
  return ok({
    ...voided,
    pdf:
      voided.pdf && syncedSha.invoice
        ? { ...voided.pdf, sha256: syncedSha.invoice }
        : voided.pdf,
    receiptPdf:
      voided.receiptPdf && syncedSha.receipt
        ? { ...voided.receiptPdf, sha256: syncedSha.receipt }
        : voided.receiptPdf,
  });
}
