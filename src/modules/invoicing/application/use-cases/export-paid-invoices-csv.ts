/**
 * Phase 3 of the F4 receipt-surface plan — CSV export of paid invoices
 * for the Thai VAT monthly-filing workflow.
 *
 * Pulls every paid receipt whose §78/1 tax point falls inside `[from, to]`
 * (both inclusive, ISO-date `YYYY-MM-DD` interpreted as Bangkok-local
 * day), plus every §86/10 credit note issued in the range, and renders the
 * bookkeeper-facing CSV (15 columns, UTF-8 BOM, RFC-4180 escaping).
 *
 * --- Same rows as the ภ.พ.30 register ----------------------------
 * Rows come from `TaxRegisterRepo.listForExport`, which buckets by the
 * register's tax point (`payment_date`, else `paid_at`) over every
 * non-void status. The export used to filter `status = 'paid'` by
 * `paidAt` in memory, so a back-dated payment landed in a different
 * month from the register and a receipt credited later dropped out
 * entirely — the CSV's VAT no longer matched the register's
 * `rcVat + reVat`. Combined-mode INV rows (no RC/RE number) are also
 * exported, on their ISSUE date — see the port doc.
 *
 * --- Credit notes as negative rows ------------------------------
 * A §86/10 credit note reduces output VAT in the month it is ISSUED. Each
 * one issued in the range follows the invoice rows with negative Subtotal /
 * VAT / Total, Status `Credit note` and the original tax invoice in
 * `Reference Document No.`, so the VAT column sums to the register's NET
 * figure (`rcVat + reVat − creditNoteVat`, the ภ.พ.30 output VAT) — the
 * repo shares the register's credit-note predicate.
 *
 * --- Cross-module port for F5 payment methods --------------------
 * `paymentMethodLookup` is a F4-owned port; the composition root
 * wires it with F5's `listSucceededPaymentMethods` so this Application
 * layer file does NOT import `@/modules/payments` directly
 * (Constitution Principle III). Invoices with no successful F5
 * payment fall back to `'manual'` (in-band cash/bank-transfer recorded
 * by an admin) — distinguishes the two reconciliation classes in the
 * bookkeeper's downstream Excel review.
 *
 * --- Audit ---------------------------------------------------------
 * Emits `invoices_csv_exported` (5y retention) on success, including
 * `row_count` (every data row) and `credit_note_count` (the negative
 * subset) so an RD audit can correlate the bookkeeper's filing
 * spreadsheet to the export action without reconstructing the byte
 * stream. Failure paths return a typed Result and DO NOT emit (the
 * caller surfaces 5xx).
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import { bangkokLocalDate, isValidCalendarDate } from '@/lib/fiscal-year';
import type { CreditNoteExportRow, TaxRegisterRepo } from '../ports/tax-register-repo';
import type { AuditPort } from '../ports/audit-port';
import { billFirstDocumentNumber, type Invoice } from '../../domain/invoice';
import { resolveCreditNoteOriginalDocuments } from '../../domain/credit-note';

// --- Input + Output ----------------------------------------------------

export const exportPaidInvoicesCsvSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .refine(isValidCalendarDate, { message: 'not a real calendar date' }),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
    .refine(isValidCalendarDate, { message: 'not a real calendar date' }),
});

export type ExportPaidInvoicesCsvInput = z.infer<
  typeof exportPaidInvoicesCsvSchema
>;

export type ExportPaidInvoicesCsvError =
  | {
      readonly code: 'invalid_range';
      /** `not_a_date` — a shape-valid but impossible date such as `2026-02-30`. */
      readonly reason: 'not_a_date' | 'inverted' | 'too_wide';
    }
  | { readonly code: 'list_failed' };

export interface ExportPaidInvoicesCsvOutput {
  readonly csv: string;
  readonly filename: string;
  /** Every data row — invoice rows plus credit-note rows. */
  readonly rowCount: number;
}

// --- Deps --------------------------------------------------------------

/**
 * F4-owned port for the F5 cross-module payment-method projection.
 * The composition root wires this with `listSucceededPaymentMethods`
 * from `@/modules/payments` so the use case stays pure-F4.
 */
export type PaymentMethodLookupPort = (
  tenantId: string,
  invoiceIds: readonly string[],
) => Promise<ReadonlyMap<string, 'card' | 'promptpay'>>;

export interface ExportPaidInvoicesCsvDeps {
  readonly registerRepo: TaxRegisterRepo;
  readonly audit: AuditPort;
  readonly paymentMethodLookup: PaymentMethodLookupPort;
}

// --- Constants ---------------------------------------------------------

const MAX_DAYS = 366; // 1 year inclusive — plan § Phase 3 validation
const CSV_HEADERS: readonly string[] = [
  'Issue Date',
  'Invoice No.',
  'Receipt No.',
  'Customer Legal Name',
  'Customer Tax ID',
  'Subtotal',
  'VAT %',
  'VAT',
  'Total',
  'Currency',
  'Paid At',
  'Payment Method',
  // The §78/1 tax point the row is bucketed by — see `taxPointDate`.
  // Appended last so existing column positions stay put; it explains why a
  // back-dated row sits in this month.
  'Tax Point Date',
  // `Paid` / `Credited` / `Partially credited`, or `Credit note` on a
  // negative §86/10 row — see `STATUS_LABEL`.
  'Status',
  // Credit-note rows only: the original tax invoice the note reduces.
  'Reference Document No.',
];

