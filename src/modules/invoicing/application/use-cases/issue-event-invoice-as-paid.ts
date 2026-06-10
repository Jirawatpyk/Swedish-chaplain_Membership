/**
 * 064 — issue-event-invoice-as-paid use case.
 *
 * One-shot `draft → paid` issuance for EVENT invoices whose payment already
 * happened out-of-band (door cash, confirmed bank transfer): allocate the §87
 * invoice-stream number, render ONE combined ใบกำกับภาษี/ใบเสร็จรับเงิน
 * (`receipt_combined`) PDF, and persist the paid row via the single-UPDATE
 * `applyIssueAsPaid` repo seam — all inside one transaction. There is NO
 * intermediate `issued` state and NO second receipt render: the combined
 * document IS the receipt (§86/4 + §105ทวิ in one issuance event), which is
 * what kills the §105 double-receipt failure mode of the legacy
 * issue-then-record-payment flow for event tickets.
 *
 * Doc-kind pin: a TIN buyer ALWAYS receives `receipt_combined` here —
 * the tenant's `receiptNumberingMode='separate'` setting is deliberately
 * overridden (that mode governs the two-step pay flow where a standalone
 * receipt document exists; as-paid has exactly one document).
 *
 * No-TIN buyers receive the §105 ใบเสร็จรับเงิน (`receipt_separate`) numbered
 * from the RECEIPT stream (accountant ruling β, live since Task 10 +
 * migration 0212): `documentType:'receipt'` allocation with the tenant's
 * receipt prefix (`'RE'` fallback — recordPayment separate-mode parity), the
 * number lands in `receipt_document_number_raw` and the invoice-stream pair
 * stays NULL, so the shared §87 invoice stream is never burned for a receipt
 * document.
 *
 * Canonical lock order (mirrors issueInvoice — R7-S1 deadlock rationale at
 * issue-invoice.ts:14 applies verbatim):
 *   1. invoice row FOR UPDATE (lockForUpdate)
 *   2. member FOR UPDATE (archive-race guard FR-037; skipped for non-member
 *      buyers — snapshot pinned at draft)
 *   3. §87 advisory lock + sequence row FOR UPDATE (inside allocateNext)
 *
 * Known benign AB-BA edge (β arm + matched no-TIN member — T10 reliability
 * review Minor #2): step 2→3 here means the member row lock is held BEFORE
 * advisory('receipt'), while recordPayment separate-mode takes
 * advisory('receipt') first and only later updates the SAME member row
 * (markRegistrationFeePaid). A concurrent β as-paid + recordPayment on the
 * same member in the same (tenant, fy) can therefore hit 40P01 — Postgres'
 * deadlock detector resolves it in ~1s with a FULL rollback on the losing
 * side (no §87 gap, rows stay draft/issued), surfacing as a 500. Accepted:
 * do NOT reorder locks here without auditing every sibling §87 caller;
 * route-level retry guidance belongs to the route task.
 *
 * Zone discipline (mirrors issueInvoice):
 *   - PRE-SEQUENCE failures `return err(...)` — the tx has no §87 state yet.
 *   - POST-SEQUENCE failures `throw IssueAsPaidInternalError` so withTx rolls
 *     back and the allocator increment is NOT committed (no §87 gap).
 *
 * Dates: `issue_date = due_date = payment_date` (the document is settled the
 * moment it exists) and the FISCAL YEAR derives from the PAYMENT date in
 * Bangkok wall-clock — NOT from now() — so a January back-dated entry for a
 * December payment numbers into the December fiscal year.
 *
 * RBAC: admin only (route handler guard). Audits: `invoice_issued` AND
 * `invoice_paid` both emitted in-tx (the two lifecycle facts happen in one
 * commit). F8 on-paid callbacks fire for matched members exactly as
 * recordPayment's (same `F4InvoicePaidEvent` shape, `triggeredBy:
 * 'admin_manual'`), inside the same tx.
 */
