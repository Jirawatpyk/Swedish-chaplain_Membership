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
    .enum([
      'draft',
      'issued',
      'paid',
      'void',
      'credited',
      'partially_credited',
      'all',
      // S1-P1-8: derived filter — repo translates to issued + past-due.
      'overdue',
    ])
    .optional(),
  fiscalYear: z.number().int().optional(),
  memberId: z.string().uuid().optional(),
  search: z.string().optional(),
  includeDrafts: z.boolean().default(false),
  paidOnlineOnly: z.boolean().optional(),
  // 054-event-fee-invoices — subject discriminator filter. Absent = all
  // subjects; 'membership'/'event' restrict to that invoice kind.
  invoiceSubject: z.enum(['membership', 'event']).optional(),
  // 088 T065b (FR-031, ภพ.30 support) — three ADMIN-only tax-document filters
  // (gated on FEATURE_088_TAX_AT_PAYMENT at the page; the member portal never
  // threads them). Absent = no restriction. Mapping is derived from the
  // invoices schema (see drizzle-invoice-repo.listPaged + the T065b report):
  //   - documentType 'sc' — unpaid 088 bill (ใบแจ้งหนี้): bill number present,
  //                         no §86/4 receipt yet.
  //   - documentType 'rc' — §86/4 tax receipt (receipt number, NOT the §105 'RE'
  //                         register).
  //   - documentType 're' — §105 legacy/event-no-TIN receipt ('RE' register).
  //   - documentType 'cn' — invoices carrying a credit note (credited /
  //                         partially_credited). The invoice LIST cannot render
  //                         credit-note ROWS (separate table); a full ใบลดหนี้
  //                         register is follow-on — this is a cross-reference.
  documentType: z.enum(['sc', 'rc', 're', 'cn']).optional(),
  //   - taxPointState 'pre_payment' — bill awaiting payment (tax point not yet
  //                         reached under the 088 tax-at-payment model).
  //   - taxPointState 'at_payment'  — a §86/4/§105 receipt has been issued (tax
  //                         point reached).
  taxPointState: z.enum(['pre_payment', 'at_payment']).optional(),
  //   - vatTreatment 'standard' | 'zero_rated_80_1_5' — the pinned per-invoice
  //                         §80/1(5) treatment (drives the VAT rate, FR-025).
  vatTreatment: z.enum(['standard', 'zero_rated_80_1_5']).optional(),
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
    status:
      (input.status as InvoiceStatus | 'all' | 'overdue' | undefined) ??
      undefined,
    fiscalYear: input.fiscalYear,
    memberId: input.memberId,
    search: input.search,
    includeDrafts: input.includeDrafts,
    paidOnlineOnly: input.paidOnlineOnly,
    invoiceSubject: input.invoiceSubject,
    documentType: input.documentType,
    taxPointState: input.taxPointState,
    vatTreatment: input.vatTreatment,
  });
  return ok({ rows, total });
}
