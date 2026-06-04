/**
 * T032 — Invoice repository port (F4).
 */

import type { Satang } from '@/lib/money';
import type { Invoice, InvoiceId, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { MemberIdentitySnapshot } from '@/modules/invoicing/domain/value-objects/member-identity-snapshot';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

export interface InvoiceRepo {
  /** Run `fn` inside a serializable transaction; rollback on throw. */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /**
   * Insert a new DRAFT invoice + its lines. Returns the persisted row.
   *
   * 054-event-fee-invoices — `memberId`/`planId`/`planYear` are nullable
   * (membership invoices set them; event invoices pass null) and the
   * subject discriminator + event linkage + VAT-inclusive flag are
   * required. The `invoices_subject_fields_ck` DB CHECK rejects an
   * identity-incoherent combination (e.g. subject='event' with no
   * event_registration_id), so callers MUST pass a consistent shape.
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
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly memberId: string | null;
      readonly planId: string | null;
      readonly planYear: number | null;
      readonly invoiceSubject: 'membership' | 'event';
      readonly eventId: string | null;
      readonly eventRegistrationId: string | null;
      readonly vatInclusive: boolean;
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

  /** Generic loader used by detail / portal / signed-url paths. */
  findById(invoiceId: InvoiceId, tenantId: string): Promise<Invoice | null>;

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
    },
  ): Promise<{ readonly rows: readonly Invoice[]; readonly total: number }>;

  /** Apply post-issue UPDATE: status=issued + set snapshots + seq + document_number + pdf. */
  applyIssue(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly fiscalYear: number;
      readonly sequenceNumber: number;
      readonly documentNumber: string;
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
   * T100 / R-1 fix — US5 void transition. Atomic issued → void with
   * void_reason + voided_by_user_id + voided_at. The PDF sha256 is
   * DELIBERATELY NOT written here: the blob upload happens AFTER this
   * transaction commits, so sha256 is updated in a second transaction
   * via `applyInvoicePdfRegeneration` once the blob upload succeeds.
   * This ordering means a post-commit blob failure leaves a stale-but-
   * consistent state (old sha, old bytes) that a sweeper can re-render.
   *
   * WHERE guard requires `status='issued'` — a concurrent paid/void
   * race returns no rows and the repo throws `InvoiceApplyConflictError`
   * which the use case maps to typed `concurrent_state_change`.
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
