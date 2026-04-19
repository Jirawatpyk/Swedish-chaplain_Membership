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

  /** Load a draft for update; transaction-scoped. */
  findDraftById(tx: unknown, invoiceId: InvoiceId, tenantId: string): Promise<Invoice | null>;

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
      readonly pdfBlobKey: string;
      readonly pdfSha256: Sha256Hex;
      readonly pdfTemplateVersion: number;
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
      readonly receiptPdfBlobKey: string;
      readonly receiptPdfSha256: Sha256Hex;
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
}
