/**
 * G-3 — listCreditNotes use case (F4 / admin CN directory).
 *
 * Admin-only tenant-scoped paged list for `/admin/credit-notes`.
 * Used by the staff directory page to answer "show me every credit
 * note issued by this tenant" — supports fiscal-year filter +
 * doc-number search. Thin wrapper over `creditNoteRepo.listPaged`
 * so the port contract stays narrow; the use-case exists to:
 *   1. Validate + clamp input at the Application boundary
 *   2. Provide a stable typed output shape that a future audit /
 *      export surface can share without reaching into infra
 *   3. Make the list callable from server components via a typed
 *      `Result<T, E>` surface rather than a raw repo import
 *
 * RBAC: the route handler guards admin-only / manager-readonly. No
 * actor context required here — tenant isolation is enforced by
 * `runInTenant` at the repo layer.
 */
import { err, ok, type Result } from '@/lib/result';
import type { CreditNoteRepo } from '../ports/credit-note-repo';

export interface ListCreditNotesInput {
  readonly tenantId: string;
  readonly offset: number;
  readonly pageSize: number;
  /** Optional fiscal-year filter (e.g. 2026). */
  readonly fiscalYear?: number;
  /** Optional substring match on document_number (case-insensitive). */
  readonly search?: string;
}

export interface ListCreditNotesRow {
  readonly creditNoteId: string;
  readonly documentNumberRaw: string;
  readonly issueDate: string;
  readonly originalInvoiceId: string;
  readonly originalInvoiceNumberRaw: string | null;
  readonly memberLegalName: string;
  readonly totalSatang: string;
  readonly reason: string;
}

export interface ListCreditNotesOutput {
  readonly rows: readonly ListCreditNotesRow[];
  readonly total: number;
}

export type ListCreditNotesError =
  | { readonly code: 'invalid_input'; readonly field: string };

export interface ListCreditNotesDeps {
  readonly creditNoteRepo: Pick<CreditNoteRepo, 'listPaged'>;
}

export async function listCreditNotes(
  deps: ListCreditNotesDeps,
  input: ListCreditNotesInput,
): Promise<Result<ListCreditNotesOutput, ListCreditNotesError>> {
  if (!input.tenantId || input.tenantId.length === 0) {
    return err({ code: 'invalid_input', field: 'tenantId' });
  }
  if (!Number.isFinite(input.offset) || input.offset < 0) {
    return err({ code: 'invalid_input', field: 'offset' });
  }
  if (!Number.isFinite(input.pageSize) || input.pageSize < 1) {
    return err({ code: 'invalid_input', field: 'pageSize' });
  }

  const repoResult = await deps.creditNoteRepo.listPaged({
    tenantId: input.tenantId,
    offset: input.offset,
    pageSize: input.pageSize,
    ...(input.fiscalYear !== undefined ? { fiscalYear: input.fiscalYear } : {}),
    ...(input.search !== undefined ? { search: input.search } : {}),
  });

  // BigInt → string at the Application boundary so the result can be
  // serialised to the server component without JSON.stringify
  // throwing on native bigints.
  const rows: ListCreditNotesRow[] = repoResult.rows.map((r) => ({
    creditNoteId: r.creditNoteId,
    documentNumberRaw: r.documentNumberRaw,
    issueDate: r.issueDate,
    originalInvoiceId: r.originalInvoiceId,
    originalInvoiceNumberRaw: r.originalInvoiceNumberRaw,
    memberLegalName: r.memberLegalName,
    totalSatang: r.totalSatang.toString(),
    reason: r.reason,
  }));

  return ok({ rows, total: repoResult.total });
}
