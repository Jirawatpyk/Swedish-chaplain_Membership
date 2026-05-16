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
import { asSatang } from '@/lib/money';
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
import type { ReceiptPdfRenderEnqueuePort } from '../ports/receipt-pdf-render-enqueue-port';
import {
  asInvoiceId,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import type {
  F4InvoicePaidEvent,
  F4InvoicePaidPaymentMethod,
  F4InvoicePaidTrigger,
} from '@/modules/invoicing/domain/f4-invoice-paid-event';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { logger } from '@/lib/logger';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';

export const recordPaymentSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  paymentMethod: z.enum(['bank_transfer', 'cheque', 'cash', 'other']),
  paymentReference: z.string().max(200).optional(),
  paymentNotes: z.string().max(1000).optional(),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD
  // R7-S3 — `idempotencyKey` is accepted by the input schema but
  // CURRENTLY IGNORED by this use-case. Status-based replay detection
  // (the `status === 'paid'` short-circuit plus the applyPayment
  // `WHERE status='issued'` guard) already prevents double-apply on
  // the same invoice, which is the only concurrency failure mode
  // this endpoint has to defend against at F4 scale.
  //
  // The field is RESERVED for a future Phase-10 enhancement that
  // persists the key to an `idempotency_key` column + a processed-
  // key log, giving callers a way to DISTINGUISH "already acked"
  // from "first successful apply" on retries. Tracked in
  // `specs/007-invoices-receipts/tasks.md § Phase 10`.
  idempotencyKey: z.string().min(1).max(200).optional(),
  /**
   * F5 hook (T128a, formalised 2026-04-27 verify-driven): when `true`,
   * the auto-email outbox enqueue at the tail is skipped. Does NOT
   * affect status transition, audit emission, PDF render+upload, or
   * any other side-effect — only the receipt-email dispatcher row.
   *
   * Set by F5 `confirmPayment` when the tenant's
   * `tenant_payment_settings.auto_email_on_payment = false`. F4
   * admin-initiated `recordPayment` calls leave this undefined → the
   * existing `tenant_invoice_settings.autoEmailEnabled` gate continues
   * to govern as before. F4 behaviour for non-F5 callers is unchanged.
   *
   * Constitution Principle IV (PCI DSS): no card data flows through
   * this flag — pure boolean toggle, audit-trail unaffected.
   */
  suppressReceiptEmail: z.boolean().optional(),
  /**
   * F8 Phase 2 Wave A — origin of the mark-paid action. Surfaces in
   * `F4InvoicePaidEvent.triggeredBy` so cross-module listeners can
   * branch on the trigger. Defaults to `'admin_manual'` to preserve
   * backward-compat for existing F4 admin paths that don't set it.
   */
  triggeredBy: z
    .enum(['webhook', 'admin_manual', 'admin_offline_mark'])
    .optional(),
  /**
   * F8 Phase 2 Wave A — F5-rail override for the callback event. F4's
   * persisted `paymentMethod` enum is narrower than F5's processor rail
   * set (Stripe rails serialise as `'other'` on the invoice row); this
   * field carries the original processor rail string so listeners
   * receive `stripe_card` / `stripe_promptpay` instead of `'other'`.
   * F4 admin paths leave it undefined → callback uses `paymentMethod`.
   */
  processorMethod: z.enum(['stripe_card', 'stripe_promptpay']).optional(),
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
  /**
   * T166-03 — Async receipt PDF render enqueue port. Required when
   * `asyncReceiptPdf=true`; never invoked when the flag is false.
   * Optional in the type so existing callers + tests don't break.
   */
  readonly receiptPdfRenderEnqueue?: ReceiptPdfRenderEnqueuePort;
  /**
   * T166-03 — When `true`, skip the synchronous `renderAndUploadPdf`
   * call inside the webhook tx; commit the invoice as `paid` with
   * `receipt_pdf_status='pending'` and enqueue a `receipt_pdf_render`
   * outbox row instead. Default `false` keeps the inline path (back-
   * compat for admin manual mark-paid + the F5 R7 round-2 ship path).
   * Composition root reads `env.features.f5AsyncReceiptPdf`.
   */
  readonly asyncReceiptPdf?: boolean;
  /**
   * F8 Phase 2 Wave A (T008) — cross-module on-paid hooks. Fired in
   * registration order INSIDE the same `withTx` after applyPayment +
   * audit emit + outbox enqueue + registration-fee flip have all
   * succeeded, but BEFORE the tx commits. Any rejection rolls back the
   * entire transaction (invoice stays `issued`, audit + outbox + reg-
   * fee flip are unwound). Atomic by construction — no separate
   * compensating action needed on the listener side.
   *
   * Registered at composition time via `makeRecordPaymentDeps(..., onPaidCallbacks)`.
   * F8 wires its `complete-cycle-on-paid` adapter here per research.md R12.
   * Default `[]` keeps the existing F4 admin manual mark-paid + F5
   * webhook code paths unchanged for callers that don't pass callbacks.
   */
  /**
   * I3 review-fix: callbacks now receive the F4-internal tx so they
   * can participate atomically (cf. F8 mark-cycle-complete avoiding a
   * separate runInTenant). Tx is `unknown` to keep cross-module
   * contract framework-free; listeners cast it back. Listeners that
   * don't need the tx may simply ignore the parameter.
   */
  readonly onPaidCallbacks?: ReadonlyArray<
    (evt: F4InvoicePaidEvent, tx?: unknown) => Promise<void>
  >;
}