import { err, ok, type Result } from '@/lib/result';
import { asSatang } from '@/lib/money';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { TenantSettingsRepo } from '../ports/tenant-settings-repo';
import type { MemberIdentityPort } from '../ports/member-identity-port';
import type { SequenceAllocatorPort } from '../ports/sequence-allocator-port';
import type { PdfRenderPort } from '../ports/pdf-render-port';
import type { BlobStoragePort } from '../ports/blob-storage-port';
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
import type { ClockPort } from '../ports/clock-port';
import type { EmailOutboxPort } from '../ports/email-outbox-port';
import {
  asInvoiceId,
  canTransition,
  enforceOneSubjectLine,
  type Invoice,
  type InvoiceId,
  type InvoiceStatus,
} from '@/modules/invoicing/domain/invoice';
import type { F4InvoicePaidEvent } from '@/modules/invoicing/domain/f4-invoice-paid-event';
import { Money } from '@/modules/invoicing/domain/value-objects/money';
import { DocumentNumber } from '@/modules/invoicing/domain/value-objects/document-number';
import type { FiscalYear } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { fiscalYearFromUtcIso } from '@/modules/invoicing/domain/value-objects/fiscal-year';
import { splitVatInclusive } from '@/modules/invoicing/domain/value-objects/vat-inclusive';
import { buyerHasTin } from '@/modules/invoicing/domain/document-kind';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { bangkokLocalDate, isValidCalendarDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { resolveInvoiceBuyerForIssue } from '../lib/resolve-invoice-buyer';

export const issueEventInvoiceAsPaidSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  invoiceId: z.string().uuid(),
  // Shape regex first, then real-calendar refine — the regex alone accepts
  // impossible dates (2026-02-31) that js-joda would later throw RAW on → 500.
  paymentDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isValidCalendarDate, { message: 'not a real calendar date' }),
  paymentMethod: z.enum(['bank_transfer', 'cheque', 'cash', 'other']),
  paymentReference: z.string().max(200).nullable().optional(),
  paymentNotes: z.string().max(2000).nullable().optional(),
});

export type IssueEventInvoiceAsPaidInput = z.infer<typeof issueEventInvoiceAsPaidSchema>;

export type IssueEventInvoiceAsPaidError =
  | { code: 'invoice_not_found' }
  | { code: 'not_event_subject' }
  | { code: 'invoice_already_issued'; status: InvoiceStatus }
  | { code: 'settings_missing' }
  | { code: 'member_not_found' }
  | { code: 'member_archived' }
  | { code: 'no_buyer_snapshot' }
  | { code: 'payment_date_future' }
  | { code: 'invalid_lines'; reason: string }
  | { code: 'overflow'; fiscalYear: FiscalYear }
  | { code: 'pdf_render_failed'; reason: string }
  | { code: 'blob_upload_failed'; reason: string };

/**
 * Internal throw-carrier: aborts the transaction AND propagates a typed error
 * to the outer `try/catch`. Required for every error AFTER
 * `sequenceAllocator.allocateNext` — returning `err(...)` from the withTx
 * callback would COMMIT the sequence increment and leave a §87 gap. See
 * `lib/tx-abort.ts` for the shared pattern.
 */
class IssueAsPaidInternalError extends TxAbort<IssueEventInvoiceAsPaidError> {
  // Hardcode the class name so production minifiers can't mangle it in
  // logger output (L3 parity with the sibling use-cases).
  override readonly name = 'IssueAsPaidInternalError';
}

export interface IssueEventInvoiceAsPaidDeps {
  readonly invoiceRepo: InvoiceRepo;
  readonly tenantSettingsRepo: TenantSettingsRepo;
  readonly memberIdentity: MemberIdentityPort;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  /** PDF template version pinned on THIS issuance (T045 registry). */
  readonly currentTemplateVersion: number;
  /**
   * F8 cross-module on-paid hooks — SAME contract as
   * `RecordPaymentDeps.onPaidCallbacks` (fired in registration order inside
   * the still-open withTx, after apply + audits + outbox; a rejection rolls
   * back the entire as-paid issuance). Matched members only — a non-member
   * buyer has no renewal cycle to correlate.
   */
  readonly onPaidCallbacks?: ReadonlyArray<
    (evt: F4InvoicePaidEvent, tx?: unknown) => Promise<void>
  >;
}

