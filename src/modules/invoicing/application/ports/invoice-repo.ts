/**
 * T032 — Invoice repository port (F4).
 */

import type { Satang } from '@/lib/money';
import type {
  Invoice,
  InvoiceId,
  InvoiceStatus,
  InvoiceSubjectFields,
} from '@/modules/invoicing/domain/invoice';
import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';
import type { VatTreatment } from '@/modules/invoicing/domain/policies/vat-treatment';

/**
 * The identifying facts about an already-existing live membership invoice —
 * enough for an admin to recognise the document and decide whether a second
 * one is deliberate. See `InvoiceRepo.findLiveMembershipBillInTx`.
 */
export interface LiveMembershipBillView {
  readonly invoiceId: string;
  /** F4 `invoiceStatusEnum` value — never `'void'` (see the port method). */
  readonly status: InvoiceStatus;
  /**
   * The §87 sequential number, or the 088 pre-payment bill number when the
   * tax-at-payment flow issued one. Null on a draft (numbers are allocated at
   * issue), so the UI must render a "not yet numbered" affordance.
   */
  readonly documentNumber: string | null;
  /** Grand total in satang. Null on a draft (totals freeze at issue). */
  readonly totalSatang: bigint | null;
}

export interface InvoiceRepo {
  /** Run `fn` inside a serializable transaction; rollback on throw. */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /**
   * Insert a new DRAFT invoice + its lines. Returns the persisted row.
   *
   * 054-event-fee-invoices — the subject-specific identity fields
   * (`invoiceSubject` + `memberId`/`planId`/`planYear` + `eventId`/
   * `eventRegistrationId` + `vatInclusive`) are typed as the
   * {@link InvoiceSubjectFields} DISCRIMINATED UNION (re-used verbatim from
   * the Invoice read model — Application importing Domain is Clean-Architecture
   * legal). This makes an identity-incoherent construction a COMPILE error,
   * the symmetric twin of the read-model guarantee:
   *   - `'membership'` arm ⇒ member_id/plan_id/plan_year NON-NULL, event_id/
   *     event_registration_id `null`, `vatInclusive: false`.
   *   - `'event'` arm ⇒ event_id/event_registration_id NON-NULL, plan_id/
   *     plan_year `null`, member_id `string | null` (matched member or
   *     non-member buyer), `vatInclusive: boolean`.
   * `{ invoiceSubject: 'membership', eventId: 'x' }` no longer compiles — the
   * runtime `invoices_subject_fields_ck` DB CHECK is now defence-in-depth, not
   * the sole guard. The shared draft fields below stay flat.
   *
   * `memberIdentitySnapshot` (054-event-fee-invoices Task 6b — OPTIONAL):
   *   The pinned BUYER snapshot. For the MEMBERSHIP path and the MATCHED-
   *   MEMBER event path it is omitted / `null` — the buyer is an F3 member
   *   re-read and snapshotted at ISSUE time (FR-038), so the draft carries
   *   no snapshot. For a NON-MEMBER event attendee there is NO member row
   *   to re-read at issue, so the manually-entered buyer identity MUST be
   *   captured here and persisted into `member_identity_snapshot` at draft.
   *   The `invoices_enforce_immutability` trigger only locks the snapshot
   *   once `status != 'draft'`, so writing it at draft-insert is permitted.
   */
  insertDraft(
    tx: unknown,
    input: InvoiceSubjectFields & {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly draftByUserId: string;
      readonly autoEmailOnIssue: boolean | null;
      readonly memberIdentitySnapshot?: MemberIdentitySnapshot | null;
      readonly lines: readonly InvoiceLine[];
    },
  ): Promise<Invoice>;

  /**
   * Transaction-scoped load by id. Status-agnostic — returns the row
   * regardless of status (draft / issued / paid / void / credited /
   * partially_credited). Commonly called "for update" in an active tx;
   * callers that need status discrimination MUST check `.status`
   * themselves.
   *
   * Note (post-review 2026-04-19): this method is deliberately named
   * without "Draft" since both `issueInvoice` (needs a draft row),
   * `recordPayment` (needs an issued row, also fetches paid rows on
   * idempotent replay), and `updateInvoiceDraft` (needs a draft) all
   * share this loader. A future refactor MUST NOT add a
   * `WHERE status='draft'` filter here — callers depend on full-row
   * visibility.
   */
  findByIdInTx(tx: unknown, invoiceId: InvoiceId, tenantId: string): Promise<Invoice | null>;

