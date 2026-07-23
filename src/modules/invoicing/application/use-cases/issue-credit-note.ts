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
import type { RecipientLocalePort } from '../ports/recipient-locale-port';
import type { PendingRefundGuardPort } from '../ports/pending-refund-guard-port';
import { resolveRecipientLocale } from '../lib/resolve-recipient-locale';
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
import {
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
} from '@/modules/invoicing/domain/document-kind';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { logger } from '@/lib/logger';
import { isUniqueViolationOnConstraint } from '@/lib/db-errors';
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
  /**
   * F-2 (2026-07-08) — what this credit means for the member's membership.
   * REQUIRED when the invoice is subject='membership' AND the credit is a
   * FULL credit (credited_total after this note >= invoice total); the
   * partial-accumulation guard above already rejects anything that would
   * exceed the remainder, so in practice "full" means the credited total
   * lands EXACTLY on the invoice total. Forbidden/ignored otherwise (partial
   * credits and event invoices never touch membership — TSCC has no
   * established mid-term-refund practice, so per-case staff intent IS the
   * business rule; see docs/superpowers/specs/2026-07-08-renewal-rolling-
   * anchor-design.md § F-2).
   *   'keep'              — paperwork correction / duplicate refund; no
   *                          membership effect.
   *   'cancel_membership' — refund with withdrawal; the ROUTE (presentation)
   *                          cancels the member's in-flight renewal cycles
   *                          via F8's `cancelInFlightCyclesForMember` AFTER
   *                          this use-case commits (Principle III — F4 never
   *                          imports F8 directly).
   */
  membershipEffect: z.enum(['keep', 'cancel_membership']).optional(),
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
  /**
   * F-2 (2026-07-08) — `true` only when this was a FULL credit on a
   * `invoiceSubject==='membership'` invoice AND the caller declared
   * `membershipEffect: 'cancel_membership'`. The use-case itself never
   * touches F8 (Principle III); the ROUTE reads this flag to orchestrate
   * `cancelInFlightCyclesForMember` after this transaction commits.
   */
  readonly membershipCancellationRequested: boolean;
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
  /**
   * 088 US6 (T047 / § A.4 / SC-006) — the parent is a paid invoice whose §86/4
   * TAX RECEIPT PDF has NOT yet materialised (`receipt_pdf_status !== 'rendered'`
   * — the async render worker is still 'pending' or 'failed'). A §86/10 ใบลดหนี้
   * can only adjust a rendered §86/4 tax receipt, so crediting is blocked until
   * it lands. TRANSIENT (409): the operator can retry once the receipt render
   * completes. Distinct from `receipt_not_creditable` — that is a LEGAL verdict
   * (a §105 receipt is NEVER creditable); this is a timing conflict. Ordered
   * AFTER the §86/10 gate so a §105 parent always gets the legal verdict, and
   * BEFORE `allocateNext` so a blocked attempt burns no §87 CN number.
   */
  | { code: 'receipt_not_rendered' }
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
  | { code: 'concurrent_state_change' }
  /**
   * F-2 (2026-07-08) — this credit note would FULLY credit a
   * `invoiceSubject==='membership'` invoice, but the caller omitted the
   * required `membershipEffect` field. Returned BEFORE `allocateNext` (no
   * §87 sequence number burned) — same pre-allocation discipline as every
   * other guard in this file.
   */
  | { code: 'membership_effect_required' }
  /**
   * 8A — a refund is in flight (`status='pending'`) on this invoice's
   * payment(s). Issuing a MANUAL credit note now would consume the creditable
   * remainder the refund's own §86/10 needs, stranding that Stripe-settled
   * refund `pending` forever. Refuse (409); the admin retries once the refund
   * settles. NOT raised for a refund-origin CN (`sourceRefundId` set) — that CN
   * IS the refund's own, so blocking it on its own pending row is nonsensical.
   */
  | { code: 'refund_in_progress' };

class IssueCreditNoteInternalError extends TxAbort<IssueCreditNoteError> {
  override readonly name = 'IssueCreditNoteInternalError';
}

/**
 * CRITICAL-1 (F5) — the partial unique index (migration 0242) that makes
 * credit-note issuance idempotent per refund. A duplicate CN insert for the
 * same `(tenant_id, source_refund_id)` raises Postgres 23505 on this index.
 */
const SOURCE_REFUND_UNIQUE_CONSTRAINT = 'credit_notes_source_refund_id_uniq';