export async function issueEventInvoiceAsPaid(
  deps: IssueEventInvoiceAsPaidDeps,
  input: IssueEventInvoiceAsPaidInput,
): Promise<Result<Invoice, IssueEventInvoiceAsPaidError>> {
  const invoiceId: InvoiceId = asInvoiceId(input.invoiceId);

  // Issuance-latency histogram (T113 parity) — a successful as-paid issuance
  // consumes a §87 number exactly like a plain issue, so it records into the
  // SAME SLO signal at the happy-path tail.
  const issueStartedAt = performance.now();

  // 1. paymentDate must not be in the future relative to Bangkok wall-clock
  // "today" (lexicographic compare is correct for YYYY-MM-DD). Runs before
  // any I/O — a future-dated payment is a caller mistake, not a race.
  const bangkokToday = bangkokLocalDate(deps.clock.nowIso());
  if (input.paymentDate > bangkokToday) {
    return err({ code: 'payment_date_future' });
  }

  // 2. Settings — read BEFORE withTx (R17-03 parity with recordPayment /
  // issueCreditNote / voidInvoice): `getForIssue` opens its own `runInTenant`
  // transaction; nesting that inside the outer withTx can deadlock the pool
  // when two concurrent as-paid calls each hold one connection and wait for a
  // second. Settings are effectively immutable during issuance, so the
  // outside read is safe.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  if (!settings) return err({ code: 'settings_missing' });

  // Hoisted for the outer catch: once set, ANY tx-rejecting failure — typed
  // render/upload errors AND raw rethrows (audit.emit, outbox.enqueue, F8
  // callbacks, repo reload) — may have left bytes at the deterministic key
  // that outlive the rollback (orphan-blob mitigation, reliability L-1 +
  // review Important #1).
  let blobKeyForCleanup: string | null = null;
  // Hoisted for the post-rollback pdf_render_failed forensic audit: the
  // failed render is `receipt_combined` on the TIN arm but `receipt_separate`
  // on the no-TIN β arm — the forensic row must not lie about which document
  // failed. Always set before any render can run.
  let pdfKindForForensics: 'receipt_combined' | 'receipt_separate' | null = null;

  try {
    return await deps.invoiceRepo.withTx(async (tx) => {
      // --- PRE-SEQUENCE early exits (safe to `return err(...)` — no §87
      // state exists yet; a committed callback with zero writes is a no-op).
      // DO NOT move any of these below allocateNext without converting them
      // to the throw-carrier — committing a partial tx that consumed a
      // sequence number creates a §87 gap.

      // C1. Row-lock the invoice BEFORE reading the draft — serialises
      // concurrent issue/as-paid attempts on the same invoice id (lock order
      // step 1; the applyIssueAsPaid CALLER CONTRACT requires this to be
      // held before allocateNext).
      const lockedStatus = await deps.invoiceRepo.lockForUpdate(tx, invoiceId, input.tenantId);
      if (!lockedStatus) {
        // R7-W1 parity — probe on not-found (an RLS-hidden row is
        // indistinguishable from a truly-missing id; audit either way per
        // Constitution Principle I clause 4). NULL tx so the audit survives
        // the outer withTx's rollback.
        await deps.audit.emit(null, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_cross_tenant_probe',
          actorUserId: input.actorUserId,
          summary: `Probe on invoice ${invoiceId} (not found on issue-as-paid)`,
          payload: {
            attempted_invoice_id: invoiceId,
            actor_role: 'admin',
            route: 'issue-event-invoice-as-paid',
          },
        });
        return err({ code: 'invoice_not_found' });
      }
      if (lockedStatus !== 'draft') {
        return err({ code: 'invoice_already_issued', status: lockedStatus });
      }

      // C2. Draft load (now safely inside the row lock — per the
      // applyIssueAsPaid CALLER CONTRACT, money/snapshots MUST come from
      // this post-lock read).
      const draft = await deps.invoiceRepo.findByIdInTx(tx, invoiceId, input.tenantId);
      if (!draft) return err({ code: 'invoice_not_found' });

      if (draft.invoiceSubject !== 'event') {
        return err({ code: 'not_event_subject' });
      }

      // Domain transition-table sanity: `draft → paid` is legal ONLY for the
      // event subject (064 Task 1). A failure here means the domain table
      // was edited out from under this use case — a programming error, so
      // CRASH loudly (plain throw, not the TxAbort carrier: nothing is
      // allocated yet, and a typed err would let a broken table ship).
      const transition = canTransition('draft', 'paid', 'event');
      if (!transition.ok) {
        throw new Error(
          `issueEventInvoiceAsPaid: domain transition table rejected draft->paid for event (${transition.error.code}) — programming error`,
        );
      }

      // Domain invariant — exactly one event_fee line before issue. Runs
      // BEFORE allocateNext so a malformed draft cannot consume a §87 number.
      const linesCheck = enforceOneSubjectLine('event', draft.lines);
      if (!linesCheck.ok) {
        return err({ code: 'invalid_lines', reason: linesCheck.error.code });
      }

      // B. Buyer resolution — shared helper (lock order step 2: matched
      // member takes a FOR UPDATE re-read, FR-037 archive-race guard;
      // non-member uses the draft-pinned snapshot). Err codes map 1:1.
      const memberId = draft.memberId;
      const buyerResolution = await resolveInvoiceBuyerForIssue(
        deps.memberIdentity,
        tx,
        input.tenantId,
        draft,
      );
      if (!buyerResolution.ok) return err(buyerResolution.error);
      const memberSnap: MemberIdentitySnapshot = buyerResolution.value;

      // §86/4 + §105 doc-kind pin — as-paid renders the COMBINED
      // tax-invoice/receipt for TIN buyers REGARDLESS of the tenant's
      // receiptNumberingMode (see header). No-TIN buyers get the §105
      // receipt_separate arm numbered from the RECEIPT stream (β, Task 10).
      const pdfKind = buyerHasTin(memberSnap.tax_id)
        ? ('receipt_combined' as const)
        : ('receipt_separate' as const);
      pdfKindForForensics = pdfKind;

      // Event Model-B invariant: as-paid event pricing is VAT-INCLUSIVE by
      // construction (the ticket price is all-in). A false here is a corrupt
      // row that slipped the draft-time guards — crash, don't issue a tax
      // document off broken money semantics.
      if (!draft.vatInclusive) {
        throw new Error(
          'issueEventInvoiceAsPaid: event draft has vatInclusive=false (Model-B invariant violated) — refusing to issue',
        );
      }

      // F. Pricing — the single event_fee line carries the all-in price, so
      // the line sum IS the total; back-calculate subtotal + VAT exactly
      // (subtotal+vat===total by construction — see issueInvoice F block).
      let lineSum = Money.zero();
      for (const line of draft.lines) {
        lineSum = lineSum.add(line.total);
      }
      const total = lineSum;
      const { subtotal, vat } = splitVatInclusive(total, settings.vatRate.numerator);

      // D. Fiscal year — from the PAYMENT date, not now(). `T05:00:00Z` is
      // 12:00 Bangkok on the same calendar day (Bangkok has no DST), so the
      // derived FY is exactly the fiscal year containing input.paymentDate
      // in Bangkok wall-clock, immune to UTC-vs-Bangkok date skew.
      const fy = fiscalYearFromUtcIso(
        `${input.paymentDate}T05:00:00Z`,
        settings.fiscalYearStartMonth as 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12,
      );

      // --- POST-SEQUENCE ZONE. Every error path below MUST throw
      // IssueAsPaidInternalError so withTx rolls back the allocator increment.

      // E. Numbering — stream depends on the §86/4 doc-kind:
      //   TIN    → the SHARED §87 invoice stream (events + membership
      //            intentionally share `documentType:'invoice'` — see
      //            issueInvoice E) with the invoice prefix.
      //   no-TIN → the RECEIPT stream (`documentType:'receipt'`) with the
      //            tenant receipt prefix, `'RE'` fallback — EXACT parity with
      //            recordPayment's separate-mode allocation so a β receipt
      //            number is indistinguishable from a payment-time receipt
      //            number. The invoice-stream pair stays NULL on the row
      //            (migration 0212 relaxed leg) so a receipt number can never
      //            collide inside invoices_tenant_fiscal_seq_unique.
      // `docNum` is the document's PRINTED number either way — threaded into
      // the PDF render and both audit summaries below.
      let numbering:
        | { kind: 'invoice_stream'; sequenceNumber: number; documentNumber: string }
        | { kind: 'receipt_stream'; receiptDocumentNumberRaw: string };
      let docNum: DocumentNumber;
      if (pdfKind === 'receipt_combined') {
        const seq = await deps.sequenceAllocator.allocateNext(tx, {
          tenantId: input.tenantId,
          documentType: 'invoice',
          fiscalYear: fy,
        });
        const invoiceDoc = DocumentNumber.of(settings.invoiceNumberPrefix, fy, seq);
        if (!invoiceDoc.ok) {
          throw new IssueAsPaidInternalError({ code: 'overflow', fiscalYear: fy });
        }
        numbering = {
          kind: 'invoice_stream',
          sequenceNumber: seq,
          documentNumber: invoiceDoc.value.raw,
        };
        docNum = invoiceDoc.value;
      } else {
        const receiptSeq = await deps.sequenceAllocator.allocateNext(tx, {
          tenantId: input.tenantId,
          documentType: 'receipt',
          fiscalYear: fy,
        });
        const receiptDoc = DocumentNumber.of(
          settings.receiptNumberPrefix ?? 'RE',
          fy,
          receiptSeq,
        );
        if (!receiptDoc.ok) {
          // Throw so the tx rolls back and the receipt-sequence increment is
          // NOT consumed by a failed number assignment (recordPayment parity).
          throw new IssueAsPaidInternalError({ code: 'overflow', fiscalYear: fy });
        }
        numbering = {
          kind: 'receipt_stream',
          receiptDocumentNumberRaw: receiptDoc.value.raw,
        };
        docNum = receiptDoc.value;
      }

      // G+H+I. Snapshots + render + upload the ONE combined PDF.
      const tenantSnap = settings.identity;
      const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
      blobKeyForCleanup = blobKey;
      const tenantLogo = await loadTenantLogo(
        deps.blob,
        tenantSnap.logo_blob_key,
        deps.currentTemplateVersion,
      );
      const rendered = await renderAndUploadPdf(
        { pdfRender: deps.pdfRender, blob: deps.blob },
        {
          renderInput: {
            kind: pdfKind,
            templateVersion: deps.currentTemplateVersion,
            // TIN arm: the invoice-stream number; no-TIN β arm: the RECEIPT
            // number — the printed number on the §105 ใบเสร็จรับเงิน.
            documentNumber: docNum,
            // As-paid date pin: the document is settled the moment it exists.
            issueDate: input.paymentDate,
            dueDate: input.paymentDate,
            tenant: tenantSnap,
            tenantLogo,
            member: memberSnap,
            lines: draft.lines,
            subtotal,
            vatRate: settings.vatRate,
            vat,
            total,
            vatInclusive: true,
          },
          blobKey,
        },
        (code, reason) => new IssueAsPaidInternalError({ code, reason }),
      );

      // J. Single UPDATE draft→paid.
      let paid: Invoice;
      try {
        paid = await deps.invoiceRepo.applyIssueAsPaid(tx, {
          tenantId: input.tenantId,
          invoiceId,
          fiscalYear: fy,
          numbering,
          issueDate: input.paymentDate,
          subtotalSatang: asSatang(subtotal.satang),
          vatRate: settings.vatRate.raw,
          vatSatang: asSatang(vat.satang),
          totalSatang: asSatang(total.satang),
          tenantIdentitySnapshot: tenantSnap,
          memberIdentitySnapshot: memberSnap,
          pdf: {
            blobKey,
            sha256: rendered.sha256,
            templateVersion: deps.currentTemplateVersion,
          },
          pdfDocKind: pdfKind,
          paymentMethod: input.paymentMethod,
          paymentReference: input.paymentReference ?? null,
          paymentNotes: input.paymentNotes ?? null,
          paymentRecordedByUserId: input.actorUserId,
          paymentDate: input.paymentDate,
        });
      } catch (e) {
        if (e instanceof InvoiceApplyConflictError && e.kind === 'applyIssueAsPaid') {
          // Race loser: the row was 'draft' under our lock but isn't anymore.
          // MUST throw (not `return err`) — the §87 allocation above has to
          // roll back with the tx, or the loser commits a sequence gap.
          throw new IssueAsPaidInternalError({
            code: 'invoice_already_issued',
            status: 'issued',
          });
        }
        throw e;
      }

      // K. Audits — BOTH lifecycle facts (`invoice_issued` + `invoice_paid`)
      // happened in this one commit, so both rows emit in-tx, in order.
      // Payload parity: issued mirrors issueInvoice's issued payload; paid
      // mirrors recordPayment's paid payload (incl. the W9 reference-sha256
      // rule — the free-form payment reference is PII-class, never logged
      // raw). Both carry invoice_subject + event_registration_id.
      const paymentReferenceSha256 = input.paymentReference
        ? sha256Hex(input.paymentReference)
        : null;
      const issuedSummary = `Invoice ${docNum.raw} issued`;
      const paidSummary = `Invoice ${docNum.raw} marked paid`;
      const issuedPayloadBase: Record<string, unknown> = {
        invoice_id: invoiceId,
        fiscal_year: fy,
        // Receipt-stream (β no-TIN) rows genuinely carry NO invoice-stream
        // pair — null here, never a number fabricated from the receipt
        // stream; the RC number is added under its own key below.
        sequence_number:
          numbering.kind === 'invoice_stream' ? numbering.sequenceNumber : null,
        document_number:
          numbering.kind === 'invoice_stream' ? numbering.documentNumber : null,
        ...(numbering.kind === 'receipt_stream'
          ? { receipt_document_number: numbering.receiptDocumentNumberRaw }
          : {}),
        total_satang: total.satang.toString(),
        pdf_sha256: rendered.sha256,
        invoice_subject: 'event',
      };
      const paidPayloadBase: Record<string, unknown> = {
        invoice_id: invoiceId,
        payment_method: input.paymentMethod,
        payment_reference_sha256: paymentReferenceSha256,
        payment_date: input.paymentDate,
        recorded_by_user_id: input.actorUserId,
        // Combined mode: the receipt number IS the invoice document number;
        // β separate mode: the receipt-stream RC number.
        receipt_document_number: docNum.raw,
        receipt_pdf_sha256: rendered.sha256,
        // The as-paid PDF rendered synchronously above — never async here.
        receipt_pdf_async: false,
        invoice_subject: 'event',
      };
      if (memberId !== null) {
        // Matched member → F3 timeline branch (payload->>'member_id').
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_issued',
          actorUserId: input.actorUserId,
          summary: issuedSummary,
          payload: {
            member_id: memberId,
            event_registration_id: draft.eventRegistrationId,
            ...issuedPayloadBase,
          },
        });
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_paid',
          actorUserId: input.actorUserId,
          summary: paidSummary,
          payload: {
            member_id: memberId,
            event_registration_id: draft.eventRegistrationId,
            ...paidPayloadBase,
          },
        });
      } else {
        // Non-member buyer → typed non-timeline helper (member_id FORBIDDEN
        // at compile time; correlated via event_registration_id instead).
        await emitNonMemberInvoiceEvent(deps.audit, tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_issued',
          eventRegistrationId: draft.eventRegistrationId,
          actorUserId: input.actorUserId,
          summary: issuedSummary,
          extraPayload: {
            event_id: draft.eventId,
            ...issuedPayloadBase,
          },
        });
        await emitNonMemberInvoiceEvent(deps.audit, tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'invoice_paid',
          eventRegistrationId: draft.eventRegistrationId,
          actorUserId: input.actorUserId,
          summary: paidSummary,
          extraPayload: paidPayloadBase,
        });
      }

      // L. Outbox — ONE `invoice_paid` receipt email, mirroring recordPayment
      // (tenant `autoEmailEnabled` gate; the as-paid path has no F5-style
      // suppress flag). The attached/linked PDF is the MAIN blob — the
      // combined document IS the receipt. Best-effort applies ONLY to the
      // empty-recipient SKIP below (a skip leaves the issuance fully valid —
      // admins can resend from the detail page); an `enqueue` THROW hard-fails
      // the whole issuance via tx rollback (recordPayment parity: the receipt
      // email row and the paid row commit atomically or not at all).
      //
      // Empty-recipient guard (issueInvoice Task-14 A): a non-member buyer
      // snapshot may carry '' — trim + skip + warn (ids only, NO email/PII)
      // + metric so ops can alert on the otherwise-silent skip.
      const recipientEmail = (memberSnap.primary_contact_email ?? '').trim();
      if (settings.autoEmailEnabled) {
        if (recipientEmail === '') {
          invoicingMetrics.autoEmailSkipped('event', 'no_recipient');
          logger.warn(
            {
              event: 'invoice_auto_email_skipped_no_recipient',
              tenantId: input.tenantId,
              invoiceId,
              invoiceSubject: 'event',
            },
            'issueEventInvoiceAsPaid: receipt auto-email skipped — buyer has no contact email',
          );
        } else {
          // Non-member event buyer → §87/3 PDPA transparency footer
          // (recordPayment/issueInvoice Task-14 B parity).
          const privacyFooterKind =
            memberId === null ? ('event_non_member' as const) : undefined;
          await deps.outbox.enqueue(tx, {
            tenantId: input.tenantId,
            eventType: 'invoice_paid',
            recipientEmail,
            invoiceId,
            pdfBlobKey: blobKey,
            pdfTemplateVersion: deps.currentTemplateVersion,
            ...(privacyFooterKind ? { privacyFooterKind } : {}),
          });
        }
      }

      // M. F8 on-paid callbacks — matched members only (the cross-module
      // contract keys on a non-null memberId; a non-member ticket has no
      // renewal cycle). Fired inside the still-open tx so a listener
      // rejection rolls back the entire as-paid issuance (atomic, mirrors
      // recordPayment T008). Trigger is the F4 admin-manual constant — this
      // path IS an admin recording an out-of-band payment.
      const callbacks = deps.onPaidCallbacks;
      if (callbacks && callbacks.length > 0 && memberId !== null) {
        const evt: F4InvoicePaidEvent = {
          tenantId: input.tenantId,
          invoiceId,
          memberId,
          paidAt: paid.paidAt ?? deps.clock.nowIso(),
          amountSatang: asSatang(total.satang),
          vatSatang: asSatang(vat.satang),
          currency: draft.currency,
          paymentMethod: input.paymentMethod,
          triggeredBy: 'admin_manual',
        };
        for (const cb of callbacks) {
          await cb(evt, tx);
        }
      }

      // T113 parity — count + duration fire together at the happy-path tail
      // (rolled-back attempts never record; they produced no §87 number).
      invoicingMetrics.issueCount();
      invoicingMetrics.issueDurationMs(performance.now() - issueStartedAt);
      return ok(paid);
    });
  } catch (e) {
    // Orphan-blob mitigation (reliability L-1 + review Important #1): ANY
    // failure after the upload rejected the tx, so the bytes at the
    // deterministic key outlive the rollback while OUR row stays draft (we
    // held its lock until rollback — no committed row can reference the
    // key). Worse, on retry the blob adapter treats "already exists" as
    // success returning the OLD bytes while the row commits the NEW sha256
    // — silent tax-document drift. So clean up on every caught error EXCEPT
    // the `invoice_already_issued` conflict translation: the race WINNER may
    // legitimately own that key. Best-effort delete (awaited, failure logged,
    // never masks the original error).
    const orphanBlobKey = blobKeyForCleanup;
    const isConflictTranslation =
      e instanceof IssueAsPaidInternalError && e.error.code === 'invoice_already_issued';
    if (orphanBlobKey !== null && !isConflictTranslation) {
      await deps.blob.delete(orphanBlobKey).catch((delErr: unknown) => {
        logger.warn(
          { err: delErr, invoiceId: input.invoiceId, blobKey: orphanBlobKey },
          'issue-as-paid: orphan blob cleanup failed',
        );
      });
    }
    if (e instanceof IssueAsPaidInternalError) {
      logger.warn(
        {
          err: e.error,
          invoiceId: input.invoiceId,
          tenantId: input.tenantId,
        },
        'issueEventInvoiceAsPaid: internal error, rolling back',
      );
      // T122 parity — post-rollback forensic audit for render failures (the
      // in-tx audit would have rolled back with the mutation). Fire-and-
      // forget: never mask the original error with an audit-write failure.
      if (e.error.code === 'pdf_render_failed') {
        try {
          await deps.audit.emit(null, {
            tenantId: input.tenantId,
            requestId: input.requestId ?? null,
            eventType: 'pdf_render_failed',
            actorUserId: input.actorUserId,
            summary: `PDF render failed for invoice ${input.invoiceId}`,
            payload: {
              invoice_id: input.invoiceId,
              // As-paid renders exactly one document; the kind was resolved
              // from the buyer snapshot before any render could run (TIN →
              // receipt_combined, no-TIN β → receipt_separate). The fallback
              // is defensive only — a render failure implies the kind was set.
              render_kind: pdfKindForForensics ?? 'receipt_combined',
              reason: e.error.reason,
            },
          });
        } catch (auditErr) {
          logger.warn(
            { err: auditErr, invoiceId: input.invoiceId },
            'issueEventInvoiceAsPaid: pdf_render_failed audit emit also failed',
          );
        }
      }
      return err(e.error);
    }
    throw e;
  }
}
