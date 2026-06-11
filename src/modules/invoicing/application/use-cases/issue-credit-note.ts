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
 * credited_total stays intact; the Blob upload may leave an orphan at
 * the content-addressed key. No sweeper exists (accepted residual, 064
 * design §3.2 L-1). Both issueInvoice and issueEventInvoiceAsPaid now
 * carry a catch-path delete to mitigate the orphan; credit notes do NOT
 * need one because they are EXEMPT from the byte-drift class that motivates
 * it: each attempt mints a FRESH `creditNoteId` via `randomUUID()` (line
 * ~200), so the blob key is unique per attempt — a retry never collides
 * with a prior attempt's orphan, and re-render byte-drift cannot corrupt a
 * later success. The orphan is at worst dead bytes a future sweeper reclaims.
 *
 * RBAC: admin only (route handler guard).
 * Concurrent race: two admins issuing partial credit notes against the
 * same invoice serialise via the invoice row FOR UPDATE — exactly one
 * succeeds if the combined amount would exceed total.
 */
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from '@/lib/result';
import {
  addSatang,
  asSatang,
  asSatangUnchecked,
  type UntrustedSatang,
} from '@/lib/money';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { CreditNoteRepo } from '../ports/credit-note-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
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
import { inferEventDocumentKind } from '@/modules/invoicing/domain/document-kind';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';

export const issueCreditNoteSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  /** Gross amount to credit (in satang, incl. VAT). Must be > 0. */
  creditTotalSatang: z.bigint().positive(),
  /** Free-text reason (required, max 500 char). Persisted + rendered on PDF. */
  reason: z.string().trim().min(1).max(500),
  /**
   * F5 extension — when set, `credit_notes.source_refund_id` is populated
   * so admin UIs + timelines can distinguish F5-origin CNs from
   * F4-manual issues. Supplied by the `issueCreditNoteFromRefund`
   * bridge wrapper; F4-manual flows omit it.
   */
  sourceRefundId: z.string().min(1).optional(),
});

export type IssueCreditNoteInput = z.infer<typeof issueCreditNoteSchema>;

/**
 * MEDIUM-5 — outcome of the auto-email enqueue, surfaced on the success
 * result so the route + admin UI can give the operator a NON-blocking
 * signal instead of a silent skip:
 *
 *   - `'sent'`                 → an outbox row was enqueued to the buyer's
 *                                snapshotted contact email.
 *   - `'skipped_no_recipient'` → auto-email is ON but the buyer snapshot has
 *                                NO contact email (a non-member EVENT buyer may
 *                                carry an empty `primary_contact_email`). The CN
 *                                is fully issued + persisted; only the email was
 *                                skipped. The UI shows a non-blocking notice so
 *                                the admin knows to send the document manually.
 *   - `'not_requested'`        → auto-email is OFF (per-invoice override or
 *                                tenant default). A deliberate non-send — the UI
 *                                shows NO notice (nothing went wrong).
 *
 * NOTE — `issue-invoice.ts` has the SAME empty-recipient skip pattern (its
 * outbox enqueue is guarded on a non-empty recipient with a parallel warn log).
 * For UX consistency it could surface the same signal; out of scope here.
 */
export type CreditNoteEmailDelivery = 'sent' | 'skipped_no_recipient' | 'not_requested';

/**
 * Success payload — the issued `CreditNote` aggregate plus the transient
 * email-delivery signal. The signal is deliberately NOT folded onto the
 * `CreditNote` domain object (it is per-issue request state, not part of the
 * immutable tax document) — it rides alongside on the use-case boundary only.
 */
export interface IssueCreditNoteSuccess {
  readonly creditNote: CreditNote;
  readonly emailDelivery: CreditNoteEmailDelivery;
}

