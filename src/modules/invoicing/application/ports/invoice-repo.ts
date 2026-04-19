/**
 * T032 — Invoice repository port (F4).
 */

import type { Invoice, InvoiceId, InvoiceStatus } from '@/modules/invoicing/domain/invoice';
import type { InvoiceLine } from '@/modules/invoicing/domain/invoice-line';

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
      readonly pdfSha256: string;
      readonly pdfTemplateVersion: number;
    },
  ): Promise<Invoice>;

  /** Delete draft only — enforced at use-case layer + DB check. */
  deleteDraft(tx: unknown, invoiceId: InvoiceId, tenantId: string): Promise<void>;
}
