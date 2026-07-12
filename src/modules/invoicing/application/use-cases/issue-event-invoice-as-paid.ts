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
 * from the SEPARATE `receipt_105`/`RE` register (088 US7/T050; live since
 * migration 0230 added the `receipt_105` document_type): `documentType:
 * 'receipt_105'` allocation with a HARDCODED `'RE'` prefix (NOT
 * settings.receiptNumberPrefix — see the E. Numbering block). The number lands
 * in `receipt_document_number_raw` and the invoice-stream pair stays NULL, so
 * NEITHER the shared §87 invoice stream NOR the §86/4 `RC` receipt stream is
 * ever burned for a §105 receipt — keeping the §86/4/§87 `RC` register pure
 * (un-pollutable) for a clean RD audit. The `RE` register is sequential/tidy
 * but deliberately NOT under the strict §87 no-gaps guarantee (§105 is a
 * non-tax receipt, not §86/4).
 *
 * Canonical lock order (mirrors issueInvoice — R7-S1 deadlock rationale at
 * issue-invoice.ts:14 applies verbatim):
 *   1. invoice row FOR UPDATE (findByIdInTxForUpdate — locked read + draft
 *      load in one round-trip, wave-4 S28)
 *   2. member FOR UPDATE (archive-race guard FR-037; skipped for non-member
 *      buyers — snapshot pinned at draft)
 *   3. §87 advisory lock + sequence row FOR UPDATE (inside allocateNext)
 *
 * Lock-order parity (wave-3 S12 — resolves the former "benign AB-BA edge"
 * from the T10 reliability review): recordPayment's separate-mode path now
 * acquires the SAME pair in the SAME order — its markRegistrationFeePaid
 * member-row UPDATE is hoisted ABOVE its advisory('receipt') allocation —
 * so the member↔advisory 40P01 window between a β as-paid and a concurrent
 * recordPayment on the same member is structurally gone. Any NEW §87
 * caller that touches a member row must keep this member→advisory order.
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
import type { EventRegistrationLookupPort } from '../ports/event-registration-lookup-port';
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
import type { TaxAtPaymentFlag } from '@/modules/invoicing/domain/tax-at-payment-flag';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import { addDays, bangkokLocalDate, isValidCalendarDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { sha256Hex } from '@/lib/crypto';
import { TxAbort } from '../lib/tx-abort';
import { InvoiceApplyConflictError } from '../lib/invoice-apply-conflict-error';
import { renderAndUploadPdf } from '../lib/render-and-upload';
import { loadTenantLogo } from '../lib/load-tenant-logo';
import { resolveInvoiceBuyerForIssue } from '../lib/resolve-invoice-buyer';
import { enqueueInvoiceAutoEmail } from '../lib/enqueue-invoice-email';
import type { EmailDispatchOutcome } from '../email-dispatch-outcome';

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
  /**
   * Wave-3 S10 — paymentDate is more than 365 days before Bangkok today.
   * Almost always a typo'd YEAR (e.g. 2025-06-10 entered for 2026-06-10):
   * a wrong-year document numbers into the WRONG fiscal year's §87 stream
   * and mis-periods the output VAT. Legitimate closed-period backdates
   * WITHIN the year stay allowed — the non-blocking ภ.พ.30 warning in the
   * form covers their accounting follow-up.
   */
  | { code: 'payment_date_too_old' }
  /**
   * 064 S1 — the F6 registration was refunded AFTER the draft was created
   * (createEventInvoiceDraft only hard-blocks refunded at DRAFT time).
   * Issuing would assert a fee the buyer already got back — re-checked
   * in-tx at issuance, PRE-allocation (no §87 burn).
   */
  | { code: 'registration_refunded' }
  /**
   * 064 S1 — the issuance-time registration re-read failed (port err) or
   * returned null (row vanished / RLS anomaly). Refuse to issue a tax
   * document against a registration we can no longer verify.
   */
  | { code: 'registration_lookup_failed' }
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
  /**
   * 064 S1 — issuance-time refunded re-check (TOCTOU vs the draft-time
   * check in createEventInvoiceDraft). REQUIRED: an optional safety dep
   * could silently not run (the soft-deleted-plan-hole class).
   */
  readonly eventRegistrationLookup: EventRegistrationLookupPort;
  readonly sequenceAllocator: SequenceAllocatorPort;
  readonly pdfRender: PdfRenderPort;
  readonly blob: BlobStoragePort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly outbox: EmailOutboxPort;
  /** PDF template version pinned on THIS issuance (T045 registry). */
  readonly currentTemplateVersion: number;
  /**
   * 088-invoice-tax-flow-redesign (T019 / T022) — FEATURE_088_TAX_AT_PAYMENT
   * (2-state flow flag). When `'on'`, a TIN buyer's combined §86/4 receipt is
   * minted from the §87 `RC` receipt stream (mirroring `record-payment`) and a
   * `tax_receipt_issued` audit event fires; when `'off'` the legacy path
   * allocates the §87 `invoice`-stream number as today. The no-TIN §105 arm is
   * unchanged.
   */
  readonly taxAtPayment: TaxAtPaymentFlag;
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

/**
 * Cluster 5 (Finding 1 — event follow-up) — the paid event invoice PLUS an
 * observable auto-email dispatch outcome, mirroring `IssueInvoiceSuccess` /
 * `RecordPaymentSuccess`. `Invoice & { emailDispatch }` (an intersection, not a
 * wrapper object) so every existing consumer that reads the value structurally
 * as an `Invoice` (the route's `serialiseInvoice`, tests) keeps working; only
 * callers that WANT the dispatch signal read the extra field. Makes the
 * otherwise-silent "buyer has no contact email → receipt not emailed" skip
 * visible so the admin toast can warn the operator to deliver it manually.
 */
export type IssueEventInvoiceAsPaidSuccess = Invoice & {
  readonly emailDispatch: EmailDispatchOutcome;
};

export async function issueEventInvoiceAsPaid(
  deps: IssueEventInvoiceAsPaidDeps,
  input: IssueEventInvoiceAsPaidInput,
): Promise<Result<IssueEventInvoiceAsPaidSuccess, IssueEventInvoiceAsPaidError>> {
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

  // 1b. …and not absurdly far in the PAST either (wave-3 S10 typo-year
  // guard): >365 days back is almost always a mistyped year, and a
  // wrong-year document numbers into the WRONG fiscal year's §87 stream.
  // The bound lives HERE (next to the future bound, same deps.clock
  // Bangkok source — the two can never disagree) rather than in the static
  // zod schema, which has no injectable clock; every caller goes through
  // this use case, so all of them inherit it. Exactly-365-days passes
  // (the bound is "OLDER than"); legitimate closed-period backdates within
  // the year get the non-blocking ภ.พ.30 warning in the form instead.
  if (input.paymentDate < addDays(bangkokToday, -365)) {
    return err({ code: 'payment_date_too_old' });
  }

  // 2. Settings — read BEFORE withTx (R17-03 parity with recordPayment /
  // issueCreditNote / voidInvoice): `getForIssue` opens its own `runInTenant`
  // transaction; nesting that inside the outer withTx can deadlock the pool
  // when two concurrent as-paid calls each hold one connection and wait for a
  // second. Settings are effectively immutable during issuance, so the
  // outside read is safe.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  if (!settings) return err({ code: 'settings_missing' });

  // 3. Tenant logo — fetched BEFORE withTx (wave-3 S27): the bytes depend
  // only on the settings read above + the pinned template version, so a
  // slow/unavailable Blob endpoint must not extend the §87 critical section
  // (invoice row lock → member lock → advisory + sequence row). Failure
  // semantics unchanged: the helper swallows fetch errors and returns null
  // (warn + metric inside) — a logo miss never blocks legal-document
  // issuance. issueInvoice keeps its in-tx call because ITS settings read
  // lives inside withTx (see the note at its H+I block).
  const tenantLogo = await loadTenantLogo(
    deps.blob,
    settings.identity.logo_blob_key,
    deps.currentTemplateVersion,
  );

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

      // C. Row-lock + draft load in ONE round-trip (wave-4 S28 — formerly a
      // lockForUpdate status probe followed by a findByIdInTx reload). The
      // SELECT ... FOR UPDATE serialises concurrent issue/as-paid attempts on
      // the same invoice id (lock order step 1; the applyIssueAsPaid CALLER
      // CONTRACT requires this lock to be held before allocateNext) and the
      // money/snapshots below all come from this post-lock read. The combined
      // read also closes the former "lock OK but reload returned null"
      // defensive gap — the locked row cannot vanish mid-tx.
      const draft = await deps.invoiceRepo.findByIdInTxForUpdate(
        tx,
        invoiceId,
        input.tenantId,
      );
      if (!draft) {
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
      if (draft.status !== 'draft') {
        return err({ code: 'invoice_already_issued', status: draft.status });
      }

      if (draft.invoiceSubject !== 'event') {
        return err({ code: 'not_event_subject' });
      }

      // 064 S1 — refunded re-check at ISSUANCE (TOCTOU close). The draft-time
      // check in createEventInvoiceDraft only covers the moment of drafting;
      // a registration refunded between draft and issue would otherwise still
      // get a paid §105/§86-4 document asserting a fee the buyer got back.
      // Runs in-tx (same RLS context, after the row lock) and PRE-allocation,
      // so a refunded reject burns no §87 number. `ok(null)`/port-err are a
      // verification failure — never issue against an unverifiable row.
      const regResult = await deps.eventRegistrationLookup.findById(
        tx,
        input.tenantId,
        draft.eventRegistrationId,
      );
      if (!regResult.ok || regResult.value === null) {
        // 065 M-2 — the single public code collapses TWO failure modes that
        // ops must tell apart: `not_found` (row vanished under RLS — a
        // data-integrity anomaly the F6 adapter logs NOTHING for) vs
        // `port_error` (the adapter already error-logged the underlying
        // failure; this line adds the invoice context it lacks).
        logger.error(
          {
            reason: regResult.ok ? 'not_found' : 'port_error',
            invoiceId: input.invoiceId,
            tenantId: input.tenantId,
            registrationId: draft.eventRegistrationId,
          },
          'issueEventInvoiceAsPaid: registration lookup failed at issuance re-check',
        );
        return err({ code: 'registration_lookup_failed' });
      }
      if (regResult.value.paymentStatus === 'refunded') {
        return err({ code: 'registration_refunded' });
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
      //            issueInvoice E) with the invoice prefix; OR, in the new flow
      //            (`taxAtPayment`), the §87 `RC` receipt stream (see 088 T019
      //            below).
      //   no-TIN → the SEPARATE §105 `receipt_105` register with a HARDCODED
      //            `'RE'` prefix (088 US7/T050 — NOT settings.receiptNumberPrefix,
      //            NOT the §86/4 `receipt`/RC stream). The number lands in
      //            `receipt_document_number_raw` with the invoice-stream pair
      //            NULL on the row (migration 0212 relaxed leg) so it can never
      //            collide inside invoices_tenant_fiscal_seq_unique, and it can
      //            never pollute the §86/4/§87 `RC` register (which stays pure
      //            for a clean RD audit). `receipt_105` is sequential/tidy but
      //            deliberately NOT under the strict §87 no-gaps guarantee.
      // `docNum` is the document's PRINTED number either way — threaded into
      // the PDF render and both audit summaries below. (Wave-4 S22: the two
      // formerly copy-pasted allocate/build/overflow arms are collapsed —
      // only documentType + prefix differ; the overflow throw rolls the tx
      // back so the consumed increment never commits, either stream.)
      // 088 T019 — a TIN buyer's combined §86/4 receipt is minted from the §87
      // `RC` receipt stream in the new flow (`taxAtPayment`), mirroring
      // record-payment so the §86/4 RC register stays contiguous across
      // membership + event-with-TIN payments (SC-002). Legacy allocates the
      // shared §87 `invoice` stream as before. The no-TIN §105 arm always uses
      // its own separate `receipt_105`/`RE` register (US7/T050), independent of
      // both the `taxAtPayment` flag and the tenant's receipt prefix.
      const taxAtPayment = deps.taxAtPayment === 'on';
      const stream =
        pdfKind === 'receipt_combined'
          ? taxAtPayment
            ? // 088 US7 fix — the §86/4 RC-role receipt defaults to 'RC' (NOT the
              // stale pre-088 'RE'). This prefix MUST stay disjoint from the §105
              // register's hardcoded 'RE' below: both write
              // `receipt_document_number_raw` and share the single unpartitioned
              // `invoices_tenant_receipt_raw_uniq` index, and each register is a
              // separate counter (both seq 1 in a fresh FY). An 'RE' default would
              // render the same raw on both → 23505 on the 2nd commit. The tenant
              // settings guard (update-tenant-invoice-settings) reserves 'RE' so a
              // configured prefix can never re-open this collision.
              ({ documentType: 'receipt', prefix: settings.receiptNumberPrefix ?? 'RC' } as const)
            : ({ documentType: 'invoice', prefix: settings.invoiceNumberPrefix } as const)
          : // 088 US7/T050 — the §105 event-no-TIN receipt allocates from the
            // SEPARATE `receipt_105`/`RE` register (spec §272 working default,
            // revisable per accountant, NOT under the §87 no-gaps guarantee).
            // The `RE` prefix is HARDCODED (never settings.receiptNumberPrefix)
            // so a §105 receipt can never number onto the §86/4 `RC` register —
            // even when the tenant has `receiptNumberPrefix='RC'` configured for
            // its §86/4 tax receipts. That split keeps the §86/4/§87 RC register
            // pure (un-pollutable, un-renumberable) for a clean RD audit.
            ({ documentType: 'receipt_105', prefix: 'RE' } as const);
      const seq = await deps.sequenceAllocator.allocateNext(tx, {
        tenantId: input.tenantId,
        documentType: stream.documentType,
        fiscalYear: fy,
      });
      const doc = DocumentNumber.of(stream.prefix, fy, seq);
      if (!doc.ok) {
        throw new IssueAsPaidInternalError({ code: 'overflow', fiscalYear: fy });
      }
      const docNum: DocumentNumber = doc.value;
      const numbering:
        | { kind: 'invoice_stream'; sequenceNumber: number; documentNumber: string }
        | { kind: 'receipt_stream'; receiptDocumentNumberRaw: string } =
        stream.documentType === 'invoice'
          ? { kind: 'invoice_stream', sequenceNumber: seq, documentNumber: docNum.raw }
          : { kind: 'receipt_stream', receiptDocumentNumberRaw: docNum.raw };

      // G+H+I. Snapshots + render + upload the ONE combined PDF.
      const tenantSnap = settings.identity;
      const blobKey = `invoicing/${input.tenantId}/${fy}/${invoiceId}_v${deps.currentTemplateVersion}.pdf`;
      blobKeyForCleanup = blobKey;
      // `tenantLogo` was fetched pre-tx (wave-3 S27) — see step 3 above.
      //
      // 065 H-1a — `allowOverwrite: true` on THIS call site only (root fix
      // for the silent tax-document-drift class): the adapter's default
      // (allowOverwrite=false) treats "already exists" as success and
      // returns the OLD bytes WITHOUT a sha compare — @vercel/blob `head()`
      // exposes no content hash, so the adapter cannot verify the conflict
      // is byte-identical. A failed-then-retried as-paid (the catch-path
      // orphan delete below is best-effort and can itself fail; the key has
      // no paymentDate component, so a retry with a DIFFERENT paymentDate
      // renders different bytes at the SAME key) would then commit a row
      // whose pdf_sha256 doesn't match the stored document. Overwriting is
      // safe here because the invoice row FOR UPDATE lock (step C) is held
      // for the whole render+upload: only one issuance attempt per invoice
      // id can be in this section, and any pre-existing bytes at the key
      // are stale orphans of a rolled-back attempt (no committed row can
      // reference them — a committed row exits at the `status !== 'draft'`
      // guard before any upload). issueInvoice deliberately keeps the
      // default (its retries are same-day deterministic re-renders; its 065
      // L-3 cleanup parity + drift metric cover the residual).
      const rendered = await renderAndUploadPdf(
        { pdfRender: deps.pdfRender, blob: deps.blob },
        {
          allowOverwrite: true,
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
            // 088 US5 (T041 / SC-007) — event as-paid receipt: explicitly 'event'
            // so the tenant WHT note (membership-only) is never drawn here.
            invoiceSubject: 'event',
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
          // S26 — post-lock draft lines, echoed into the returned Invoice
          // (the repo no longer re-selects them).
          lines: draft.lines,
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
          // status 'paid': the as-paid race winner can only have made it paid.
          throw new IssueAsPaidInternalError({
            code: 'invoice_already_issued',
            status: 'paid',
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

      // 088 US1 (F.6) — `tax_receipt_issued`: the §86/4 tax-receipt
      // FIRST-ISSUANCE signal (SC-001), fired IN-TX at the RC-allocation moment
      // for a TIN buyer in the new flow (identical to record-payment; FR-005 /
      // FR-006). The no-TIN §105 arm mints no §86/4 → no event. Carries
      // member_id for a matched member (F3 timeline, FR-029) else
      // event_registration_id. 10y retention via the audit adapter.
      if (taxAtPayment && pdfKind === 'receipt_combined') {
        const taxReceiptPayload: Record<string, unknown> = {
          invoice_id: invoiceId,
          receipt_document_number_raw: docNum.raw,
          fiscal_year: fy,
          payment_date: input.paymentDate,
          invoice_subject: 'event',
          ...(memberId !== null
            ? { member_id: memberId }
            : { event_registration_id: draft.eventRegistrationId }),
        };
        await deps.audit.emit(tx, {
          tenantId: input.tenantId,
          requestId: input.requestId ?? null,
          eventType: 'tax_receipt_issued',
          actorUserId: input.actorUserId,
          summary: `Tax receipt ${docNum.raw} issued`,
          payload: taxReceiptPayload,
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
      // Cluster 5 (Finding 1 — event follow-up) — observable dispatch outcome,
      // mirroring issueInvoice. This path has NO F5-style suppress flag (see
      // the L block header), so the arm precedence is the simple two-outcome
      // one: `'disabled'` when the tenant `autoEmailEnabled` toggle is OFF;
      // otherwise the helper reports 'sent' vs 'skipped_no_email' (empty buyer
      // email). Threaded into the returned Invoice subtype so the issue-as-paid
      // route + event-fee-form toast can warn the admin the §86/4 receipt was
      // NOT emailed (the receipt is still issued + numbered + persisted — only
      // the outbox email was skipped).
      let emailDispatch: EmailDispatchOutcome = 'disabled';
      if (settings.autoEmailEnabled) {
        // Shared helper (wave-4 S15) — trim + empty-recipient skip (warn +
        // metric, ids only) else ONE outbox row; the non-member buyer gets
        // the §87/3 PDPA transparency footer (recordPayment/issueInvoice
        // Task-14 B parity). An enqueue THROW still hard-fails the whole
        // issuance via tx rollback.
        emailDispatch = await enqueueInvoiceAutoEmail(deps.outbox, tx, {
          tenantId: input.tenantId,
          invoiceId,
          invoiceSubject: 'event',
          eventType: 'invoice_paid',
          recipientEmail: memberSnap.primary_contact_email ?? null,
          pdfBlobKey: blobKey,
          pdfTemplateVersion: deps.currentTemplateVersion,
          privacyFooterKind:
            memberId === null ? ('event_non_member' as const) : undefined,
          skipLogMessage:
            'issueEventInvoiceAsPaid: receipt auto-email skipped — buyer has no contact email',
        });
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
          invoiceSubject: 'event' as const,
          // Event fees never drive membership anchoring; the hook skips
          // subject='event' before ever reading this field.
          paymentDate: null,
        };
        for (const cb of callbacks) {
          await cb(evt, tx);
        }
      }

      // T113 parity — count + duration fire together at the happy-path tail
      // (rolled-back attempts never record; they produced no §87 number).
      invoicingMetrics.issueCount();
      invoicingMetrics.issueDurationMs(performance.now() - issueStartedAt);
      // Cluster 5 (Finding 1 — event follow-up) — thread the auto-email outcome
      // alongside the paid invoice (a structural subtype of `Invoice`, so no
      // existing consumer breaks).
      return ok({ ...paid, emailDispatch });
    });
  } catch (e) {
    // Orphan-blob mitigation (reliability L-1 + review Important #1): ANY
    // failure after the upload rejected the tx, so the bytes at the
    // deterministic key outlive the rollback while OUR row stays draft (we
    // held its lock until rollback — no committed row can reference the
    // key). Worse, on retry the blob adapter treats "already exists" as
    // success returning the OLD bytes while the row commits the NEW sha256
    // — silent tax-document drift. So clean up on every caught error EXCEPT:
    //   - the `invoice_already_issued` conflict translation: the race WINNER
    //     may legitimately own that key; and
    //   - `pdf_render_failed` (wave-3 S29): the render runs BEFORE the
    //     upload inside renderAndUploadPdf, so THIS attempt wrote nothing at
    //     the key — there is nothing to delete.
    // Best-effort delete (awaited, failure logged, never masks the original
    // error).
    //
    // Residual (wave-3 S33, accepted): this post-rollback delete can race a
    // SUCCESSOR issuance of the same invoice re-uploading to the SAME
    // deterministic key — a late delete may remove the successor's fresh
    // bytes, leaving its committed row with a dangling key. Accepted
    // because the key is deterministic (a re-render/resend restores
    // byte-identical content and the invoice-detail Blob-miss recovery
    // tolerates a dangling key), and the in-tx winner case is already
    // covered by the conflict-translation exemption above.
    const orphanBlobKey = blobKeyForCleanup;
    const skipOrphanCleanup =
      e instanceof IssueAsPaidInternalError &&
      (e.error.code === 'invoice_already_issued' || e.error.code === 'pdf_render_failed');
    if (orphanBlobKey !== null && !skipOrphanCleanup) {
      await deps.blob.delete(orphanBlobKey).catch((delErr: unknown) => {
        // 065 H-1b — ERROR (not warn) + alertable counter: a failed cleanup
        // leaves stale bytes at the deterministic key. The H-1a
        // allowOverwrite retry defuses the drift on THIS path, but ops still
        // needs the key to sweep the orphan (the row may never be retried).
        logger.error(
          { err: delErr, invoiceId: input.invoiceId, blobKey: orphanBlobKey },
          'issue-as-paid: orphan blob cleanup failed',
        );
        invoicingMetrics.orphanBlobCleanupFailed('issue_as_paid');
      });
    }
    if (e instanceof IssueAsPaidInternalError) {
      // 065 M-4 — severity split: overflow (tenant-wide §87 number-space
      // outage) and pdf/blob infrastructure failures are 500-class server
      // faults → ERROR; business rejects carried by the throw-only zone
      // (the invoice_already_issued race loser) stay WARN.
      const isServerFault =
        e.error.code === 'overflow' ||
        e.error.code === 'pdf_render_failed' ||
        e.error.code === 'blob_upload_failed';
      const logPayload = {
        err: e.error,
        invoiceId: input.invoiceId,
        tenantId: input.tenantId,
      };
      if (isServerFault) {
        logger.error(logPayload, 'issueEventInvoiceAsPaid: internal error, rolling back');
      } else {
        logger.warn(logPayload, 'issueEventInvoiceAsPaid: internal error, rolling back');
      }
      if (e.error.code === 'overflow') {
        invoicingMetrics.issuanceOverflow(input.tenantId, e.error.fiscalYear);
      }
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
              // receipt_combined, no-TIN β → receipt_separate), so this is
              // never null on a pdf_render_failed path. No fabricated
              // fallback (wave-4 S23): if the impossible ever happened, an
              // honest null in the forensic row beats a lying kind.
              render_kind: pdfKindForForensics,
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
