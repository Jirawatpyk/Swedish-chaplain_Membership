/**
 * list-invoices-by-member — US7 AS1.
 *
 * Includes drafts + all statuses by default so the member detail page
 * renders the full billing history. Tenant-isolation relies on the
 * underlying Drizzle repo running inside `runInTenant` with RLS +
 * `SET LOCAL app.current_tenant` — defense-in-depth over the
 * `tenantId` filter passed explicitly here.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { Invoice, InvoiceStatus } from '../../domain/invoice';

export const listInvoicesByMemberSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  pageSize: z.number().int().min(1).max(200).default(100),
  offset: z.number().int().min(0).default(0),
  status: z
    .enum(['draft', 'issued', 'paid', 'void', 'credited', 'partially_credited', 'all'])
    .optional(),
  /**
   * G-U7F — fiscal-year filter (US7 AS1 "filterable by … year").
   * Port already supports it; this exposes it at the Application
   * boundary for the member-page filter UI.
   */
  fiscalYear: z.number().int().min(2020).max(2100).optional(),
  /**
   * Document-number substring search (ILIKE %q%). Matches the
   * credit-notes directory pattern so the two related billing
   * surfaces share UX.
   */
  search: z.string().trim().min(1).max(64).optional(),
});

export type ListInvoicesByMemberInput = z.infer<typeof listInvoicesByMemberSchema>;

export interface ListInvoicesByMemberOutput {
  readonly rows: readonly Invoice[];
  readonly total: number;
}

export type ListInvoicesByMemberError = {
  readonly type: 'repo_error';
  readonly cause: unknown;
};

export interface ListInvoicesByMemberDeps {
  readonly invoiceRepo: InvoiceRepo;
}

export async function listInvoicesByMember(
  deps: ListInvoicesByMemberDeps,
  input: ListInvoicesByMemberInput,
): Promise<Result<ListInvoicesByMemberOutput, ListInvoicesByMemberError>> {
  try {
    const { rows, total } = await deps.invoiceRepo.listPaged(input.tenantId, {
      offset: input.offset,
      pageSize: input.pageSize,
      memberId: input.memberId,
      status: (input.status as InvoiceStatus | 'all' | undefined) ?? 'all',
      includeDrafts: true,
      ...(input.fiscalYear !== undefined ? { fiscalYear: input.fiscalYear } : {}),
      ...(input.search ? { search: input.search } : {}),
    });
    return ok({ rows, total });
  } catch (cause) {
    return err({ type: 'repo_error', cause });
  }
}