/**
 * CRITICAL-1 / RR-2 — thrown when the CN insert LOSES a concurrent race on the
 * `source_refund_id` partial unique index (23505). A winning racer already
 * committed a CN for this `(tenant_id, source_refund_id)`. The current tx is
 * now POISONED — any further query in it errors "current transaction is aborted"
 * — so we throw to force `withTx` ROLLBACK (which also returns the §87
 * counter-row UPDATE to the pool → no gap), then reconcile the winner's CN in a
 * FRESH tx from the outer catch. Carries the `sourceRefundId` so the reconcile
 * can re-read the sibling. Only reachable when `input.sourceRefundId` is set
 * (the index is partial: `WHERE source_refund_id IS NOT NULL`).
 *
 * NOT a `TxAbort` subclass: the outer catch handles it distinctly (fresh-tx
 * reconcile → idempotent success), whereas every `IssueCreditNoteInternalError`
 * maps straight to a typed `err`.
 */
class CreditNoteRefundRaceError extends Error {
  override readonly name = 'CreditNoteRefundRaceError';
  constructor(readonly sourceRefundId: string) {
    super('credit-note source_refund_id unique race — reconcile in a fresh tx');
  }
}

/**
 * CRITICAL-1 / RR-2 — fresh-tx reconcile helper. After a losing racer's CN
 * insert hit the `source_refund_id` unique index, its transaction is poisoned
 * and cannot be queried, so the sibling CN MUST be re-read in a brand-new tx.
 * Opens a fresh tenant tx via the invoice repo's `withTx` (→ `runInTenant` →
 * `db.transaction`, a genuinely new connection with `app.current_tenant` SET —
 * never the pool-global `db`, Principle I) and reads the sibling via the same
 * tenant-filtered `findBySourceRefundId`. Returns `null` only if the sibling is
 * genuinely absent (winner rolled back AFTER our violation) — the caller maps
 * that to `concurrent_state_change`.
 *
 * `deps` is passed explicitly (the use-case is dependency-injected; there is no
 * module-level repo) — this is the injected shape of the brief's
 * `reconcileExistingCreditNote(tenantId, sourceRefundId)` helper.
 */
