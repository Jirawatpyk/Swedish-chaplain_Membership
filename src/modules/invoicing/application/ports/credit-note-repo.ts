/**
 * T078 — Credit-note repository port (F4 / US6).
 *
 * Minimal surface: `insertCreditNote` (atomic insert inside the caller's
 * transaction) + read methods for listing and detail. Status transitions
 * and `invoices.credited_total_satang` accumulation live on
 * `InvoiceRepo.applyCreditNoteRollup` so the two writes share one SQL
 * roundtrip and one commit point.
 */
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
      readonly creditAmountSatang: bigint;
      readonly vatSatang: bigint;
      readonly totalSatang: bigint;
      readonly tenantIdentitySnapshot: unknown;
      readonly memberIdentitySnapshot: unknown;
      readonly pdf: {
        readonly blobKey: string;
        readonly sha256: Sha256Hex;
        readonly templateVersion: number;
      };
    },
  ): Promise<CreditNote>;

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
}