/**
 * English labels (the CSV is a bookkeeping file, not a localised page — the
 * headers are English too). `listForExport` never returns other statuses.
 */
const STATUS_LABEL: Partial<Record<Invoice['status'], string>> = {
  paid: 'Paid',
  credited: 'Credited',
  partially_credited: 'Partially credited',
};
const CREDIT_NOTE_STATUS = 'Credit note';

// --- Public use-case ---------------------------------------------------

export async function exportPaidInvoicesCsv(
  deps: ExportPaidInvoicesCsvDeps,
  input: ExportPaidInvoicesCsvInput,
): Promise<Result<ExportPaidInvoicesCsvOutput, ExportPaidInvoicesCsvError>> {
  // 1. Range validation. Zod handles shape; we own semantics.
  if (!isValidCalendarDate(input.from) || !isValidCalendarDate(input.to)) {
    return err({ code: 'invalid_range', reason: 'not_a_date' });
  }
  if (input.from > input.to) {
    return err({ code: 'invalid_range', reason: 'inverted' });
  }
  if (daysBetween(input.from, input.to) > MAX_DAYS) {
    return err({ code: 'invalid_range', reason: 'too_wide' });
  }

  // 2. The period's receipts, bucketed exactly like the register.
  // F5R3 SB-2 (2026-05-16) — wrap in try/catch so a Neon transient
  // (connection pool exhaust, RLS misconfig, etc.) returns the typed
  // `list_failed` Result.err instead of bubbling as a bare throw →
  // opaque Next.js 500 with no log/audit trail. The route layer maps
  // `code: 'list_failed'` to 500 + `logger.error`.
  let inRange: readonly Invoice[];
  let creditNotes: readonly CreditNoteExportRow[];
  try {
    const range = { from: input.from, to: input.to };
    [inRange, creditNotes] = await Promise.all([
      deps.registerRepo.listForExport(input.tenantId, range),
      deps.registerRepo.listCreditNotesForExport(input.tenantId, range),
    ]);
  } catch (e) {
    // P2 Wave-0 — the use-case RETURNS `list_failed` (does not re-throw), so the
    // route never sees `e`; without this log a Neon transient during the paid-
    // invoice scan is completely unobservable. Log the cause here, keep the
    // contractual `list_failed` Result shape unchanged (route maps it to 500).
    logger.error(
      { tenantId: input.tenantId, err: e instanceof Error ? e.message : String(e) },
      'exportPaidInvoicesCsv: paid-invoice scan failed',
    );
    return err({ code: 'list_failed' });
  }

  // 3. F5 payment-method lookup for the filtered slice only.
  const methodMap =
    inRange.length > 0
      ? await deps.paymentMethodLookup(
          input.tenantId,
          inRange.map((i) => i.invoiceId),
        )
      : new Map<string, 'card' | 'promptpay'>();

  // 4. Build CSV body. UTF-8 BOM up-front so Excel-TH renders Thai
  //    legal names without forcing the user into the Import Wizard.
  const lines: string[] = [CSV_HEADERS.map(escapeCsv).join(',')];
  for (const inv of inRange) {
    lines.push(buildRow(inv, methodMap));
  }
  for (const cn of creditNotes) {
    lines.push(buildCreditNoteRow(cn));
  }
  const csv = '﻿' + lines.join('\r\n') + '\r\n';
  const rowCount = inRange.length + creditNotes.length;

  // 5. Audit emit (best-effort but propagating per AuditPort contract —
  //    the route layer wraps for 5xx mapping; same convention as
  //    `getInvoicePdfSignedUrl` per R8-M1-code).
  // F4 AuditPort derives the 5y retention from the event type inside
  // the adapter via `f4RetentionFor` — do NOT pass `retentionYears`
  // here. See `src/modules/invoicing/infrastructure/adapters/audit-adapter.ts`.
  await deps.audit.emit(null, {
    tenantId: input.tenantId,
    requestId: input.requestId ?? null,
    eventType: 'invoices_csv_exported',
    actorUserId: input.actorUserId,
    summary: `CSV export ${input.from} → ${input.to} (${rowCount} rows, ${creditNotes.length} credit notes)`,
    payload: {
      from: input.from,
      to: input.to,
      row_count: rowCount,
      credit_note_count: creditNotes.length,
      actor_user_id: input.actorUserId,
      route: 'export-paid-invoices-csv',
    },
  });

  return ok({
    csv,
    filename: `invoices-paid-${input.from}-to-${input.to}.csv`,
    rowCount,
  });
}

// --- Helpers ----------------------------------------------------------