export type IssueCreditNoteError =
  | { code: 'invoice_not_found' }
  | { code: 'invalid_status'; status: InvoiceStatus }
  | { code: 'no_snapshot_on_invoice' }
  /**
   * LOW-12 — data-integrity guard. An `invoice_subject='event'` row is
   * DB-CHECK-guaranteed (`invoices_subject_fields_ck`) to carry a non-null
   * `event_registration_id`. If a corrupted row somehow reaches here with a
   * null one, we reject BEFORE allocating a §87 credit-note number (no
   * side effects) rather than emit a null into the non-member audit payload
   * — which the audit contract types as a string. Same class as
   * `no_snapshot_on_invoice`: a row that violates its own subject invariant.
   */
  | { code: 'invalid_event_invoice' }
  /**
   * final-review HIGH 1 / §86/10 ruling — the parent is a §105 ใบเสร็จรับเงิน
   * (a `receipt_separate` event invoice issued to a buyer WITHOUT a 13-digit
   * TIN). A credit note (ใบลดหนี้, §86/10) can ONLY legally adjust a §86/4 tax
   * invoice (ใบกำกับภาษี). It can never reference a §105 receipt — the buyer
   * never received an input-VAT-claimable tax invoice, so there is nothing to
   * credit. The correct remedy is a direct refund or a void. Returned BEFORE
   * `allocateNext` so a blocked attempt never burns a §87 credit-note sequence
   * number.
   */
  | { code: 'receipt_not_creditable' }
  | { code: 'settings_missing' }
  | {
      // F5R3v4 M-5 (2026-05-16) — fields are `UntrustedSatang`
      // because they preserve corrupt diagnostic values (the err
      // exists exactly to record over-credit + corruption cases).
      // Type-distinct from `Satang` so arithmetic helpers reject
      // silent folding at compile time.
      code: 'credit_exceeds_remainder';
      invoiceTotalSatang: UntrustedSatang;
      alreadyCreditedSatang: UntrustedSatang;
      proposedSatang: UntrustedSatang;
      remainingSatang: UntrustedSatang;
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
): Promise<Result<IssueCreditNoteSuccess, IssueCreditNoteError>> {
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
  //
  // INVARIANT: `deps.invoiceRepo.withTx` MUST NOT auto-retry the
  // callback. If a future refactor adds retry-on-serialization-fail
  // behaviour, `pendingRenderKind` would observe stale state from a
  // prior attempt and lie about the failed site. Reset to `null` at
  // the top of every attempt OR move the variable inside the closure
  // if retry is introduced.
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

      // §86/10 doc-type gate (final-review HIGH 1) — BLOCK crediting a §105
      // ใบเสร็จรับเงิน (`receipt_separate`). A credit note can only adjust a
      // §86/4 tax invoice (ใบกำกับภาษี, kind='invoice'); a buyer who never
      // received a TIN-bearing tax invoice has no input VAT to reverse, so a
      // §86/10 ใบลดหนี้ against their §105 receipt is legally void.
      //
      // ORDER (064 Task 10) — this gate runs BEFORE the snapshot-completeness
      // guard below: a β as-paid no-TIN row (issueEventInvoiceAsPaid,
      // migration 0212) is a LEGAL paid row whose invoice-stream
      // `documentNumber` is genuinely NULL (its number lives in
      // `receipt_document_number_raw`), so the completeness guard's
      // `!loaded.documentNumber` arm would misclassify it as a corrupted row
      // (`no_snapshot_on_invoice`) when the §86/10 verdict is the truthful
      // rejection. The gate needs only `invoiceSubject` + the buyer
      // snapshot's TIN, so hoisting it is safe — and the `?.` is now
      // load-bearing for a (corrupt) event row with a missing snapshot,
      // which resolves to no-TIN → receipt_separate → blocked here.
      //
      // DETECTION — reconstructed from the persisted `invoiceSubject` + the
      // BUYER snapshot's TIN via the shared `inferEventDocumentKind`,
      // mirroring the issue-time gates EXACTLY so issue-time, pay-time, and
      // credit-time stay in lockstep (FIX 5 shared Domain discriminator).
      // `invoices.pdf_doc_kind` (migration 0211) persists the same verdict;
      // the J2 annotation re-render reads the column (Task 12) while this
      // gate keeps the derivation so the lockstep sites share one source.
      //
      // Runs BEFORE `allocateNext` (POST-SEQUENCE zone), so a blocked attempt
      // never burns a §87 credit-note sequence number — the §87 CN stream
      // stays gap-free. Mirrors the issue-invoice rule that the doc-type gate
      // precedes sequence allocation.
      const isReceiptSeparate =
        inferEventDocumentKind(
          loaded.invoiceSubject,
          loaded.memberIdentitySnapshot?.tax_id,
        ) === 'receipt_separate';
      if (isReceiptSeparate) {
        return err({ code: 'receipt_not_creditable' });
      }

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
      // 054-event-fee-invoices (Task 8) — `memberId` is nullable. Membership
      // invoices always carry one (`invoices_subject_fields_ck`); NON-member
      // EVENT invoices have `member_id IS NULL` but DO carry a complete pinned
      // buyer snapshot (set at draft by createEventInvoiceDraft). The snapshot
      // completeness guard above (memberIdentitySnapshot/subtotal/vat/vatRate
      // non-null) already protects the credit-note math + render, so a null
      // memberId is NOT a missing-snapshot condition. We keep `memberId` only
      // to branch the audit (timeline vs non-timeline) below — do NOT early-
      // return on it (removing the prior bug guard that wrongly blocked
      // crediting non-member event invoices).
      const memberId = loaded.memberId;

      // LOW-12 — data-integrity guard for event invoices. `eventRegistrationId`
      // is typed `string | null` on the aggregate but the DB CHECK
      // `invoices_subject_fields_ck` guarantees it is NON-null whenever
      // `invoiceSubject === 'event'`. The non-member audit branch below emits
      // it into a payload that the audit contract types as a string, so a
      // (corrupted) null would violate that contract. Reject cleanly here —
      // BEFORE the POST-SEQUENCE zone, so no §87 number is burned and nothing
      // needs to roll back (parity with the `no_snapshot_on_invoice` early
      // return). Under valid state this branch is unreachable.
      //
      // FIX 10/12 — bind the non-null id into a `const` HERE, where the
      // `invoiceSubject === 'event'` narrowing is valid (TS cannot re-derive
      // it at the audit emit, which only knows `memberId === null`). The
      // non-member audit branch consumes `eventRegistrationId` directly, with
      // NO `?? ''` fallback — so if this guard is ever removed, the emit fails
      // to compile (loud) instead of silently persisting an empty string.
      //
      // 054-event-fee-invoices (DU refactor) — `Invoice` is now a discriminated
      // union on `invoiceSubject`, so the 'event' arm types `eventRegistrationId`
      // as non-null `string`. The DB CHECK + the repo seam's
      // `MalformedInvoiceSubjectError` already make `event`+null-registration-id
      // unrepresentable for any row loaded through the repo. We DELIBERATELY keep
      // the runtime null-check as defence-in-depth (it stays reachable via a
      // mock-injected fabricated row — see the LOW-12 unit test — and preserves
      // the `invalid_event_invoice` → 422 contract). To keep the check live and
      // type-checking, we read the discriminant-agnostic union field
      // (`string | null`) into `rawEventRegistrationId` BEFORE narrowing, so the
      // `=== null` comparison is not statically eliminated.
      const rawEventRegistrationId: string | null = loaded.eventRegistrationId;
      let eventRegistrationId: string | null = null;
      if (loaded.invoiceSubject === 'event') {
        if (rawEventRegistrationId === null) {
          logger.error(
            { tenantId: input.tenantId, invoiceId, invoiceSubject: loaded.invoiceSubject },
            'issueCreditNote: event invoice missing event_registration_id (corrupted row) — rejecting',
          );
          return err({ code: 'invalid_event_invoice' });
        }
        eventRegistrationId = rawEventRegistrationId;
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
        // F5R3v2 B-1 — forensic err payload via `asSatangUnchecked`
        // (see @/lib/money). Clamp negative remaining to 0n for the
        // SC-013 invariant; raw corrupted values flow into the audit.
        const remaining =
          loaded.total.satang >= loaded.creditedTotal.satang
            ? loaded.total.satang - loaded.creditedTotal.satang
            : 0n;
        return err({
          code: 'credit_exceeds_remainder',
          invoiceTotalSatang: asSatangUnchecked(loaded.total.satang),
          alreadyCreditedSatang: asSatangUnchecked(loaded.creditedTotal.satang),
          proposedSatang: asSatangUnchecked(proposed.satang),
          remainingSatang: asSatangUnchecked(remaining),
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
      const tenantLogo = await loadTenantLogo(
        deps.blob,
        loaded.tenantIdentitySnapshot.logo_blob_key,
        deps.currentTemplateVersion,
      );
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
            tenantLogo,
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
          // F5R3 H-5 (2026-05-16) — brand at Money VO escape to port input.
          creditAmountSatang: asSatang(creditAmount.satang),
          vatSatang: asSatang(vat.satang),
          totalSatang: asSatang(total.satang),
          tenantIdentitySnapshot: loaded.tenantIdentitySnapshot,
          memberIdentitySnapshot: loaded.memberIdentitySnapshot,
          pdf: {
            blobKey,
            sha256: rendered.sha256,
            templateVersion: deps.currentTemplateVersion,
          },
          ...(input.sourceRefundId !== undefined
            ? { sourceRefundId: input.sourceRefundId }
            : {}),
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
      // F5R3 H-5 (2026-05-16) — branded arithmetic via addSatang
      // preserves the Satang brand into the port input.
      const newCreditedTotal = addSatang(
        asSatang(loaded.creditedTotal.satang),
        asSatang(total.satang),
      );
      const fullyCredited = newCreditedTotal === asSatang(loaded.total.satang);
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
        //
        // Round-3 fix R3-H3 — re-load tenantLogo with the invoice's
        // PINNED template version (could be v1). For v1 the helper
        // returns null → logo suppressed → bytes stay byte-equivalent
        // to the original (modulo the CREDITED overlay).
        const annotationTenantLogo = await loadTenantLogo(
          deps.blob,
          loaded.tenantIdentitySnapshot.logo_blob_key,
          loaded.pdf.templateVersion,
        );
        pendingRenderKind = 'annotation';
        const rerendered = await renderAndUploadPdf(
          { pdfRender: deps.pdfRender, blob: deps.blob },
          {
            renderInput: {
              // 064 Task 12 — reproduce what the MAIN blob actually holds.
              // `invoices.pdf_doc_kind` (migration 0211) is the persisted
              // record of the issue-time render; it WINS over any derivation
              // (the as-paid TIN parent derives 'invoice' from its TIN, but
              // its main blob IS the combined ใบกำกับภาษี/ใบเสร็จรับเงิน).
              // Reachable parents after the §86/10 gate above:
              //   - membership rows           → 'invoice'
              //   - bill-first TIN event rows → 'invoice' (record-payment's
              //     receipt_combined bytes live in the SEPARATE receipt blob;
              //     the main blob stays frozen at issue — final-review C1)
              //   - as-paid TIN event rows    → 'receipt_combined' (the main
              //     blob is the only §105ทวิ receipt evidence, 10y retention)
              // 'receipt_separate' parents are rejected by the
              // `receipt_not_creditable` guard before this point. The NULL
              // fallback is defensive only — `invoices_non_draft_has_doc_kind`
              // forbids NULL on any non-draft row, and falling back to
              // 'invoice' matches the pre-064 behaviour.
              kind: loaded.pdfDocKind ?? 'invoice',
              templateVersion: loaded.pdf.templateVersion,
              documentNumber: loaded.documentNumber,
              issueDate: loaded.issueDate,
              dueDate: loaded.dueDate,
              tenant: loaded.tenantIdentitySnapshot,
              tenantLogo: annotationTenantLogo,
              member: loaded.memberIdentitySnapshot,
              lines: loaded.lines,
              subtotal: loaded.subtotal,
              vatRate: loaded.vatRate,
              vat: loaded.vat,
              total: loaded.total,
              // 054-event-fee-invoices — preserve the VAT-inclusive annotation
              // when re-annotating a credited EVENT invoice (Model B). Membership
              // invoices carry `false` so the re-render stays byte-equivalent to
              // the original (modulo the CREDITED overlay) per SC-003 intent.
              vatInclusive: loaded.vatInclusive,
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

      // K. Audit `credit_note_issued` — branch on buyer kind (054-event-fee-
      // invoices Task 8).
      //
      //   MEMBERSHIP / matched-member (memberId non-null) → TIMELINE branch:
      //   the payload carries `member_id` so the F3 member timeline filter
      //   (`payload->>'member_id'`) surfaces the credit note (US7). UNCHANGED
      //   F4 behaviour.
      //
      //   NON-MEMBER event (memberId null) → NON-timeline branch: the buyer is
      //   not an F3 member, so the timeline filter MUST NOT surface it. We do
      //   NOT widen `MemberTimelineAuditPayload` to make `member_id` optional
      //   (that would weaken the F3 `member_id` guarantee for the member-timeline
      //   event types); instead we narrow `credit_note_issued` to the non-timeline
      //   `F4AuditEvent` branch at THIS one site, carrying `event_registration_id`
      //   and omitting `member_id` entirely. Mirrors the `emitNonTimelineDraftCreated`
      //   precedent in create-event-invoice-draft.ts + the issue-invoice.ts
      //   non-member branch.
      const creditNoteSummary = `Credit note ${docNum.value.raw} issued against ${loaded.documentNumber.raw}`;
      const creditNotePayloadBase: Record<string, unknown> = {
        credit_note_id: creditNoteId,
        original_invoice_id: invoiceId,
        credit_amount_satang: creditAmount.satang.toString(),
        vat_satang: vat.satang.toString(),
        total_satang: total.satang.toString(),
        reason: input.reason,
        document_number: docNum.value.raw,
        pdf_sha256: rendered.sha256,
      };
      if (memberId !== null) {
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'credit_note_issued',
          actorUserId: input.actorUserId,
          summary: creditNoteSummary,
          payload: {
            // US7 — surfaces in the F3 member timeline (filter is on
            // `payload->>'member_id'`).
            member_id: memberId,
            ...creditNotePayloadBase,
          },
        });
      } else {
        // LOW-12 / FIX 10/12 — a null `memberId` implies `invoiceSubject==='event'`
        // (membership invoices always carry member_id per
        // `invoices_subject_fields_ck`), and the up-front LOW-12 guard already
        // rejected any event invoice with a null `eventRegistrationId` — so
        // `eventRegistrationId` (bound from that guard) is non-null here. TS
        // cannot re-derive that at this site (it only knows `memberId === null`),
        // so we re-assert it explicitly. This replaces the former silent
        // `?? ''` fallback: if the up-front guard is ever removed, this throws
        // (rolling back the tx via withTx) instead of persisting an empty
        // string into the audit payload's string-typed `event_registration_id`.
        if (eventRegistrationId === null) {
          throw new IssueCreditNoteInternalError({ code: 'invalid_event_invoice' });
        }
        // NON-MEMBER event invoice. The typed `emitNonMemberInvoiceEvent` helper
        // (audit-port.ts) REQUIRES `event_registration_id` and FORBIDS `member_id`
        // at compile time — no `as unknown as` cast — so the F3 timeline filter
        // (`payload->>'member_id'`) never surfaces a non-member credit note.
        await emitNonMemberInvoiceEvent(deps.audit, tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'credit_note_issued',
          // Non-null per the re-assert above (narrowed to `string`).
          eventRegistrationId,
          actorUserId: input.actorUserId,
          summary: creditNoteSummary,
          extraPayload: creditNotePayloadBase,
        });
      }

      // L. Outbox (auto-email). The `autoEmailOnIssue` flag name comes
      // from the invoice-issue flow but the per-invoice override
      // applies uniformly to credit-note dispatch; falling back to
      // tenant `autoEmailEnabled` when unset. Recipient is the
      // snapshotted primary contact on the invoice at issue time
      // (SG-5 — fixed citation: the snapshot rule is FR-038, but the
      // email-toggle rule is the tenant `autoEmailEnabled` setting;
      // keeping both here for clarity).
      const shouldAutoEmail = loaded.autoEmailOnIssue ?? settings.autoEmailEnabled;
      // 054-event-fee-invoices (Task 8) — a NON-member event buyer snapshot may
      // carry an EMPTY `primary_contact_email` (`makeMemberIdentitySnapshot`
      // accepts ''); membership/matched-member snapshots always have a real
      // contact email. Guard the enqueue on a non-empty recipient so we never
      // queue an outbox row addressed to '' (the Resend adapter would reject it
      // downstream + the row would dead-letter). Skip + a no-PII pino.warn
      // (ids only) when there is no contact email to send to.
      const creditNoteRecipient = loaded.memberIdentitySnapshot.primary_contact_email;
      // MEDIUM-5 — capture the delivery outcome so the route/UI can give the
      // admin a non-blocking signal (notice on `skipped_no_recipient`, silent
      // on `sent`/`not_requested`). Defaults to `not_requested`; flips to
      // `sent` on enqueue, `skipped_no_recipient` on the empty-email skip.
      let emailDelivery: CreditNoteEmailDelivery = 'not_requested';
      if (shouldAutoEmail && creditNoteRecipient.trim() !== '') {
        await deps.outbox.enqueue(tx, {
          tenantId: input.tenantId,
          eventType: 'credit_note_issued',
          recipientEmail: creditNoteRecipient,
          creditNoteId,
          pdfBlobKey: blobKey,
          pdfTemplateVersion: deps.currentTemplateVersion,
        });
        emailDelivery = 'sent';
      } else if (shouldAutoEmail) {
        emailDelivery = 'skipped_no_recipient';
        logger.warn(
          {
            tenantId: input.tenantId,
            invoiceId,
            creditNoteId,
            invoiceSubject: loaded.invoiceSubject,
          },
          'issueCreditNote: auto-email enabled but buyer snapshot has no contact email — skipping credit-note email',
        );
      }

      return ok({ creditNote: cn, emailDelivery });
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
            summary: `PDF render failed for ${pendingRenderKind ?? 'unknown'} on invoice ${input.invoiceId}`,
            payload: {
              invoice_id: input.invoiceId,
              // R2 review — fallback must NOT be 'credit_note' (educated
              // guess). If `pdf_render_failed` fires before either
              // render site ran (future code path), the audit should
              // say 'unknown' not lie about the site. Ops can then
              // investigate the unusual path.
              render_kind: pendingRenderKind ?? 'unknown',
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
