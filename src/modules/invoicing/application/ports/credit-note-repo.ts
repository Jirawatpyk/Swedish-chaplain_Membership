/**
 * T078 — Credit-note repository port (F4 / US6).
 *
 * Minimal surface: `insertCreditNote` (atomic insert inside the caller's
 * transaction) + read methods for listing and detail. Status transitions
 * and `invoices.credited_total_satang` accumulation live on
 * `InvoiceRepo.applyCreditNoteRollup` so the two writes share one SQL
 * roundtrip and one commit point.
 */
import type { Satang } from '@/lib/money';
import type { CreditNote, CreditNoteId } from '@/modules/invoicing/domain/credit-note';
import type { InvoiceId } from '@/modules/invoicing/domain/invoice';
import type { Sha256Hex } from '@/modules/invoicing/domain/value-objects/sha256-hex';

export interface CreditNoteRepo {
  /**
   * Insert a new credit-note row inside the caller's transaction. Throws
   * on duplicate (document_number uniqueness violation) — the caller's
   * `withTx` rolls back, so the sequence allocation is NOT consumed.
   */
  insertCreditNote(
    tx: unknown,
    input: {
      readonly tenantId: string;
      readonly creditNoteId: CreditNoteId;
      readonly originalInvoiceId: InvoiceId;
      readonly fiscalYear: number;
      readonly sequenceNumber: number;
      readonly documentNumber: string;
      readonly issueDate: string;
      readonly issuedByUserId: string;
      readonly reason: string;
      readonly creditAmountSatang: Satang;
      readonly vatSatang: Satang;
      readonly totalSatang: Satang;
      readonly tenantIdentitySnapshot: unknown;
      readonly memberIdentitySnapshot: unknown;
      readonly pdf: {
        readonly blobKey: string;
        readonly sha256: Sha256Hex;
        readonly templateVersion: number;
      };
      /**
       * F5 extension — populates `credit_notes.source_refund_id` when
       * the CN is created by the refund flow (T013 bridge wrapper).
       * Omitted / undefined for F4-manual issues.
       */
      readonly sourceRefundId?: string;
      /**
       * M1 (plan-change-ux, Option 1b) — persists `credit_notes.retains_coverage`.
       * TRUE only for an F4-manual FULL membership credit note issued with
       * `membershipEffect: 'keep'` (paperwork correction, member NOT refunded →
       * coverage retained). FALSE for F5 real refunds, `cancel_membership`
       * withdrawals, partial credits, and event credits. Required (never
       * defaulted at the port) so the caller's intent is always explicit — the
       * use case derives it from `sourceRefundId` / `membershipEffect` /
       * full-vs-partial / subject and threads it here.
       */
      readonly retainsCoverage: boolean;
    },
  ): Promise<CreditNote>;

  /**
   * CRITICAL-1 (F5 idempotency) — find the credit note (if any) already issued
   * for a given `(tenant_id, source_refund_id)`. Transaction-scoped so it
   * participates in the caller's invoice `FOR UPDATE` lock (closing the RR-2
   * TOCTOU window) AND so a fresh-tx reconcile after a lost unique-index race
   * runs with `app.current_tenant` set on the reconcile connection (Principle I
   * — never the pool-global `db`). Returns `null` when no CN exists for this
   * refund yet. Only meaningful for refund-origin CNs (`source_refund_id` NOT
   * NULL); the partial unique index `credit_notes_source_refund_id_uniq`
   * guarantees at most one match.
   */
  findBySourceRefundId(
    tx: unknown,
    tenantId: string,
    sourceRefundId: string,
  ): Promise<CreditNote | null>;

  /** Detail lookup (no tx — used by admin detail page + PDF route). */
  findById(creditNoteId: CreditNoteId, tenantId: string): Promise<CreditNote | null>;

  /** All credit notes against a given invoice, newest first. */
  findByOriginalInvoice(
    originalInvoiceId: InvoiceId,
    tenantId: string,
  ): Promise<readonly CreditNote[]>;

  /**
   * Transaction-scoped variant of `findByOriginalInvoice`. Required by
   * `issueCreditNote` to read the complete CN list (including the just-
   * inserted row) without opening a nested `runInTenant` — that would
   * risk the same pool-exhaustion pattern we hit with
   * `tenantSettingsRepo.getForIssue` (see issue-credit-note.ts header).
   *
   * Returns rows ordered by `created_at DESC` (newest first), matching
   * `findByOriginalInvoice`. Callers needing sequence-number order
   * (e.g., the AS4 annotation template) MUST re-sort.
   */
  findByOriginalInvoiceInTx(
    tx: unknown,
    originalInvoiceId: InvoiceId,
    tenantId: string,
  ): Promise<readonly CreditNote[]>;

  /**
   * G-3 — paged tenant-scoped list for the `/admin/credit-notes`
   * directory. Supports optional `fiscalYear` filter and `search`
   * prefix/substring on `document_number`. Order: `issue_date DESC,
   * credit_note_id DESC` (stable secondary sort for deterministic
   * pagination across same-day issues).
   *
   * Each row carries a lightweight projection sufficient for the
   * list UI — avoids hydrating full snapshots / PDF metadata for
   * rows that the admin only scans.
   */
  listPaged(input: {
    readonly tenantId: string;
    readonly offset: number;
    /** Caller-supplied bound; implementations MUST clamp to 1..100. */
    readonly pageSize: number;
    readonly fiscalYear?: number;
    readonly search?: string;
  }): Promise<{
    readonly rows: readonly {
      readonly creditNoteId: string;
      readonly documentNumberRaw: string;
      readonly issueDate: string;
      readonly originalInvoiceId: string;
      readonly originalInvoiceNumberRaw: string | null;
      readonly memberLegalName: string;
      readonly totalSatang: Satang;
      readonly reason: string;
    }[];
    readonly total: number;
  }>;
}
