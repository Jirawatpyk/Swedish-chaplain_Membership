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
import { emitNonMemberInvoiceEvent, type AuditPort } from '../ports/audit-port';
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
import {
  buyerHasTin,
  inferEventDocumentKind,
} from '@/modules/invoicing/domain/document-kind';
import { logger } from '@/lib/logger';
import { invoicingMetrics } from '@/lib/metrics';
import { bangkokLocalDate } from '@/lib/fiscal-year';
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
  /**
   * The admin-entered payment date falls outside `[issue_date, today]`
   * (today in Asia/Bangkok). Server-side mirror of the F4 record-payment
   * client clamp — defends the §87 temporal-consistency invariant when
   * the bypassable native date input is skipped (curl/script). The F5
   * webhook + F8 offline-mark paths are exempt (processor/derived dates).
   */
  | { code: 'payment_date_out_of_range'; min: string | null; max: string }
  /**
   * REMOVE-WITH-064-REMEDIATION (site 2/15 — full checklist at the guard
   * below + docs/runbooks/event-invoice-legacy-no-tin-remediation.md) —
   * 064 INTERIM: the invoice is a LEGACY issued no-TIN EVENT row that
   * predates the as-paid redesign. Its issue-time PDF already IS the
   * buyer's §105 ใบเสร็จรับเงิน; recording a payment here would mint
   * receipt #2 (the §105 double-receipt the redesign kills). New no-TIN
   * event fees take `issueEventInvoiceAsPaid` exclusively; legacy rows go
   * through the remediation runbook.
   */
  | { code: 'legacy_no_tin_event_needs_remediation' }
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
   * registration order INSIDE the same `withTx` after the registration-
   * fee flip (hoisted pre-allocation, wave-3 S12) + applyPayment +
   * audit emit + outbox enqueue have all
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
  // outside the tx is safe. Mirrors the identical fix + rationale in the
  // pre-`withTx` settings read in `issueCreditNote` and `voidInvoice`.
  const settings = await deps.tenantSettingsRepo.getForIssue(input.tenantId);
  // R18-03 — early-exit on missing settings BEFORE opening withTx +
  // acquiring lockForUpdate. Matches the "pre-sequence early exits"
  // pattern in `issueInvoice` (its `settings_missing` guard) and saves a
  // useless round-trip + probe audit emit when the tenant has no settings
  // row yet.
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

    // Server-side payment-date guard (defense-in-depth). The F4 admin
    // record-payment dialog clamps the date picker to
    // `[issue_date, Asia/Bangkok today]`, but that native clamp is
    // bypassable (curl/script) — re-validate here so a payment can't be
    // dated before its tax invoice or in the future (§87 temporal
    // consistency). MUST compute "today" in Asia/Bangkok via
    // `bangkokLocalDate` (the SAME helper that stamps `issue_date`); a
    // UTC bound would reject same-Bangkok-day payments for ~7h/day — the
    // exact client-side bug this mirrors. Runs BEFORE any write so a
    // rejection burns no §87 receipt number. Exempt:
    //   • `webhook`            — F5 processor-authoritative settlement date.
    //   • `admin_offline_mark` — F8 renewal offline-mark owns its own
    //                            date handling; not the F4 dialog surface.
    if (
      input.triggeredBy !== 'webhook' &&
      input.triggeredBy !== 'admin_offline_mark'
    ) {
      const bangkokToday = bangkokLocalDate(deps.clock.nowIso());
      if (
        (loaded.issueDate !== null && input.paymentDate < loaded.issueDate) ||
        input.paymentDate > bangkokToday
      ) {
        return err({
          code: 'payment_date_out_of_range',
          min: loaded.issueDate,
          max: bangkokToday,
        });
      }
    }
    // 054-event-fee-invoices (final-review HIGH 2) — record-payment now
    // supports NON-member EVENT invoices (spec §9 NF-B / Decision 7). A null
    // `member_id` is VALID for `invoice_subject='event'`: the buyer was pinned
    // into `member_identity_snapshot` at draft (createEventInvoiceDraft) and is
    // the payer identity — the snapshot-completeness guard above
    // (`!loaded.memberIdentitySnapshot` → no_snapshot_on_invoice) already
    // ensures that buyer block is present, so the receipt render below has a
    // valid `member` to render WITHOUT dereferencing a null F3 member.
    //
    // A MEMBERSHIP invoice with a null member, by contrast, IS a real data
    // error — `invoices_subject_fields_ck` guarantees member_id IS NOT NULL for
    // `invoice_subject='membership'`, so reaching here with one implies a
    // corrupted row. Keep rejecting that case (same class as a missing
    // snapshot). `memberId` (string | null) drives the audit-branch
    // (timeline vs non-timeline), registration-fee flip, and onPaid-callback
    // gates below.
    const memberId = loaded.memberId;
    // LOW-9 — this is the CORRUPTED-MEMBERSHIP-ROW data-error case, NOT a
    // missing-snapshot case: a non-event invoice with member_id IS NULL
    // violates `invoices_subject_fields_ck` (which guarantees member_id IS NOT
    // NULL for invoice_subject='membership'). We reuse the `no_snapshot_on_invoice`
    // error code deliberately — it is the closest existing data-integrity class
    // and renaming it would ripple to the route's HTTP-status map + i18n for no
    // behavioural gain. An operator reading this code/log should understand the
    // null member_id (not a missing snapshot field) is what triggered the error.
    if (memberId === null && loaded.invoiceSubject !== 'event') {
      return err({ code: 'no_snapshot_on_invoice' });
    }
    // REMOVE-WITH-064-REMEDIATION (site 1/15 — the guard itself).
    // 064 INTERIM (remove after spec §6 item 1 remediation completes):
    // a LEGACY issued no-TIN event row predates the as-paid redesign — paying
    // it here would mint receipt #2 (the §105 double-receipt this redesign
    // kills). Operators: see
    // docs/runbooks/event-invoice-legacy-no-tin-remediation.md. NEW no-TIN
    // event rows can no longer reach 'issued' (issueInvoice rejects them with
    // `event_no_tin_requires_paid_issue`), so only pre-064 rows hit this.
    // The branch above already returned for paid-replay / non-issued rows,
    // so `lockedStatus === 'issued'` is guaranteed here — no status check.
    //
    // FULL REMOVAL CHECKLIST — when remediation completes, grep
    // `REMOVE-WITH-064-REMEDIATION` and delete every site (i18n keys carry
    // no marker — JSON has no comments — so they are enumerated here).
    // Sites 1–7 are the ADMIN record-payment fence; sites 8–15 are the
    // ONLINE-payment fence (S0 money trap: a member Stripe-pays a legacy
    // row → webhook flip rejected permanently → captured money stranded):
    //   1. THIS guard branch (record-payment.ts)
    //   2. the `legacy_no_tin_event_needs_remediation` member of
    //      `RecordPaymentError` above (record-payment.ts)
    //   3. the `'legacy_no_tin_event_needs_remediation' ? 409` map line in
    //      src/app/api/invoices/[invoiceId]/pay/route.ts
    //   4. the `errors.legacy_no_tin_event_needs_remediation` i18n key in
    //      src/i18n/messages/{en,th,sv}.json (×3 — grep the key name)
    //   5. the toast branch in
    //      src/app/(staff)/admin/invoices/_components/payment-form.tsx
    //   6. the unit pin in tests/unit/invoicing/record-payment.test.ts
    //   7. the integration pin (incl. its direct-insert legacy fixture) in
    //      tests/integration/invoicing/record-payment-event-invoice.test.ts
    //   8. the `legacy_no_tin_event_not_payable` guard + error-union member
    //      in src/modules/invoicing/application/use-cases/get-invoice-for-payment.ts
    //   9. the bridge-union member (invoicing-bridge-port.ts) + the
    //      `mapF4GetError` case (invoicing-bridge.ts) in src/modules/payments
    //  10. the `legacy_no_tin_event_not_payable` error-union member + the
    //      short-circuit branch in
    //      src/modules/payments/application/use-cases/initiate-payment.ts
    //  11. the `legacy_no_tin_event_not_payable` → 409 map case in
    //      src/app/api/payments/initiate/route.ts
    //  12. the 'issued' resolver arm + the
    //      `payments.confirm.legacy_no_tin_event_money_captured` ops log
    //      (+ its logger import) in
    //      src/modules/payments/application/use-cases/confirm-payment.ts
    //  13. the portal pay-gate: the extracted predicate helper
    //      src/app/(member)/portal/invoices/_utils/legacy-no-tin.ts (whole
    //      file) + its unit pin tests/unit/portal/legacy-no-tin.test.ts,
    //      the gate + notice in
    //      src/app/(member)/portal/invoices/[invoiceId]/page.tsx AND the
    //      `portal.invoices.detail.legacyNoTinNotPayable` i18n key in
    //      src/i18n/messages/{en,th,sv}.json (×3 — grep the key name)
    //  14. the unit/contract pins in
    //      tests/unit/invoicing/get-invoice-for-payment.test.ts,
    //      tests/unit/payments/invoicing-bridge.test.ts,
    //      tests/unit/payments/application/initiate-payment.test.ts,
    //      tests/unit/payments/application/confirm-payment.test.ts,
    //      tests/contract/payments/post-payments-initiate.contract.test.ts,
    //      tests/contract/invoices/pay-route-guard.contract.test.ts
    //  15. the matched-member integration pin (incl. its direct-insert
    //      fixture) in
    //      tests/integration/invoicing/record-payment-event-invoice.test.ts
    if (
      loaded.invoiceSubject === 'event' &&
      !buyerHasTin(loaded.memberIdentitySnapshot.tax_id)
    ) {
      return err({ code: 'legacy_no_tin_event_needs_remediation' });
    }

    // Spec § 398 — "registration fee once per member lifecycle". If the
    // invoice being paid contains a registration_fee line, flip
    // members.registration_fee_paid = true so the NEXT invoice doesn't
    // double-charge. Runs inside the same transaction as applyPayment below
    // so a rollback unwinds both writes atomically. Idempotent — the
    // adapter's WHERE registration_fee_paid=FALSE makes replay on an
    // already-true row a no-op.
    //
    // LOCK-ORDER (wave-3 S12 — supersedes the former "benign AB-BA" note):
    // this member-row UPDATE is deliberately HOISTED ABOVE the separate-mode
    // `allocateNext` below so recordPayment acquires the member row BEFORE
    // advisory('receipt') — the same member→advisory order the β as-paid
    // path takes (member FOR UPDATE in resolveInvoiceBuyerForIssue, then
    // its receipt-stream allocation). With both flows ordering
    // member→advisory, the AB-BA deadlock window (40P01 under a concurrent
    // β as-paid + recordPayment touching the same member) is structurally
    // gone. The flip does not depend on the allocated number; its failure
    // semantics are UNCHANGED (raw throw → withTx rollback, hard-fail) and
    // now SAFER — a throw here is PRE-sequence, so no §87 receipt number is
    // burned by a failed member flip. This block must stay BELOW the last
    // `return err(...)` above (a normal return from the withTx callback
    // COMMITS — an early-exit after the flip would commit the flip alone)
    // and ABOVE `allocateNext`. Order is pinned by the S12 unit test.
    //
    // 054-event-fee-invoices — registration-fee is a MEMBERSHIP concept (the
    // one-off joining fee on a member's first invoice). A non-member EVENT
    // invoice (memberId null) carries only an `event_fee` line — never a
    // `registration_fee` — and there is no F3 member row to flip, so the
    // `memberId !== null` guard both skips the no-op flip AND satisfies the
    // `markRegistrationFeePaid(tx, tenantId, memberId: string)` non-null
    // contract for the membership path. (The `hasRegistrationFee` check stays
    // first so a membership invoice without the line still short-circuits.)
    const hasRegistrationFee = loaded.lines.some(
      (l) => l.kind === 'registration_fee',
    );
    if (hasRegistrationFee && memberId !== null) {
      await deps.memberIdentity.markRegistrationFeePaid(
        tx,
        input.tenantId,
        memberId,
      );
    }

    // Receipt PDF — reuses invoice snapshot (FR-038 immutability). The
    // kind differs based on tenant setting; combined mode renders a
    // single "ใบกำกับภาษี/ใบเสร็จรับเงิน" label; separate mode
    // allocates its own receipt sequence number.
    //
    // 054/064/066 — §86/4 doc-type consistency. The receipt kind mirrors the
    // issue-time document kind via the shared `inferEventDocumentKind`
    // discriminator, so issue-, pay-, and credit-time gates stay in lockstep
    // (FIX 5 — no inline `buyerHasTin` reconstruction):
    //
    //   • EVENT + no TIN  → `receipt_separate` (ใบเสร็จรับเงิน / §105). An event
    //     ticket buyer with no TIN is routed to a §105 receipt (the 064 design),
    //     so the payment-time receipt FORCES `receipt_separate`, overriding the
    //     tenant's `receiptNumberingMode='combined'`. (In practice no TIN-less
    //     event row reaches here — the 064 interim guard above rejects it — but
    //     the verdict is kept for lockstep with the issue-/credit-time gates.)
    //   • MEMBERSHIP (any TIN state) → `inferEventDocumentKind` returns 'invoice',
    //     so `forceSeparate` is ALWAYS false and a membership receipt follows the
    //     tenant setting (`receipt_combined` when combined-mode). 066 relax: a
    //     no-TIN membership buyer is now REACHABLE here, and `receipt_combined`
    //     (the "ใบกำกับภาษี/ใบเสร็จรับเงิน" label) is CORRECT for them — a §86/4
    //     to a non-registrant with name+address is a valid tax invoice, so the
    //     combined tax-invoice/receipt is equally valid. (The old "a TIN-less
    //     buyer must never receive the ใบกำกับภาษี label" rule was the legally-
    //     wrong premise 066 corrected; it never applied to membership.)
    //
    // The `member` rendered below is the BUYER snapshot
    // (`loaded.memberIdentitySnapshot`, non-null per the guard above) — NEVER a
    // deref of `member_id`, so a null-member event invoice renders correctly.
    // (TIN check trims whitespace, matching the issue-time discriminator.)
    const forceSeparate =
      inferEventDocumentKind(
        loaded.invoiceSubject,
        loaded.memberIdentitySnapshot.tax_id,
      ) === 'receipt_separate';
    const combinedMode =
      settings.receiptNumberingMode === 'combined' && !forceSeparate;
    let receiptDocNumRaw: string | null = null;
    let receiptDocNum: DocumentNumber | null = null;
    if (!combinedMode) {
      // Separate mode — allocate receipt sequence. fiscalYear presence
      // was validated above (no_snapshot_on_invoice), so loaded.fiscalYear
      // is the frozen issue-time FY, never 0.
      // Lock-order note (wave-3 S12): advisory('receipt') is acquired HERE,
      // AFTER the member-row update (markRegistrationFeePaid, hoisted above)
      // — member→advisory, the SAME order the β as-paid path takes. Do not
      // move the flip back below this allocation; see the hoisted block's
      // comment + the issue-event-invoice-as-paid.ts header.
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
                // 054-event-fee-invoices (Task 9, Fix 2) — thread vatInclusive so
                // a matched-member EVENT invoice issued as receipt_separate carries
                // its "VAT included" annotation consistently in the payment-time
                // receipt PDF. Membership invoices carry false (VAT-exclusive) so
                // the annotation is suppressed there, matching existing behaviour.
                vatInclusive: loaded.vatInclusive,
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
    // Common (subject-agnostic) fields for the `invoice_paid` audit payload.
    // The branch below adds EITHER `member_id` (membership / matched member →
    // F3 timeline) OR `event_registration_id` (non-member event → non-timeline).
    const invoicePaidSummary = `Invoice ${loaded.documentNumber?.raw} marked paid`;
    const invoicePaidPayloadBase: Record<string, unknown> = {
      invoice_id: invoiceId,
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
    };
    // 054-event-fee-invoices (final-review HIGH 2) — branch on buyer kind, exactly
    // as issue-invoice.ts + issue-credit-note.ts do for the `invoice_paid` peer
    // events:
    //
    //   MEMBERSHIP / matched-member (memberId non-null) → TIMELINE branch: payload
    //   carries `member_id` so the F3 member timeline filter
    //   (`payload->>'member_id'`) surfaces the payment (US7). UNCHANGED F4 behaviour.
    //
    //   NON-MEMBER event (memberId null) → NON-timeline branch: the buyer is not an
    //   F3 member, so the timeline filter MUST NOT surface it. We do NOT widen
    //   `MemberTimelineAuditPayload` to make `member_id` optional (that would weaken
    //   the F3 `member_id` guarantee for the member-timeline event types); instead
    //   we route through the typed `emitNonMemberInvoiceEvent` helper, whose payload
    //   contract REQUIRES `event_registration_id` and FORBIDS `member_id` at compile
    //   time (no `as` cast).
    if (memberId !== null) {
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_paid',
        actorUserId: input.actorUserId,
        summary: invoicePaidSummary,
        payload: {
          // US7 — surfaces this event in the F3 member timeline, which
          // queries `payload->>'member_id'`. Required for the timeline
          // contract even though invoices.member_id is derivable.
          member_id: memberId,
          ...invoicePaidPayloadBase,
        },
      });
    } else {
      // NON-MEMBER event invoice. The guard at the top of this fn already
      // returned for a null-member NON-event invoice, so a null memberId here
      // implies `invoiceSubject === 'event'` → `invoices_subject_fields_ck`
      // guarantees `event_registration_id IS NOT NULL`. TS can't re-derive that,
      // so re-narrow on the column.
      if (loaded.eventRegistrationId === null) {
        throw new Error(
          'recordPayment: non-member event invoice has null event_registration_id (violates invoices_subject_fields_ck)',
        );
      }
      await emitNonMemberInvoiceEvent(deps.audit, tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_paid',
        eventRegistrationId: loaded.eventRegistrationId,
        actorUserId: input.actorUserId,
        summary: invoicePaidSummary,
        extraPayload: invoicePaidPayloadBase,
      });
    }

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
    // Wave-4 S15 — issueInvoice + issueEventInvoiceAsPaid share
    // `lib/enqueue-invoice-email.ts` for this block's shape; THIS block is
    // deliberately NOT folded into that helper because its semantics differ
    // in four load-bearing ways: (1) the F5 `suppressReceiptEmail` THREE-arm
    // branch incl. an info-log arm, (2) the `dependsOnReceiptPdf` async-PDF
    // dispatcher gate, (3) the recipient is truthiness-checked, NOT trimmed
    // (legacy-snapshot tolerance documented above), and (4) the skip warn
    // carries memberId/documentNumber instead of the helper's fixed fields.
    // Folding would mean a 4-mode helper — worse than the duplication.
    //
    // T128a: F5 caller may suppress the receipt-email enqueue when the
    // tenant has disabled `auto_email_on_payment`. Status flip + audit +
    // outbox-skip log row still run — only the dispatcher enqueue is
    // gated. Spec.md:433: "MAY suppress" (optional override).
    if (
      settings.autoEmailEnabled &&
      recipientEmail &&
      !input.suppressReceiptEmail
    ) {
      // Wave-3 S13 — §87/3 PDPA privacy-footer parity with issueInvoice
      // (Task-14 B) and issueEventInvoiceAsPaid: a NON-member EVENT buyer's
      // receipt email must carry the same transparency footer the issue-time
      // email carried. Reachable for legacy / bill-first non-member event
      // rows (TIN buyers — the no-TIN interim guard returned above); without
      // this the dispatcher persisted a NULL footer for them. The subject
      // check is defensive narrowing — a null memberId on a non-event
      // subject already returned `no_snapshot_on_invoice` above.
      const privacyFooterKind =
        memberId === null && loaded.invoiceSubject === 'event'
          ? ('event_non_member' as const)
          : undefined;
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
        ...(privacyFooterKind ? { privacyFooterKind } : {}),
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
      // manually-patched invoice row). Bump a metric (ops can alert) AND
      // warn — brings the record-payment skip to parity with the
      // credit-note `skipped_no_recipient` + issue-invoice surfaces.
      invoicingMetrics.autoEmailSkipped(loaded.invoiceSubject, 'no_recipient');
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

    // F8 Phase 2 Wave A (T008) — fire registered on-paid callbacks
    // INSIDE the still-open withTx, after every other side-effect
    // (registration-fee flip — hoisted pre-allocation, wave-3 S12 —
    // then applyPayment, audit, outbox enqueue)
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
    // are guarded upstream: the `no_snapshot_on_invoice` guard returns early
    // when `loaded.total` is null, and `applyPayment` always
    // populates `paid_at` on a successful issued→paid UPDATE (RETURNING
    // contract). A failed adapter would have thrown before this point.
    //
    // 054-event-fee-invoices (final-review HIGH 2) — the `memberId !== null`
    // guard: `F4InvoicePaidEvent.memberId` is a non-null `string` (the
    // cross-module contract — F8 renewal-cycle completion keys off the member).
    // A NON-member EVENT invoice has no member, no renewal cycle, and nothing
    // for any registered on-paid listener to correlate against, so it correctly
    // fires NO callbacks. (Matched-member event invoices DO carry a memberId and
    // still fire callbacks — though F8 only completes a cycle when one is linked
    // to the invoice, so a member's event-fee payment is a benign no-op there.)
    const callbacks = deps.onPaidCallbacks;
    if (callbacks && callbacks.length > 0 && memberId !== null) {
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
        memberId,
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
      // back so forensic evidence survives (parity with the post-rollback
      // `pdf_render_failed` emit in `issueInvoice`'s outer catch).
      // Fire-and-forget: never mask the original error with an
      // audit-write failure.
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