  /**
   * Wave-4 S28 — `findByIdInTx` + row lock in ONE round-trip: the invoice
   * row is SELECTed `FOR UPDATE` (serialising concurrent issue / as-paid /
   * pay attempts exactly like `lockForUpdate`) and the full Invoice —
   * including lines — is returned from that same locked read. Returns
   * `null` when no row exists (caller emits the cross-tenant probe).
   * Status-agnostic like `findByIdInTx`; callers discriminate `.status`.
   * Callers that only need the status keep using `lockForUpdate`.
   */
  findByIdInTxForUpdate(
    tx: unknown,
    invoiceId: InvoiceId,
    tenantId: string,
  ): Promise<Invoice | null>;

  /** Generic loader used by detail / portal / signed-url paths. */
  findById(invoiceId: InvoiceId, tenantId: string): Promise<Invoice | null>;

  /**
   * 088 (duplicate-CTA) — id of the existing NON-VOID event invoice for a
   * registration, or null. Called ONLY by createEventInvoiceDraft's duplicate
   * catch to tell the client which invoice already exists. The partial unique
   * index `invoices_event_registration_uniq` excludes void rows, so at most one
   * non-void row matches. Tenant-scoped read (mirrors `findById`).
   */
  findEventInvoiceIdByRegistration(
    eventRegistrationId: string,
    tenantId: string,
  ): Promise<InvoiceId | null>;

