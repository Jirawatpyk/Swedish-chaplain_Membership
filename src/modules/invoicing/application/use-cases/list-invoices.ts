/**
 * T038 — list-invoices use case (F4).
 *
 * Admin invoice list with cursor pagination. Default excludes drafts
 * (admin lands on "issued+" by default — Drafts tab opt-in per R2-P2).
 *
 * RBAC: admin + manager (manager is read-only — guard at route level).
 */
import { ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { Invoice, InvoiceStatus } from '@/modules/invoicing/domain/invoice';

export const listInvoicesSchema = z.object({
  tenantId: z.string().min(1),
  cursor: z.string().nullable().optional(),
  pageSize: z.number().int().min(1).max(100).default(50),
  status: z
    .enum(['draft', 'issued', 'paid', 'void', 'credited', 'partially_credited', 'all'])
    .optional(),
  fiscalYear: z.number().int().optional(),
  memberId: z.string().uuid().optional(),
  search: z.string().optional(),
  includeDrafts: z.boolean().default(false),
});

export type ListInvoicesInput = z.infer<typeof listInvoicesSchema>;

export interface ListInvoicesOutput {
  readonly rows: readonly Invoice[];
  readonly nextCursor: string | null;
}

export type ListInvoicesError = never;

export interface ListInvoicesDeps {
  readonly invoiceRepo: InvoiceRepo;
}

export async function listInvoices(
  deps: ListInvoicesDeps,
  input: ListInvoicesInput,
): Promise<Result<ListInvoicesOutput, ListInvoicesError>> {
  const { rows, nextCursor } = await deps.invoiceRepo.list(input.tenantId, {
    cursor: input.cursor ?? null,
    pageSize: input.pageSize,
    status: (input.status as InvoiceStatus | 'all' | undefined) ?? undefined,
    fiscalYear: input.fiscalYear,
    memberId: input.memberId,
    search: input.search,
    includeDrafts: input.includeDrafts,
  });
  return ok({ rows, nextCursor });
}

export const listInvoicesPagedSchema = z.object({
  tenantId: z.string().min(1),
  offset: z.number().int().min(0).default(0),
  pageSize: z.number().int().min(1).max(100).default(50),
  status: z
    .enum(['draft', 'issued', 'paid', 'void', 'credited', 'partially_credited', 'all'])
    .optional(),
  fiscalYear: z.number().int().optional(),
  memberId: z.string().uuid().optional(),
  search: z.string().optional(),
  includeDrafts: z.boolean().default(false),
});

export type ListInvoicesPagedInput = z.infer<typeof listInvoicesPagedSchema>;

export interface ListInvoicesPagedOutput {
  readonly rows: readonly Invoice[];
  readonly total: number;
}

export async function listInvoicesPaged(
  deps: ListInvoicesDeps,
  input: ListInvoicesPagedInput,
): Promise<Result<ListInvoicesPagedOutput, never>> {
  const { rows, total } = await deps.invoiceRepo.listPaged(input.tenantId, {
    offset: input.offset,
    pageSize: input.pageSize,
    status: (input.status as InvoiceStatus | 'all' | undefined) ?? undefined,
    fiscalYear: input.fiscalYear,
    memberId: input.memberId,
    search: input.search,
    includeDrafts: input.includeDrafts,
  });
  return ok({ rows, total });
}