export async function recordPayment(
  deps: RecordPaymentDeps,
  input: RecordPaymentInput,
): Promise<Result<Invoice, RecordPaymentError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);

  // R17-03 — Load settings BEFORE the withTx. The settings repo opens its
  // own `runInTenant` transaction under the hood; nesting that inside the
  // outer withTx can deadlock the pool when concurrent payments on
  // different invoices race for the two connection pool slots (outer tx
  // holds conn1, inner settings-read waits for conn2 which is held by the
  // other concurrent caller, and vice versa). Settings are effectively
  // immutable during a payment record (the immutability trigger on
  // tenant_invoice_settings makes mid-race mutation a no-op), so reading
  // outside the tx is safe. Mirrors the identical fix + rationale in
  // issue-credit-note.ts:126-135 and void-invoice.ts:130-132.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  // R18-03 — early-exit on missing settings BEFORE opening withTx +
  // acquiring lockForUpdate. Matches the "pre-sequence early exits"
  // pattern in issue-invoice.ts:155-163 and saves a useless round-trip
  // + probe audit emit when the tenant has no settings row yet.
  if (!settings) return err({ code: 'settings_missing' });

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
      const loaded = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
      if (!loaded) return err({ code: 'invoice_not_found' });
      return ok(loaded);
    }

    if (lockedStatus !== 'issued') {
      return err({ code: 'invalid_status', status: lockedStatus });
    }

    const loaded = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
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

    // H+I. Render receipt PDF + upload to Blob (T126 shared helper).
    // Throws via `RecordPaymentInternalError` on either failure so
    // `withTx` rolls back — the receipt sequence increment is NOT
    // consumed (separate-mode) and the invoice stays `issued`.
    //
    // T166-03 (Phase 9 polish): when `deps.asyncReceiptPdf=true`,
    // skip the synchronous render+upload entirely. The invoice
    // commits as `paid` with `receipt_pdf_status='pending'`; a
    // `receipt_pdf_render` outbox row enqueued below drives async
    // render via the F4 dispatcher. Sequential numbering stays atomic
    // with the `paid` flip (Thai Revenue Code §86/§87 invariant).
    //
    // Combined-mode 2-file design (Thai RD §86/4 + §105ทวิ):
    // ------------------------------------------------------------------
    // The system persists TWO physical PDFs per paid invoice on
    // BOTH combined and separate numbering modes:
    //   - `invoice.pdf` — rendered at issue time, header "ใบกำกับภาษี
    //     / Tax Invoice". This is the pre-payment document.
    //   - `invoice.receiptPdf` — rendered at payment time, header
    //     "ใบกำกับภาษี / ใบเสร็จรับเงิน" (combined mode) OR
    //     "ใบเสร็จรับเงิน / Official Receipt" (separate mode). This
    //     is the post-payment authoritative document.
    //
    // Why two files when combined-mode is "one legal document":
    //   - Pre-payment: customer needs a tax invoice with no receipt
    //     marking yet (per RD §86/4 issuance trigger = sale event).
    //   - Post-payment: the SAME document number is re-rendered with
    //     the dual-role header so it now ALSO functions as a receipt
    //     (§105ทวิ). Thai bookkeeping treats the LATEST version as
    //     the official record.
    //   - This matches the upstream RD interpretation of "one document
    //     doing dual function" — they're versions of the same logical
    //     document at different points in time, not two distinct
    //     §87 sequence allocations.
    //
    // UI surfaces enforce the convention:
    //   - Admin invoice-detail menu HIDES "Download Invoice" when
    //     `isPaidCombined` (the pre-payment version is a stale draft);
    //     only the combined-receipt PDF is exposed for download.
    //   - Separate-mode keeps BOTH downloads because the two docs
    //     have distinct §87 sequence numbers and must be filed apart.
    const receiptBlobKey = `invoicing/${input.tenantId}/${loaded.fiscalYear}/${loaded.invoiceId}_receipt_v${deps.currentTemplateVersion}.pdf`;
    const tenantLogo = deps.asyncReceiptPdf
      ? null
      : await loadTenantLogo(
          deps.blob,
          loaded.tenantIdentitySnapshot.logo_blob_key,
          deps.currentTemplateVersion,
        );
    const rendered =
      deps.asyncReceiptPdf
        ? null
        : await renderAndUploadPdf(
            { pdfRender: deps.pdfRender, blob: deps.blob },
            {
              renderInput: {
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
                tenantLogo,
                member: loaded.memberIdentitySnapshot,
                lines: loaded.lines,
                subtotal: loaded.subtotal,
                vatRate: loaded.vatRate,
                vat: loaded.vat,
                total: loaded.total,
              },
              blobKey: receiptBlobKey,
            },
            (code, reason) => new RecordPaymentInternalError({ code, reason }),
          );

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
        receiptPdf:
          rendered !== null
            ? {
                kind: 'rendered',
                blobKey: receiptBlobKey,
                sha256: rendered.sha256,
                templateVersion: deps.currentTemplateVersion,
                // Persist the receipt doc number on the SYNC path too so
                // the detail page + list column can read it back without
                // re-parsing the PDF bytes. Previously only the async
                // (pending) branch wrote this — sync invoices ended up
                // with NULL on the row even when separate-mode allocated
                // a real RC sequence number into the rendered PDF.
                // NULL for combined-mode (receipt reuses invoice number).
                receiptDocumentNumberRaw: combinedMode
                  ? null
                  : receiptDocNumRaw,
              }
            : {
                kind: 'pending',
                // T166 R1-C1 — persist the pre-allocated receipt doc
                // number so the worker reads it back instead of
                // re-allocating (which would burn fresh §87 sequence
                // numbers on every retry, leaving gaps in
                // tenant_document_sequences.receipt). NULL for
                // combined-mode (worker reuses invoice doc num).
                receiptDocumentNumberRaw: combinedMode
                  ? null
                  : receiptDocNumRaw,
              },
      });

      // T166-03 — async path: enqueue render task NOW (inside the same
      // tx as the `paid` flip, so the dispatcher cannot pick up a row
      // that hasn't committed yet). Worker fills blob_key + sha256 +
      // status='rendered' later via `applyReceiptPdf`.
      if (deps.asyncReceiptPdf && deps.receiptPdfRenderEnqueue) {
        await deps.receiptPdfRenderEnqueue.enqueue(tx, {
          tenantId: input.tenantId,
          invoiceId,
          fiscalYear: loaded.fiscalYear,
          templateVersion: deps.currentTemplateVersion,
          // Render tasks aren't emails — dispatcher routes by
          // notification_type, NOT to_email. The column is NOT NULL on
          // the table so we pass through the member's primary contact
          // email (best-effort breadcrumb for ops correlation) or a
          // system sentinel when the snapshot is incomplete.
          recipientEmail:
            loaded.memberIdentitySnapshot.primary_contact_email ??
            'system:async-render@swecham.test',
        });
      }
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
        // US7 — surfaces this event in the F3 member timeline, which
        // queries `payload->>'member_id'`. Required for the timeline
        // contract even though invoices.member_id is derivable.
        member_id: loaded.memberId,
        payment_method: input.paymentMethod,
        payment_reference_sha256: paymentReferenceSha256,
        payment_date: input.paymentDate,
        recorded_by_user_id: input.actorUserId,
        receipt_document_number: receiptDocNumRaw,
        // T166-03: sha256 is null when async render is in flight; the
        // worker emits a separate `receipt_rendered` audit event
        // carrying the sha256 once the bytes land.
        receipt_pdf_sha256: rendered ? rendered.sha256 : null,
        // R1-S3 — forensic flag so audit consumers can distinguish
        // "sha256 is intentionally null because async path took over"
        // from "sha256 is null because of a bug". Pairs with the
        // separate `receipt_rendered` audit row that lands later.
        receipt_pdf_async: deps.asyncReceiptPdf === true,
      },
    });

    // Defensive guard (T082 empirical 2026-04-24): the Domain type
    // `MemberIdentitySnapshot.primary_contact_email` is declared
    // non-nullable, and `issue-invoice` always snapshots it from the
    // validated primary contact — so in normal production flow this
    // branch is always truthy. The `?? null` fallback only triggers
    // on legacy invoice rows whose snapshot was seeded/migrated
    // before the field was tightened. We skip-with-warn rather than
    // throwing because: (a) the payment itself has already settled
    // on Stripe, (b) the invoice row transitions to `paid` via the
    // applyPayment above, (c) a failure here would cause Stripe to
    // retry the webhook indefinitely and potentially double-enqueue
    // on a future fix, and (d) admins can resend the receipt email
    // manually from /admin/invoices once ops investigates.
    const recipientEmail =
      loaded.memberIdentitySnapshot.primary_contact_email ?? null;
    // T128a: F5 caller may suppress the receipt-email enqueue when the
    // tenant has disabled `auto_email_on_payment`. Status flip + audit +
    // outbox-skip log row still run — only the dispatcher enqueue is
    // gated. Spec.md:433: "MAY suppress" (optional override).
    if (
      settings.autoEmailEnabled &&
      recipientEmail &&
      !input.suppressReceiptEmail
    ) {
      await deps.outbox.enqueue(tx, {
        tenantId: input.tenantId,
        eventType: 'invoice_paid',
        recipientEmail,
        invoiceId,
        pdfBlobKey: receiptBlobKey,
        pdfTemplateVersion: deps.currentTemplateVersion,
        // T166-09 — when async PDF is on, the receipt blob doesn't
        // exist yet at email-enqueue time. The dispatcher gates the
        // send on `invoices.receipt_pdf_status='rendered'` to avoid
        // shipping a dead Blob link.
        dependsOnReceiptPdf: deps.asyncReceiptPdf === true,
      });
    } else if (
      settings.autoEmailEnabled &&
      recipientEmail &&
      input.suppressReceiptEmail
    ) {
      // T128a observability: explicit log when F5 suppressed an email
      // that F4 would otherwise have enqueued. Helps ops correlate
      // "no receipt email" complaints with the tenant's setting state.
      logger.info(
        {
          tenantId: input.tenantId,
          invoiceId,
          memberId: loaded.memberId,
          documentNumber: loaded.documentNumber?.raw,
          reason: 'tenant_auto_email_on_payment_disabled',
        },
        'recordPayment: receipt-email outbox enqueue suppressed by F5 caller',
      );
    } else if (settings.autoEmailEnabled && !recipientEmail) {
      // Skip-with-warn: snapshot is missing the required field. This
      // is a Domain-invariant violation upstream (likely a legacy or
      // manually-patched invoice row). Observability surface so ops
      // can detect + backfill the bad row.
      logger.warn(
        {
          tenantId: input.tenantId,
          invoiceId,
          memberId: loaded.memberId,
          documentNumber: loaded.documentNumber?.raw,
        },
        'recordPayment: invoice snapshot missing primary_contact_email — auto-email receipt skipped',
      );
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

    // F8 Phase 2 Wave A (T008) — fire registered on-paid callbacks
    // INSIDE the still-open withTx, after every other side-effect
    // (applyPayment, audit, outbox enqueue, registration-fee flip)
    // has succeeded. A callback rejection propagates out of `withTx`
    // and rolls back the entire transaction — F4 invoice goes back to
    // `issued`, audit + outbox + reg-fee flip are unwound. Atomic
    // coordination per Constitution Principle VIII (Reliability).
    //
    // Listeners receive the canonical event payload AND an opaque
    // `unknown`-typed tx handle (`cb(evt, tx)` below). The `unknown`
    // typing keeps the cross-module contract framework-free per
    // Principle III — F4 does not export Drizzle types into F8 — while
    // still letting listeners participate atomically in this same `tx`.
    // Listeners that don't need the tx may ignore the second parameter;
    // those that DO need it cast back to their own internal `TenantTx`
    // brand at the consumer side (see F8 `f8OnPaidCallbacks` for the
    // canonical pattern + runtime brand-check).
    //
    // The non-null assertions on `loaded.total` and `updated.paidAt`
    // are guarded upstream: `no_snapshot_on_invoice` returns early when
    // `loaded.total` is null (line ~204), and `applyPayment` always
    // populates `paid_at` on a successful issued→paid UPDATE (RETURNING
    // contract). A failed adapter would have thrown before this point.
    const callbacks = deps.onPaidCallbacks;
    if (callbacks && callbacks.length > 0) {
      // `processorMethod` overrides `paymentMethod` in the event for F5
      // rails — see field doc on the input schema. `triggeredBy` defaults
      // to `'admin_manual'` for back-compat with existing F4 admin paths.
      const eventPaymentMethod: F4InvoicePaidPaymentMethod =
        input.processorMethod ?? input.paymentMethod;
      const eventTrigger: F4InvoicePaidTrigger =
        input.triggeredBy ?? 'admin_manual';
      const evt: F4InvoicePaidEvent = {
        tenantId: input.tenantId,
        invoiceId,
        memberId: loaded.memberId,
        paidAt: updated.paidAt ?? deps.clock.nowIso(),
        // F5R3 H-5 (2026-05-16) — brand at Money escape into the
        // F4InvoicePaidEvent payload broadcast to F8 onPaid callbacks.
        amountSatang: asSatang(loaded.total!.satang),
        vatSatang: asSatang(loaded.vat!.satang),
        currency: loaded.currency,
        paymentMethod: eventPaymentMethod,
        triggeredBy: eventTrigger,
      };
      for (const cb of callbacks) {
        // I3 review-fix: thread the F4-internal tx so listeners can
        // participate atomically. Listeners that don't need it ignore
        // the second parameter — cross-module contract stays narrow.
        await cb(evt, tx);
      }
    }

    // `applyPayment` returns the refreshed row via RETURNING — no need
    // for a second findByIdInTx round-trip.
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
      // T122 — emit `pdf_render_failed` audit AFTER the tx rolled
      // back so forensic evidence survives (parity with
      // issue-invoice.ts:375–399). Fire-and-forget: never mask the
      // original error with an audit-write failure.
      if (e.error.code === 'pdf_render_failed') {
        try {
          await deps.audit.emit(null, {
            tenantId: input.tenantId,
            requestId: input.requestId ?? null,
            eventType: 'pdf_render_failed',
            actorUserId: input.actorUserId,
            summary: `PDF render failed for receipt on invoice ${input.invoiceId}`,
            payload: {
              invoice_id: input.invoiceId,
              render_kind: 'receipt',
              reason: e.error.reason,
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr, invoiceId: input.invoiceId },
            'recordPayment: pdf_render_failed audit emit also failed',
          );
        }
      }
      return err(e.error);
    }
    throw e;
  }
}