async function reconcileExistingCreditNote(
  deps: IssueCreditNoteDeps,
  tenantId: string,
  sourceRefundId: string,
): Promise<CreditNote | null> {
  return deps.invoiceRepo.withTx((tx) =>
    deps.creditNoteRepo.findBySourceRefundId(tx, tenantId, sourceRefundId),
  );
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
  /** Email-locale audit 2026-07-16 — member preference for the credit-note email. */
  readonly recipientLocale: RecipientLocalePort;
  readonly currentTemplateVersion: number;
  /** 8A — non-locking count of in-flight refunds (guards a manual CN). */
  readonly pendingRefundGuard: PendingRefundGuardPort;
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

  // 8A — refuse a MANUAL credit note while a refund is in flight on this
  // invoice (a non-locking count; see the port docstring). ABOVE the withTx on
  // purpose: `err()` inside `runInTenant` COMMITS, so a guard below the first
  // write would leave a phantom row + false audit behind a refusal. Gated on
  // `sourceRefundId === undefined` — a refund-origin CN IS the refund's own
  // §86/10, so blocking it on its own pending row is nonsensical (and would
  // deadlock the refund it belongs to).
  if (input.sourceRefundId === undefined) {
    const pendingRefunds =
      await deps.pendingRefundGuard.countPendingRefundsForInvoice(
        input.tenantId,
        invoiceId,
      );
    if (pendingRefunds > 0) {
      return err({ code: 'refund_in_progress' });
    }
  }

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

      // CRITICAL-1 (F5 idempotency, source_refund_id) — a refund-origin CN
      // (`sourceRefundId` set) is idempotent per `(tenant_id, source_refund_id)`:
      // if one already exists, return it WITHOUT allocating a new §87 number,
      // rendering a new PDF, or re-running the rollup / audit / outbox. Runs
      // UNDER the invoice `FOR UPDATE` lock (closes the RR-2 TOCTOU window) and
      // BEFORE the status gate, so a fully-credited parent (`status='credited'`
      // after a prior FULL refund CN — NOT in {paid, partially_credited}) still
      // returns the sibling CN rather than failing `invalid_status`. Gated on
      // `sourceRefundId !== undefined` so F4-manual issuance (no
      // `source_refund_id`; the partial unique index excludes NULLs) is
      // byte-for-byte unchanged. Threads `tx` (never the pool-global `db`).
      if (input.sourceRefundId !== undefined) {
        const existing = await deps.creditNoteRepo.findBySourceRefundId(
          tx,
          input.tenantId,
          input.sourceRefundId,
        );
        if (existing) {
          // A.7 review fix #2 — `findBySourceRefundId` is keyed on
          // `(tenant_id, source_refund_id)` ONLY; it cannot itself verify the
          // sibling CN belongs to the invoice under lock. Today a refund row
          // binds `refundId` + `invoiceId` 1:1 (both callers derive them from
          // the SAME refund row), so this is unreachable — but a future
          // mis-wired caller passing a `sourceRefundId` that does not belong
          // to `invoiceId` must fail LOUD and TYPED, never silently return a
          // credit note for the WRONG invoice.
          if (existing.originalInvoiceId !== invoiceId) {
            logger.error(
              {
                tenantId: input.tenantId,
                invoiceId,
                sourceRefundId: input.sourceRefundId,
                existingCreditNoteId: existing.creditNoteId,
                existingOriginalInvoiceId: existing.originalInvoiceId,
              },
              'issueCreditNote: source_refund_id idempotency read matched a CN belonging to a DIFFERENT invoice — rejecting',
            );
            return err({ code: 'concurrent_state_change' });
          }
          return ok({
            creditNote: existing,
            // Repeat is a pure read — no new email enqueued, no F8 cascade.
            emailDelivery: 'not_requested',
            membershipCancellationRequested: false,
          });
        }
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
      // §86/4 tax invoice (ใบกำกับภาษี, kind='invoice'), because §86/10
      // วรรคสอง requires the ใบลดหนี้ to carry THE NUMBER AND DATE OF THE
      // ORIGINAL ใบกำกับภาษี. A §105 receipt supplies neither, so there is
      // nothing lawful to cite and the credit note would be void.
      //
      // THE RULE IS SELLER-SIDE, NOT BUYER-SIDE. §86/10 binds the
      // VAT-REGISTERED SELLER who issued the original tax invoice; it does
      // NOT require the BUYER to be a VAT registrant. Do not restate this
      // gate as "the buyer has no input VAT to reverse" — that framing is
      // wrong and, applied consistently, would break the membership path,
      // which issues a valid §86/4 (and therefore valid credit notes) to
      // non-registrant buyers with no TIN line at all under the 066 relax.
      // Production currently holds 11 such membership invoices. See
      // `document-kind.ts` — `inferEventDocumentKind` returns 'invoice' for
      // EVERY membership row regardless of `buyerIsVatRegistrant`.
      //
      // Separately: "no credit note can be issued" does NOT mean "no VAT
      // adjustment is needed". Output VAT already remitted on a refunded
      // §105 sale still has to be adjusted for that tax month by another
      // instrument. That is an accounting procedure, not something this
      // use-case can do.
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
      // BUYER's VAT-REGISTRANT status via the shared `inferEventDocumentKind`,
      // mirroring the issue-time gates EXACTLY so issue-time, pay-time, and
      // credit-time stay in lockstep (FIX 5 shared Domain discriminator).
      //
      // 059 / PR-A Task 6a — re-keyed off the BUYER snapshot's raw `tax_id` onto
      // the RECORDED registrant flag (shared resolver). Keying the CREDIT gate on
      // TIN-presence while ISSUE keys on registrant status would let a §105
      // receipt (issued to a non-registrant whose `tax_id` holds a passport) be
      // credited by a §86/10 ใบลดหนี้ — legally void, and precisely the lockstep
      // divergence this module exists to prevent.
      // `invoices.pdf_doc_kind` (migration 0211) persists the same verdict;
      // the J2 annotation re-render reads the column (Task 12) while this
      // gate keeps the derivation so the lockstep sites share one source.
      //
      // Runs BEFORE `allocateNext` (POST-SEQUENCE zone), so a blocked attempt
      // never burns a §87 credit-note sequence number — the §87 CN stream
      // stays gap-free. Mirrors the issue-invoice rule that the doc-type gate
      // precedes sequence allocation.
      // 059 / PR-A Task 6b — computed ONCE and threaded to the doc-kind gate
      // AND both PDF re-renders below (the credit-note itself + the J2
      // credited-annotation overlay), so the Tax ID line's print decision can
      // never disagree with the kind decision that gated this credit.
      const buyerIsVatRegistrant = resolveBuyerIsVatRegistrant(
        loaded.memberId,
        loaded.memberIdentitySnapshot,
      );
      const isReceiptSeparate =
        inferEventDocumentKind(loaded.invoiceSubject, buyerIsVatRegistrant) ===
        'receipt_separate';
      if (isReceiptSeparate) {
        return err({ code: 'receipt_not_creditable' });
      }

      // 088 US6 (T047 / § A.4 / SC-006) — a §86/10 ใบลดหนี้ can only adjust a
      // MATERIALISED §86/4 tax receipt. Block crediting until the receipt PDF
      // has rendered (the async worker may still be 'pending'/'failed', or a
      // legacy paid row may carry a null status). An unpaid ใบแจ้งหนี้ already
      // failed the paid/partially_credited status gate above (no receipt exists
      // yet). Runs AFTER the §86/10 `receipt_not_creditable` gate (a §105
      // receipt is never creditable regardless of render state) and BEFORE
      // `allocateNext` so a blocked attempt burns no §87 CN sequence number.
      // BOTH parent shapes that reach here land `receiptPdfStatus='rendered'`:
      // the record-payment path (separate receipt blob) and the as-paid path
      // (the main pdf IS the receipt) — so this one check gates both.
      if (loaded.receiptPdfStatus !== 'rendered') {
        return err({ code: 'receipt_not_rendered' });
      }

      if (
        !loaded.memberIdentitySnapshot ||
        !loaded.tenantIdentitySnapshot ||
        !loaded.subtotal ||
        !loaded.vat ||
        !loaded.total ||
        !loaded.vatRate ||
        !loaded.fiscalYear ||
        // 088 US6 — `documentNumber` is NO LONGER required: a membership bill in
        // the new tax-at-payment flow carries `document_number = NULL` (its §87
        // number lives in `receipt_document_number_raw`). Requiring it here would
        // reject every membership credit note. The receipt number the CN
        // references + annotates is resolved by `receiptDocNum` below (prefers
        // the RC in `receiptDocumentNumberRaw`, falls back to the invoice-stream
        // `documentNumber` for as-paid TIN + legacy combined-reuse).
        !loaded.issueDate
      ) {
        return err({ code: 'no_snapshot_on_invoice' });
      }

      // 088 US6 (T047 / § A.4) — resolve the §86/4 tax RECEIPT this credit note
      // references + annotates (NOT the non-tax ใบแจ้งหนี้ bill). Mirror
      // `render-receipt-pdf.ts`: prefer the payment-time RC in
      // `receiptDocumentNumberRaw`; fall back to the invoice-stream
      // `documentNumber` (as-paid TIN combined receipt reuses it; legacy
      // combined-mode does too). Exactly one is set on a creditable paid row —
      // the §105 `receipt_separate` parent is already blocked above — so
      // both-null is unreachable data corruption. Computed BEFORE `allocateNext`
      // so a parse failure returns a clean error without burning a §87 number.
      let receiptDocNum: DocumentNumber;
      if (loaded.receiptDocumentNumberRaw !== null) {
        const parsedReceiptDoc = DocumentNumber.parse(loaded.receiptDocumentNumberRaw);
        if (!parsedReceiptDoc.ok) return err({ code: 'no_snapshot_on_invoice' });
        receiptDocNum = parsedReceiptDoc.value;
      } else if (loaded.documentNumber !== null) {
        receiptDocNum = loaded.documentNumber;
      } else {
        return err({ code: 'no_snapshot_on_invoice' });
      }

      // 088 US6 review fix (HIGH / §86/10 + SC-003) — the receipt date must match
      // what the §86/4 receipt was ACTUALLY rendered with, so the CREDITED
      // re-render is byte-faithful (additive-only) and the §86/10 CN cites the
      // real original-document date. MIRROR render-receipt-pdf.ts:216-219 +
      // record-payment.ts:570: the NEW-flow receipt (documentNumber NULL → RC
      // minted at payment) is dated at the payment date (D7 tax point); a LEGACY
      // combined-reuse receipt (documentNumber reused, flag-off — the CURRENT
      // rollout default) was dated at the bill's issueDate. Using paymentDate
      // unconditionally would silently rewrite the printed date on an
      // already-issued legacy receipt when the annotation overwrites its blob.
      // Both branches are non-null on a paid/partially_credited row; guard
      // defensively so a corrupt row fails typed rather than NPEs.
      const receiptIssueDate =
        loaded.documentNumber === null ? loaded.paymentDate : loaded.issueDate;
      if (receiptIssueDate === null) return err({ code: 'no_snapshot_on_invoice' });
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

      // F-2 (2026-07-08) — membership-effect intent gate. Computed here
      // (BEFORE the POST-SEQUENCE zone) so a validation failure never burns
      // a §87 sequence number — same discipline as `receipt_not_creditable` /
      // `credit_exceeds_remainder` above. `prospectiveCreditedTotal` +
      // `isFullCredit` are the single source of truth for "did this credit
      // note complete the invoice?" — reused verbatim at the J. Rollup site
      // below instead of recomputing.
      const prospectiveCreditedTotal = addSatang(
        asSatang(loaded.creditedTotal.satang),
        asSatang(total.satang),
      );
      const isFullCredit =
        prospectiveCreditedTotal === asSatang(loaded.total.satang);
      const isMembershipInvoice = loaded.invoiceSubject === 'membership';
      if (
        isMembershipInvoice &&
        isFullCredit &&
        input.membershipEffect === undefined
      ) {
        return err({ code: 'membership_effect_required' });
      }
      // Only a full membership credit with an EXPLICIT 'cancel_membership'
      // choice requests the F8 cascade. Partial credits + event invoices
      // never reach here with `isMembershipInvoice && isFullCredit` true, so
      // any `membershipEffect` they supplied is silently ignored per spec.
      const membershipCancellationRequested =
        isMembershipInvoice &&
        isFullCredit &&
        input.membershipEffect === 'cancel_membership';

      // M1 (plan-change-ux, business decision Option 1b) — does this credit note
      // LEAVE the member's membership coverage intact for the credited period?
      // Persisted on `credit_notes.retains_coverage`; the renewal effective-paid
      // predicate + L1 pipeline read it via a correlated EXISTS on the settling
      // invoice so a coverage-retaining note does NOT retract the period even
      // though the invoice flips to 'credited'.
      //
      // ORDER MATTERS — check `sourceRefundId` FIRST. The F5 refund bridge
      // (issue-credit-note-from-refund.ts) hard-codes `membershipEffect: 'keep'`
      // while GENUINELY returning money, so `membershipEffect === 'keep'` alone is
      // NOT the retention signal. Only an F4-manual (no sourceRefundId) FULL
      // membership 'keep' — a paperwork correction where the member was NOT
      // refunded — retains coverage. Partial credits + event invoices never reach
      // the true arm (isFullCredit / isMembershipInvoice false) → always FALSE.
      const retainsCoverage =
        isMembershipInvoice && isFullCredit
          ? input.sourceRefundId !== undefined
            ? false // F5 real refund → money returned → retract
            : input.membershipEffect === 'cancel_membership'
              ? false // withdrawal → retract
              : true // F4-manual full 'keep' (Option 1b): assume no refund → RETAIN
          : false; // partial / event / non-full — predicate never consulted

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
        descriptionTh: `ลดหนี้ตาม ${receiptDocNum.raw}`,
        descriptionEn: `Credit against ${receiptDocNum.raw}`,
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
              // 088 US6 (T047) — reference the §86/4 RC tax receipt (its number
              // + payment date), NOT the non-tax ใบแจ้งหนี้ bill.
              originalDocumentNumber: receiptDocNum.raw,
              originalIssueDate: receiptIssueDate,
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
          // M1 (plan-change-ux, Option 1b) — coverage-retention intent derived
          // above (sourceRefundId-first). Write-once at INSERT.
          retainsCoverage,
          ...(input.sourceRefundId !== undefined
            ? { sourceRefundId: input.sourceRefundId }
            : {}),
        });
      } catch (e) {
        // CRITICAL-1 (F5) — a LOST race on the `source_refund_id` partial
        // unique index (migration 0242) means a sibling CN already exists for
        // this refund. Signal the outer catch to reconcile it in a FRESH tx
        // (this tx is now poisoned; we cannot SELECT the sibling here — RR-2).
        // Only possible when `sourceRefundId` is set. Every OTHER insert error
        // — the (tenant, fiscal_year, sequence_number) unique that the
        // allocator FOR UPDATE lock already prevents, or an FK/CHECK/snapshot
        // rejection — stays the pre-existing typed `concurrent_state_change`.
        if (
          input.sourceRefundId !== undefined &&
          isUniqueViolationOnConstraint(e, SOURCE_REFUND_UNIQUE_CONSTRAINT)
        ) {
          throw new CreditNoteRefundRaceError(input.sourceRefundId);
        }
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
      // F-2 (2026-07-08) — `newCreditedTotal` / `fullyCredited` are the SAME
      // values as `prospectiveCreditedTotal` / `isFullCredit` computed above
      // (before the POST-SEQUENCE zone) for the membership-effect gate;
      // reused here as a single source of truth rather than recomputed.
      const newCreditedTotal = prospectiveCreditedTotal;
      const fullyCredited = isFullCredit;
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

      // J2. US6 (T048 / SC-006 / § A.4) — re-render the §86/4 TAX RECEIPT with a
      // CREDITED / PARTIALLY CREDITED annotation + CN-reference footer, then
      // overwrite at the SAME receipt Blob key (content-address preserved). A
      // §86/10 ใบลดหนี้ adjusts the tax receipt (the document carrying the input
      // VAT), NOT the now-non-tax ใบแจ้งหนี้ bill — so the stamp lands on the
      // receipt. Two parent shapes carry the receipt (both reach here only with
      // `receiptPdfStatus='rendered'`, guaranteed by the precondition above):
      //
      //   Shape 1 — record-payment path (membership, bill-first TIN event): the
      //     §86/4 receipt is a SEPARATE blob (`loaded.receiptPdf` non-null); the
      //     main `pdf` is the bill. Re-render → `receiptPdf.blobKey`
      //     (kind='receipt_combined', receipt's PINNED templateVersion); persist
      //     the new sha via `applyReceiptPdfRegeneration` (receipt_pdf_sha256) —
      //     the bill's `pdf_sha256` stays frozen.
      //   Shape 2 — as-paid path (issueEventInvoiceAsPaid TIN event): the
      //     §105ทวิ receipt IS the main `pdf` blob (`pdfDocKind='receipt_combined'`,
      //     `receiptPdf` null). Re-render → `pdf.blobKey` reproducing the stored
      //     `pdfDocKind` (so the combined receipt is never re-titled — 064 Task
      //     12); persist via `applyInvoicePdfRegeneration` (pdf_sha256).
      //
      // Re-render uses the PINNED templateVersion of whichever blob is being
      // overwritten (NOT currentTemplateVersion) so R3-E4 / FR-016 layout-
      // integrity rules hold — the annotation is additive.
      const receiptTarget =
        loaded.receiptPdf !== null
          ? {
              blobKey: loaded.receiptPdf.blobKey,
              templateVersion: loaded.receiptPdf.templateVersion,
              priorSha256: loaded.receiptPdf.sha256,
              // The separate receipt blob is always the combined §86/4+§105ทวิ
              // receipt (the §105 receipt_separate parent is blocked above).
              annotationKind: 'receipt_combined' as const,
              persist: 'receipt' as const,
            }
          : loaded.pdf !== null
            ? {
                blobKey: loaded.pdf.blobKey,
                templateVersion: loaded.pdf.templateVersion,
                priorSha256: loaded.pdf.sha256,
                // Reproduce what the main blob holds (as-paid → 'receipt_combined';
                // NULL fallback → 'invoice' matches pre-064). Never re-titles.
                annotationKind: loaded.pdfDocKind ?? 'invoice',
                persist: 'invoice' as const,
              }
            : null;
      // Unreachable under the `receiptPdfStatus==='rendered'` precondition: a
      // paid creditable row always carries the receipt in one of the two shapes.
      // Fail loud rather than silently skip the tax-document annotation.
      if (receiptTarget === null) {
        throw new IssueCreditNoteInternalError({ code: 'concurrent_state_change' });
      }

      const allCreditNotes = await deps.creditNoteRepo.findByOriginalInvoiceInTx(
        tx,
        invoiceId,
        input.tenantId,
      );
      // IM-6 — `total: Money` (not stringified satang) for uniformity with the
      // rest of PdfRenderInput's money fields. The template adapter stringifies
      // for display at render time.
      const annotationRefs = allCreditNotes
        .slice()
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber)
        .map((x) => ({
          documentNumber: x.documentNumber.raw,
          issueDate: x.issueDate,
          total: x.total,
        }));

      // Re-load tenantLogo with the TARGET blob's PINNED template version (could
      // be v1 → helper returns null → logo suppressed → bytes stay byte-
      // equivalent modulo the CREDITED overlay). MUST overwrite per Review CR-1:
      // the re-render adds the credit-annotation overlay so the sha diverges;
      // without allowOverwrite the adapter treats already-exists as success.
      const annotationTenantLogo = await loadTenantLogo(
        deps.blob,
        loaded.tenantIdentitySnapshot.logo_blob_key,
        receiptTarget.templateVersion,
      );
      pendingRenderKind = 'annotation';
      const rerendered = await renderAndUploadPdf(
        { pdfRender: deps.pdfRender, blob: deps.blob },
        {
          renderInput: {
            kind: receiptTarget.annotationKind,
            templateVersion: receiptTarget.templateVersion,
            // 088 US6 — the receipt's own number + payment date (D7), not the
            // bill's. `receiptDocNum` prefers the RC (`receiptDocumentNumberRaw`)
            // and falls back to the invoice-stream number for as-paid/legacy.
            documentNumber: receiptDocNum,
            issueDate: receiptIssueDate,
            dueDate: loaded.dueDate,
            tenant: loaded.tenantIdentitySnapshot,
            tenantLogo: annotationTenantLogo,
            member: loaded.memberIdentitySnapshot,
            lines: loaded.lines,
            subtotal: loaded.subtotal,
            vatRate: loaded.vatRate,
            vat: loaded.vat,
            total: loaded.total,
            // 054-event-fee-invoices — preserve the VAT-inclusive annotation on a
            // credited EVENT receipt (Model B). Membership carries `false`.
            vatInclusive: loaded.vatInclusive,
            // 088 US5 review fix (HIGH / FR-012) — thread the subject so the
            // tenant WHT-note gate fires IDENTICALLY on this credited receipt
            // re-render. A membership §86/4 receipt that carried the WHT note
            // would otherwise re-render WITHOUT it (gate needs invoiceSubject ===
            // 'membership') and the note-less PDF would overwrite the SAME blob +
            // sha256 — silently destroying legally-relevant tenant content.
            invoiceSubject: loaded.invoiceSubject,
            // 088 US8 review fix (HIGH / FR-025) — thread the PINNED zero-rate
            // triplet so the §80/1(5) note gate fires IDENTICALLY on this credited
            // §86/4 receipt re-render (gate: !isBill && v>=8 && vatTreatment ===
            // 'zero_rated_80_1_5'). Without it the credited re-render drops the
            // §80/1(5) legal-basis note + cert reference and the note-less PDF
            // overwrites the SAME 10y-retention tax-receipt blob + sha256 — the
            // exact twin of the WHT-note bug above. Mirrors record-payment.ts;
            // spread ONLY on a zero-rated row so a standard re-render is unchanged.
            ...(loaded.vatTreatment === 'zero_rated_80_1_5'
              ? {
                  vatTreatment: loaded.vatTreatment,
                  zeroRateCertNo: loaded.zeroRateCertNo,
                  zeroRateCertDate: loaded.zeroRateCertDate,
                }
              : {}),
            creditedAnnotation: {
              fullyCredited,
              references: annotationRefs,
            },
          },
          blobKey: receiptTarget.blobKey,
          allowOverwrite: true,
          reasonPrefix: 'annotation',
        },
        (code, reason) => new IssueCreditNoteInternalError({ code, reason }),
      );

      // Persist the re-rendered sha on the correct column: the SEPARATE receipt
      // blob (Shape 1 → receipt_pdf_sha256) or the main pdf blob (Shape 2 →
      // pdf_sha256). Both columns are whitelisted by the immutability trigger.
      try {
        if (receiptTarget.persist === 'receipt') {
          await deps.invoiceRepo.applyReceiptPdfRegeneration(tx, {
            tenantId: input.tenantId,
            invoiceId,
            receiptPdfSha256: rerendered.sha256,
          });
        } else {
          await deps.invoiceRepo.applyInvoicePdfRegeneration(tx, {
            tenantId: input.tenantId,
            invoiceId,
            pdfSha256: rerendered.sha256,
          });
        }
      } catch (e) {
        logger.error(
          { err: String(e), invoiceId, creditNoteId, persist: receiptTarget.persist },
          'issueCreditNote: tax-document pdf regeneration failed',
        );
        throw new IssueCreditNoteInternalError({ code: 'concurrent_state_change' });
      }

      // Companion audit event `invoice_pdf_regenerated` (introduced in F4
      // alongside R3-E4 / CP-5.2 Best-Practice PDF integrity — see audit-port.ts
      // doc). Captures the before/after sha256 of the RE-RENDERED tax-document
      // blob so the 10-year audit trail can reconstruct the exact document state
      // at any point. Reuses the existing event type + payload field names (no
      // new audit event type per US6 scope); the number is the §86/4 receipt
      // number (`receiptDocNum`).
      await deps.audit.emit(tx, {
        tenantId: input.tenantId,
        requestId: input.requestId ?? null,
        eventType: 'invoice_pdf_regenerated',
        actorUserId: input.actorUserId,
        summary: `Tax receipt ${receiptDocNum.raw} PDF regenerated with ${fullyCredited ? 'CREDITED' : 'PARTIALLY CREDITED'} annotation`,
        payload: {
          invoice_id: invoiceId,
          invoice_number: receiptDocNum.raw,
          original_sha256: receiptTarget.priorSha256,
          new_sha256: rerendered.sha256,
          reason: 'credit_note_annotation',
          triggered_by_credit_note_id: creditNoteId,
        },
      });

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
      const creditNoteSummary = `Credit note ${docNum.value.raw} issued against ${receiptDocNum.raw}`;
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
        // Email-locale audit 2026-07-16 — credit-note email in the member's
        // language (live read; non-member event buyer → undefined → 'en').
        const recipientLocale = await resolveRecipientLocale(
          deps.recipientLocale,
          tx,
          input.tenantId,
          memberId,
        );
        await deps.outbox.enqueue(tx, {
          tenantId: input.tenantId,
          eventType: 'credit_note_issued',
          recipientEmail: creditNoteRecipient,
          creditNoteId,
          pdfBlobKey: blobKey,
          pdfTemplateVersion: deps.currentTemplateVersion,
          ...(recipientLocale ? { recipientLocale } : {}),
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

      return ok({ creditNote: cn, emailDelivery, membershipCancellationRequested });
    });
  } catch (e) {
    // CRITICAL-1 / RR-2 — the CN insert lost the `source_refund_id` unique
    // race; the withTx above already ROLLED BACK (§87 counter-row UPDATE
    // returned to the pool → no gap). Re-read the WINNING sibling CN in a
    // FRESH tx and return it as an idempotent success — no new §87 number, no
    // new PDF, no rollup/audit/outbox side effects.
    if (e instanceof CreditNoteRefundRaceError) {
      // A.7 review fix #1 — the fresh-tx reconcile read itself must not
      // escape as a throw. This is a RARE compound-failure path (a real
      // 23505 race AND a transient failure on the fresh-tx read), and no
      // data is at risk: the DB backstop already blocked the duplicate
      // insert and `withTx`'s rollback already returned the §87
      // counter-row UPDATE to the pool (no gap). Falling through to the
      // SAME `concurrent_state_change` terminal the "sibling absent"
      // branch below already uses keeps this retry-safe and typed instead
      // of surfacing an HTTP 500.
      let reconciled: CreditNote | null;
      try {
        reconciled = await reconcileExistingCreditNote(
          deps,
          input.tenantId,
          e.sourceRefundId,
        );
      } catch (reconcileErr) {
        logger.error(
          {
            err: reconcileErr,
            tenantId: input.tenantId,
            invoiceId: input.invoiceId,
            sourceRefundId: e.sourceRefundId,
          },
          'issueCreditNote: fresh-tx reconcile read failed (transient) after source_refund_id race — returning concurrent_state_change',
        );
        return err({ code: 'concurrent_state_change' });
      }
      if (reconciled) {
        return ok({
          creditNote: reconciled,
          emailDelivery: 'not_requested',
          membershipCancellationRequested: false,
        });
      }
      // Extremely unlikely: the sibling vanished between the 23505 and the
      // fresh read (the winner rolled back AFTER our violation). Surface as
      // `concurrent_state_change` so the caller can retry cleanly.
      logger.error(
        {
          tenantId: input.tenantId,
          invoiceId: input.invoiceId,
          sourceRefundId: e.sourceRefundId,
        },
        'issueCreditNote: source_refund_id race but sibling CN absent on fresh-tx reconcile',
      );
      return err({ code: 'concurrent_state_change' });
    }
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