  /**
   * The member's existing LIVE membership invoice for `planYear`, or null —
   * the `membership`-subject analogue of `findEventInvoiceIdByRegistration`
   * above, which the `event` subject has had since 088.
   *
   * "Live" = `status <> 'void'`, i.e. `draft` | `issued` | `paid` |
   * `partially_credited` | `credited` all count. `void` deliberately does
   * NOT: an invoice voided for correction has to stay freely re-issuable,
   * otherwise a mis-issued document would fence the member out of being
   * billed at all. Expressed as `ne(status,'void')` rather than an IN-list of
   * live statuses so that a future `invoiceStatusEnum` addition defaults to
   * BLOCKING (safe — ask before minting a second tax document) instead of
   * silently falling through the guard.
   *
   * Returns enough to let an admin SEE what already exists and make an
   * informed decision — id, document number, amount, status — not merely
   * "a duplicate exists". Both `documentNumber` and `totalSatang` are null on
   * a DRAFT (F4 assigns the §87 sequential number and freezes totals at
   * issue), which is itself the informative answer: `status` carries it.
   *
   * Tx-threaded (`*InTx`) because the only caller runs inside
   * `createInvoiceDraft`'s `withTx` block and must read the same snapshot it
   * is about to insert into. Mirrors `findLiveMembershipBillInTx` on the F8
   * `InvoiceDueBridge` port, which asks the identical question from the
   * renewal side — deliberately the same name and the same predicate so the
   * two read as one rule, not two.
   *
   * NOTE — why this is a guard and not a unique index. The `event` subject
   * got a partial unique index in migration 0201; `membership` deliberately
   * does not. Today "one live bill per (member, plan_year)" happens to
   * coincide with "one per membership term" only because every renewal cycle
   * in production is 12 months. Introduce a shorter-term plan and two
   * legitimate bills could share one plan year — a database constraint would
   * then be flatly wrong and need a migration to undo. So the invariant lives
   * here, where it can ASK rather than forbid: automated/renewal callers
   * refuse hard on a hit, the admin path surfaces the existing document and
   * lets a human acknowledge it.
   */
  findLiveMembershipBillInTx(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly memberId: string;
      readonly planYear: number;
    },
  ): Promise<LiveMembershipBillView | null>;

  /** List with cursor pagination. Drafts excluded by default. */
  list(
    tenantId: string,
    opts: {
      readonly cursor?: string | null | undefined;
      readonly pageSize: number;
      readonly status?: InvoiceStatus | 'all' | undefined;
      readonly fiscalYear?: number | undefined;
      readonly memberId?: string | undefined;
      readonly search?: string | undefined;
      readonly includeDrafts?: boolean | undefined;
    },
  ): Promise<{ readonly rows: readonly Invoice[]; readonly nextCursor: string | null }>;

  /**
   * Offset-based page + total count for numbered pagination (admin
   * directory). Uses the same filter shape as `list` but runs a parallel
   * COUNT(*) query so UI can render "Showing X–Y of Z" + page numbers.
   *
   * `paidOnlineOnly` (F5 US3 reconciliation) restricts to invoices with
   * at least one succeeded F5 payment row (method ∈ {card, promptpay}).
   * Implementation MUST use an EXISTS subquery — `invoices.payment_method`
   * itself is `'other'` for online payments per the F5↔F4 bridge (T012),
   * so a direct LIKE/equality filter on `payment_method` is impossible.
   */
  listPaged(
    tenantId: string,
    opts: {
      readonly offset: number;
      readonly pageSize: number;
      // 'overdue' is a DERIVED filter (issued + Bangkok-today > dueDate), not a
      // stored status — the repo translates it to the equivalent predicate
      // (S1-P1-8). All other values map to stored `invoices.status`.
      readonly status?: InvoiceStatus | 'all' | 'overdue' | undefined;
      readonly fiscalYear?: number | undefined;
      readonly memberId?: string | undefined;
      readonly search?: string | undefined;
      readonly includeDrafts?: boolean | undefined;
      readonly paidOnlineOnly?: boolean | undefined;
      // 054-event-fee-invoices — restrict to a single invoice subject.
      // Absent = all subjects (membership + event).
      readonly invoiceSubject?: 'membership' | 'event' | undefined;
      // 088 T065b (FR-031) — tax-document filters. Predicates derived from the
      // invoices schema (see drizzle-invoice-repo.listPaged). Absent = no filter.
      //   'sc' — bill_document_number_raw NOT NULL AND receipt_… IS NULL
      //   'rc' — receipt_document_number_raw NOT NULL AND NOT LIKE 'RE-%'
      //   're' — receipt_document_number_raw LIKE 'RE-%'
      //   'cn' — status IN ('credited','partially_credited')
      readonly documentType?: 'sc' | 'rc' | 're' | 'cn' | undefined;
      //   'pre_payment' — SC bill awaiting payment; 'at_payment' — receipt issued.
      readonly taxPointState?: 'pre_payment' | 'at_payment' | undefined;
      //   pinned per-invoice §80/1(5) treatment → invoices.vat_treatment = ?
      readonly vatTreatment?: 'standard' | 'zero_rated_80_1_5' | undefined;
    },
  ): Promise<{ readonly rows: readonly Invoice[]; readonly total: number }>;

  /**
   * void-on-reissue: the member's strictly-older outstanding new-flow membership
   * bills (status='issued', bill_document_number_raw NOT NULL, document_number
   * NULL, (created_at, invoice_id) < bound). Asymmetric ordering makes the newest
   * bill un-voidable → never zero survivors; exactly one for the reactivation
   * shape (older bill pre-committed), but two brand-new concurrent same-member
   * issues may leave two — closed by sub-project #2's content guard.
   */
  listSupersedableMembershipBills(
    tenantId: string,
    memberId: string,
    bound: { readonly excludeInvoiceId: string; readonly createdAt: Date; readonly invoiceId: string },
  ): Promise<ReadonlyArray<{ readonly invoiceId: string }>>;

  /** Apply post-issue UPDATE: status=issued + set snapshots + seq + document_number + pdf. */
  applyIssue(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly fiscalYear: number;
      /**
       * §87 invoice-stream numbering — legacy §86/4-at-issue path. In the 088
       * new flow (FEATURE_088_TAX_AT_PAYMENT on) both are NULL and the bill's
       * NON-§87 number rides `billDocumentNumberRaw` instead. Exactly one of
       * `{sequenceNumber+documentNumber}` / `billDocumentNumberRaw` is set — the
       * DB `invoices_non_draft_has_snapshots` CHECK enforces the invariant.
       */
      readonly sequenceNumber: number | null;
      readonly documentNumber: string | null;
      /**
       * 088 US1 — the NON-§87 `bill` number (SC), written on the new
       * tax-at-payment flow; NULL on the legacy §87-at-issue path.
       */
      readonly billDocumentNumberRaw?: string | null;
      /**
       * 088 US8 (§ F.8) — pinned per-invoice VAT treatment + MFA certificate
       * particulars. Absent/undefined → the DB `'standard'` default (VAT 7%,
       * cert fields NULL). Set to `'zero_rated_80_1_5'` + a non-null
       * `zeroRateCertNo` on an embassy / int'l-org §80/1(5) issue (the
       * `invoices_zero_rate_cert_required` CHECK enforces the pairing).
       */
      readonly vatTreatment?: VatTreatment;
      readonly zeroRateCertNo?: string | null;
      readonly zeroRateCertDate?: string | null;
      readonly zeroRateCertBlobKey?: string | null;
      readonly issueDate: string;
      readonly dueDate: string;
      readonly subtotalSatang: Satang;
      readonly vatRate: string;
      readonly vatSatang: Satang;
      readonly totalSatang: Satang;
      /**
       * 054-event-fee-invoices — NULL for `invoice_subject='event'` (pro-rating
       * is membership-only). Required (non-null) for membership invoices; the
       * relaxed `invoices_non_draft_has_snapshots` CHECK (migration 0203) enforces
       * `pro_rate_policy_snapshot IS NOT NULL OR invoice_subject='event'`.
       */
      readonly proRatePolicySnapshot: string | null;
      readonly netDaysSnapshot: number;
      readonly tenantIdentitySnapshot: unknown;
      readonly memberIdentitySnapshot: unknown;
      readonly pdf: {
        readonly blobKey: string;
        readonly sha256: Sha256Hex;
        readonly templateVersion: number;
      };
      /** 064 — what the rendered main PDF IS ('receipt_combined' never occurs at plain issue). */
      readonly pdfDocKind: 'invoice' | 'receipt_separate';
    },
  ): Promise<Invoice>;

  /** Delete draft only — enforced at use-case layer + DB check. */
  deleteDraft(tx: unknown, invoiceId: InvoiceId, tenantId: string): Promise<void>;

  /**
   * Atomic issued→paid transition + payment fields + receipt PDF metadata.
   * Single UPDATE so there is no partial-failure window. Returns the
   * refreshed Invoice row.
   */
  applyPayment(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly paymentMethod: 'bank_transfer' | 'cheque' | 'cash' | 'other';
      readonly paymentReference: string | null;
      readonly paymentNotes: string | null;
      readonly paymentRecordedByUserId: string;
      /** R7-W5 — admin-entered payment date (`YYYY-MM-DD`). */
      readonly paymentDate: string;
      /**
       * Receipt PDF state at the moment of the issued→paid transition.
       *
       * - `kind: 'rendered'` — sync path (T166 flag off, or admin
       *   manual mark-paid). Caller has already rendered the PDF +
       *   uploaded to Blob; pass through the blob key + sha256 +
       *   template version. `receipt_pdf_status` lands as `'rendered'`.
       * - `kind: 'pending'` — async path (T166-03 flag on). PDF render
       *   moves to the `receipt_pdf_render` outbox worker; this
       *   transition only stamps `receipt_pdf_status='pending'`.
       *   Worker fills blob key + sha256 + template version later via
       *   `applyReceiptPdf` (T166-05).
       *
       * Discriminated union (not just nullable receipt fields) so the
       * compiler enforces the invariant: a 'rendered' write must
       * carry the bytes; a 'pending' write must NOT.
       */
      readonly receiptPdf:
        | {
            readonly kind: 'rendered';
            readonly blobKey: string;
            readonly sha256: Sha256Hex;
            readonly templateVersion: number;
            /**
             * Receipt document number raw — persisted on BOTH sync and
             * async paths so the UI ("Receipt No." field/column) +
             * audit trail can read the number back without re-parsing
             * the PDF bytes. `null` for combined-mode (receipt reuses
             * the invoice document number).
             */
            readonly receiptDocumentNumberRaw: string | null;
          }
        | {
            readonly kind: 'pending';
            /**
             * T166 R1-C1 — pre-allocated receipt document number for
             * separate-mode tenants. The render worker MUST read this
             * field back (instead of calling `allocateNext` again) so
             * retries don't burn fresh sequence numbers and leave §87
             * gaps. `null` for combined-mode (worker reuses the
             * invoice document number).
             */
            readonly receiptDocumentNumberRaw: string | null;
          };
    },
  ): Promise<Invoice>;

  /**
   * 064 — single UPDATE draft→paid (as-paid issuance, event subject only).
   * Numbering: TIN path carries invoice-stream sequence/document numbers;
   * no-TIN β path carries NULLs + receiptDocumentNumberRaw (CHECK relax
   * shipped in migration 0212). WHERE status='draft' — 0 rows ⇒ throw
   * InvoiceApplyConflictError (concurrent issue/as-paid race loser).
   *
   * CALLER CONTRACT (mirrors issueInvoice ordering — see issue-invoice.ts:7):
   *   1. MUST hold the invoice row lock (lockForUpdate or
   *      findByIdInTxForUpdate) BEFORE sequenceAllocator.allocateNext
   *      (lock order: invoice row → §87 advisory lock; reversing deadlocks
   *      against concurrent issueInvoice).
   *   2. MUST compute money/snapshots AND pass `lines` from a draft read taken
   *      AFTER the lock, inside the same tx — the WHERE guard does not see
   *      draft-content edits. The repo builds the returned Invoice from the
   *      caller's `lines` (wave-4 S26 — no re-select; the rows are immutable
   *      under the held invoice row lock, so the post-lock read IS current).
   *   3. fiscalYear / issueDate / documentNumber / subtotal+vat=total
   *      consistency is caller-enforced; the DB does not cross-check them.
   */
  applyIssueAsPaid(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly fiscalYear: number;
      /** Post-lock draft lines — echoed into the returned Invoice (S26, no re-select). */
      readonly lines: readonly InvoiceLine[];
      readonly numbering:
        | { readonly kind: 'invoice_stream'; readonly sequenceNumber: number; readonly documentNumber: string }
        | { readonly kind: 'receipt_stream'; readonly receiptDocumentNumberRaw: string };
      readonly issueDate: string;            // = paymentDate (YYYY-MM-DD)
      readonly subtotalSatang: Satang;
      readonly vatRate: string;
      readonly vatSatang: Satang;
      readonly totalSatang: Satang;
      readonly tenantIdentitySnapshot: unknown;
      readonly memberIdentitySnapshot: unknown;
      readonly pdf: { readonly blobKey: string; readonly sha256: Sha256Hex; readonly templateVersion: number };
      readonly pdfDocKind: 'receipt_combined' | 'receipt_separate';
      readonly paymentMethod: 'bank_transfer' | 'cheque' | 'cash' | 'other';
      readonly paymentReference: string | null;
      readonly paymentNotes: string | null;
      readonly paymentRecordedByUserId: string;
      readonly paymentDate: string;          // YYYY-MM-DD (== issueDate)
    },
  ): Promise<Invoice>;

  /**
   * T166-05 — Async receipt PDF worker callback. Flips
   * `receipt_pdf_status` from 'pending' → 'rendered' atomically with
   * the blob_key + sha256 + template_version write. Idempotent: a
   * second call with status already 'rendered' is a no-op (return the
   * row unchanged). On a row in 'failed' state, this method clears
   * the failure marker and rotates back to 'rendered' so the
   * reconciliation cron retry path lands here too.
   */
  applyReceiptPdf(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly blobKey: string;
      readonly sha256: Sha256Hex;
      readonly templateVersion: number;
    },
  ): Promise<Invoice>;

  /**
   * T166-11 — Reconciliation cron callback. Flips
   * `receipt_pdf_status='failed'` + increments `render_attempts` +
   * stores `last_error`. Caller (worker / cron) is expected to
   * re-enqueue the outbox row after this write commits.
   *
   * R2-C-NEW-1 — discriminated return surfaces the rendered-race-won
   * outcome so the caller (`renderReceiptPdf` catch block) can convert
   * what looked like a failure into a success Result without bumping
   * the dispatcher's attempts counter unnecessarily. The `ne(status,
   * 'rendered')` guard inside the implementation prevents a worker B
   * success from being clobbered by a worker A failure write — when
   * that happens, this method re-fetches and returns
   * `{ kind: 'race_won_by_success', invoice }` so the caller treats
   * the operation as already-succeeded.
   */
  applyReceiptPdfFailure(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly errorMessage: string;
    },
  ): Promise<
    | { readonly kind: 'failed'; readonly invoice: Invoice }
    | { readonly kind: 'race_won_by_success'; readonly invoice: Invoice }
  >;

  /**
   * Partial field update on a DRAFT invoice. Only caller-supplied fields
   * are touched. Caller guarantees `status = 'draft'` upstream.
   */
  applyDraftUpdate(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly autoEmailOnIssue?: boolean | null | undefined;
      readonly planId?: string | undefined;
      readonly planYear?: number | undefined;
    },
  ): Promise<void>;

  /**
   * Acquire a row lock on the invoice via `SELECT … FOR UPDATE` and
   * return the current status (or `null` if no row exists). The
   * infra layer uses a raw `sql\`…FOR UPDATE\`` — Drizzle does not
   * expose a typed `.forUpdate()` modifier — but callers see a
   * typed, tenant-scoped result and never touch SQL themselves.
   */
  lockForUpdate(
    tx: unknown,
    invoiceId: InvoiceId,
    tenantId: string,
  ): Promise<InvoiceStatus | null>;

  /**
   * T078 — issue-credit-note rollup: atomically update the parent
   * invoice's `credited_total_satang` and transition its status to
   * `partially_credited` (remainder > 0) or `credited` (remainder == 0).
   * Runs inside the same transaction as the credit-note insert so both
   * writes commit together.
   *
   * The DB CHECK `invoices_credited_status_matches` doubles as a
   * defense-in-depth guard: if the caller passes an inconsistent
   * (newCreditedTotalSatang, newStatus) pair, Postgres rejects and the
   * tx rolls back.
   */
  applyCreditNoteRollup(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly newCreditedTotalSatang: Satang;
      readonly newStatus: 'partially_credited' | 'credited';
    },
  ): Promise<Invoice>;

  /**
   * Update the invoice's `pdf_sha256` in place — used by the US6 AS4
   * rollup path when the invoice PDF is re-rendered with a CREDITED /
   * PARTIALLY CREDITED annotation overlay. Blob key + templateVersion
   * stay intact (same content-addressed key; same pinned template);
   * only the stored sha256 changes to match the regenerated bytes.
   *
   * Mirrors the VOID-stamping rewrite path (FR-008) — the
   * `invoices_immutable` trigger explicitly whitelists `pdf_sha256`
   * (see schema-invoices.ts) for this reason.
   */
  applyInvoicePdfRegeneration(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly pdfSha256: Sha256Hex;
    },
  ): Promise<void>;

  /**
   * 088 US6 (T048 / § A.4 / SC-006) — update the invoice's `receipt_pdf_sha256`
   * in place when the §86/4 TAX RECEIPT PDF is re-rendered with a CREDITED /
   * PARTIALLY CREDITED annotation overlay. A §86/10 ใบลดหนี้ adjusts the tax
   * receipt (the document carrying the input VAT), NOT the now-non-tax
   * ใบแจ้งหนี้ bill — so the "record-payment path" parent (membership +
   * bill-first TIN event) whose receipt lives in a SEPARATE blob persists the
   * re-rendered bytes here, on `receipt_pdf_sha256`, leaving the bill's
   * `pdf_sha256` frozen.
   *
   * Sibling of {@link applyInvoicePdfRegeneration} (which touches `pdf_sha256`,
   * used by the as-paid Shape-2 parent whose main `pdf` blob IS the receipt).
   * Receipt blob key + templateVersion stay intact (same content-addressed key;
   * same pinned template); only the stored sha256 changes to match the
   * regenerated bytes. The `invoices_enforce_immutability` trigger does NOT lock
   * `receipt_pdf_sha256` (it locks the receipt NUMBER, migration 0235), so this
   * write is permitted on a `partially_credited` / `credited` row.
   */
  applyReceiptPdfRegeneration(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly receiptPdfSha256: Sha256Hex;
    },
  ): Promise<void>;

  /**
   * Bug 10 — void §86/4 PDF re-stamp reconcile marker. Set on a Phase-2
   * blob_upload-leg failure (COALESCE keeps the first pending timestamp). The
   * void-pdf-reconcile cron re-renders + re-uploads until the served doc carries
   * the VOID overlay. Writable on a `void` row (0234 does not freeze these).
   */
  markVoidPdfReconcilePending(
    tx: unknown,
    input: { readonly tenantId: string; readonly invoiceId: InvoiceId },
  ): Promise<void>;

  /**
   * Bug 10 — clear the reconcile marker after a successful cron re-stamp
   * (`pending_at=NULL, attempts=0, parked_at=NULL`).
   */
  clearVoidPdfReconcileMarker(
    tx: unknown,
    input: { readonly tenantId: string; readonly invoiceId: InvoiceId },
  ): Promise<void>;

  /**
   * Bug 10 — SQL-increment the reconcile attempt counter (race-safe under
   * overlapping cron ticks). Conditional on the row still being pending +
   * un-parked so an overlapping clear/park is never undone.
   */
  bumpVoidPdfReconcileAttempts(
    tx: unknown,
    input: { readonly tenantId: string; readonly invoiceId: InvoiceId },
  ): Promise<void>;

  /**
   * Bug 10 — park a reconcile row on GENUINE corruption (no snapshot / render
   * fault); reserved so transient infra failures retry indefinitely and a
   * voided tax document is never abandoned un-stamped.
   */
  parkVoidPdfReconcile(
    tx: unknown,
    input: { readonly tenantId: string; readonly invoiceId: InvoiceId },
  ): Promise<void>;
  // NOTE: the cross-tenant SCAN of actionable reconcile rows is NOT a repo
  // method — it is done inline in the void-pdf-reconcile cron route on the
  // pool-global `db` (RLS-bypass read, then per-row `runInTenant` for the
  // tenant-scoped writes), verbatim to the receipt-pdf-reconcile precedent. A
  // pool-global scan does not belong on a tenant-bound repo factory.

  /**
   * T100 / R-1 fix — US5 void transition. Atomic issued|paid → void with
   * void_reason + voided_by_user_id + voided_at. The PDF sha256 is
   * DELIBERATELY NOT written here: the blob upload happens AFTER this
   * transaction commits, so sha256 is updated in a second transaction
   * via `applyInvoicePdfRegeneration` (and, for a paid membership's separate
   * §86/4 receipt blob, `applyReceiptPdfRegeneration`) once the blob upload
   * succeeds. This ordering means a post-commit blob failure leaves a
   * stale-but-consistent state (old sha, old bytes) that a sweeper can
   * re-render.
   *
   * WHERE CAS accepts `status IN ('issued','paid')` — voiding a PAID
   * membership is the 088 § F.3 edge path (VOID-stamp BOTH the ใบแจ้งหนี้
   * bill and the §86/4 tax-receipt blobs). A concurrent transition to
   * void / credited / partially_credited returns no rows and the repo throws
   * `InvoiceApplyConflictError`, which the use case maps to typed
   * `concurrent_state_change`. The DB immutability trigger + CHECKs permit
   * paid→void (status is not a locked column; the paid-has-receipt-status
   * CHECK is vacuous for a non-paid row; the event-registration partial unique
   * index frees voided rows), so NO migration is required.
   *
   * The invoices immutability trigger whitelists `void_reason`,
   * `voided_by_user_id`, `voided_at`, `status` — see
   * `0019_invoicing_tables.sql § invoices_enforce_immutability`.
   */
  applyVoid(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly voidReason: string;
      readonly voidedByUserId: string;
    },
  ): Promise<Invoice>;
}