/**
 * RFC 4180 escape. Quotes the field when it contains `,`, `"`, `\r`,
 * `\n` — and doubles embedded `"`. Empty / `null` / `undefined` → `''`.
 */
export function escapeCsv(v: unknown): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (s === '') return '';
  if (/[",\r\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

function buildRow(
  inv: Invoice,
  methodMap: ReadonlyMap<string, 'card' | 'promptpay'>,
): string {
  const legalName = inv.memberIdentitySnapshot?.legal_name ?? '';
  const taxId = inv.memberIdentitySnapshot?.tax_id ?? '';
  const vatRatePct =
    inv.vatRate !== null ? formatVatRatePct(inv.vatRate.raw) : '';
  const subtotalStr = inv.subtotal ? formatMoney(inv.subtotal.satang) : '';
  const vatStr = inv.vat ? formatMoney(inv.vat.satang) : '';
  const totalStr = inv.total ? formatMoney(inv.total.satang) : '';
  const paidIso = inv.paidAt ?? '';
  const method = methodMap.get(inv.invoiceId) ?? 'manual';

  const cells: readonly string[] = [
    inv.issueDate ?? '',
    // 088 FR-030 — the "Invoice No." column shows an 088 bill's SC number
    // (`billDocumentNumberRaw`; §87 `documentNumber` NULL); the §86/4 RC stays
    // in the "Receipt No." column below. Legacy §87 rows keep documentNumber.
    billFirstDocumentNumber(inv) ?? '',
    inv.receiptDocumentNumberRaw ?? '',
    legalName,
    taxId,
    subtotalStr,
    vatRatePct,
    vatStr,
    totalStr,
    inv.currency,
    paidIso,
    method,
    taxPointDate(inv),
    STATUS_LABEL[inv.status] ?? inv.status,
    '',
  ];
  return cells.map(escapeCsv).join(',');
}

/**
 * A §86/10 credit note as a NEGATIVE row in the same columns: dated (and
 * bucketed) by its issue date, numbered in `Invoice No.`, with no receipt or
 * payment, and the original tax invoice — the number the credit-note PDF
 * prints — in `Reference Document No.`.
 */
function buildCreditNoteRow(cn: CreditNoteExportRow): string {
  const original = resolveCreditNoteOriginalDocuments({
    receiptDocumentNumberRaw: cn.originalReceiptDocumentNumberRaw,
    documentNumberRaw: cn.originalDocumentNumberRaw,
    billDocumentNumberRaw: cn.originalBillDocumentNumberRaw,
  });
  const cells: readonly string[] = [
    cn.issueDate,
    cn.creditNoteNumberRaw,
    '',
    cn.legalName,
    cn.taxId,
    formatMoney(-cn.creditAmountSatang),
    cn.originalVatRateRaw !== null ? formatVatRatePct(cn.originalVatRateRaw) : '',
    formatMoney(-cn.vatSatang),
    formatMoney(-cn.totalSatang),
    cn.currency,
    '',
    '',
    cn.issueDate,
    CREDIT_NOTE_STATUS,
    original.receiptNumberRaw ?? '',
  ];
  return cells.map(escapeCsv).join(',');
}

/**
 * The date that puts a row in its period, mirroring `listForExport`:
 *   - an RC/RE receipt — the payment date (`payment_date`, else the Bangkok
 *     date of `paid_at`): the tax invoice is issued at payment;
 *   - a combined-mode INV (no RC/RE) — its issue date: it was a §86/4 tax
 *     invoice at issue, which fixes the §78/1(1)(ก) tax point there.
 */
function taxPointDate(inv: Invoice): string {
  if (inv.receiptDocumentNumberRaw === null) return inv.issueDate ?? '';
  return inv.paymentDate ?? (inv.paidAt !== null ? bangkokLocalDate(inv.paidAt) : '');
}

/**
 * Satang (bigint, 1/100 THB) → `"1234.56"` two-decimal baht string.
 * Splits into integer-baht + remainder-satang to avoid float coercion
 * on values that can exceed `Number.MAX_SAFE_INTEGER` worth of satang
 * (10¹⁵ satang ≈ 10 trillion baht — rare, but the type allows it).
 */
function formatMoney(satang: bigint): string {
  const negative = satang < 0n;
  const abs = negative ? -satang : satang;
  const baht = abs / 100n;
  const remainder = abs % 100n;
  const sign = negative ? '-' : '';
  return `${sign}${baht.toString()}.${remainder.toString().padStart(2, '0')}`;
}

/**
 * VatRate stores `raw` as `"0.0700"` (4-decimal-place fraction).
 * Bookkeeper CSV expects the percentage value `"7.00"` — multiply by
 * 100, format to 2 decimals (Thai RD CSV import templates ignore
 * trailing decimal precision beyond 2dp).
 */
function formatVatRatePct(raw: string): string {
  const pct = Number(raw) * 100;
  return pct.toFixed(2);
}

/**
 * Inclusive day count between two `YYYY-MM-DD` strings (UTC-noon
 * anchor avoids DST edges). Returns 1 for same-day, 366 for a full
 * leap year inclusive.
 */
function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}
