/**
 * T032 — Invoice repository port (F4).
 */

import type { Invoice, InvoiceId, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

export interface InvoiceRepo {
  /** Run `fn` inside a serializable transaction; rollback on throw. */
  withTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;

  /** Insert a new DRAFT invoice + its lines. Returns the persisted row. */
  insertDraft(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly memberId: string;
      readonly planId: string;
      readonly planYear: number;
      readonly draftByUserId: string;
      readonly autoEmailOnIssue: boolean | null;
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
   */
  listPaged(
    tenantId: string,
    opts: {
      readonly offset: number;
      readonly pageSize: number;
      readonly status?: InvoiceStatus | 'all' | undefined;
      readonly fiscalYear?: number | undefined;
      readonly memberId?: string | undefined;
      readonly search?: string | undefined;
      readonly includeDrafts?: boolean | undefined;
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
      readonly subtotalSatang: bigint;
      readonly vatRate: string;
      readonly vatSatang: bigint;
      readonly totalSatang: bigint;
      readonly proRatePolicySnapshot: string;
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
      readonly receiptPdf: {
        readonly blobKey: string;
        readonly sha256: Sha256Hex;
        readonly templateVersion: number;
      };
    },
  ): Promise<Invoice>;

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
      readonly newCreditedTotalSatang: bigint;
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
   * T100 — US5 void transition. Atomic issued → void with void_reason +
   * voided_by_user_id + voided_at + pdf_sha256 (VOID-stamped re-render).
   * WHERE guard requires `status='issued'` — a concurrent paid/void
   * race returns no rows and the repo throws `InvoiceApplyConflictError`
   * which the use case maps to typed `concurrent_state_change`.
   *
   * The invoices immutability trigger whitelists `void_reason`,
   * `voided_by_user_id`, `voided_at`, `status`, and `pdf_sha256` — see
   * `0019_invoicing_tables.sql § invoices_enforce_immutability`.
   * Blob key + template version stay the PINNED issue-time values so
   * content-addressed storage remains coherent (the re-rendered VOID
   * PDF overwrites at the SAME key per FR-008).
   */
  applyVoid(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly invoiceId: InvoiceId;
      readonly voidReason: string;
      readonly voidedByUserId: string;
      readonly pdfSha256: Sha256Hex;
    },
  ): Promise<Invoice>;
}
