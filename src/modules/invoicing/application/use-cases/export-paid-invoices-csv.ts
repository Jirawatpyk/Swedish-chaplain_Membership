/**
 * Phase 3 of the F4 receipt-surface plan — CSV export of paid invoices
 * for the Thai VAT monthly-filing workflow.
 *
 * Pulls every paid invoice whose `paidAt` falls inside `[from, to]`
 * (both inclusive, ISO-date `YYYY-MM-DD` interpreted as Bangkok-local
 * day) and renders the bookkeeper-facing CSV per the plan's column
 * schema (12 columns, UTF-8 BOM, RFC-4180 escaping).
 *
 * --- Why filter in memory ----------------------------------------
 * `listInvoicesPaged` does not currently expose a `paidAtFrom/To`
 * filter. Adding one would touch the repo SQL + 3 callers. For
 * chamber scale (~131 members × ~10 invoices/year ≈ 1.3k rows/year),
 * fetching all paid rows for the tenant and post-filtering in memory
 * costs <1MB / <50ms — well under any meaningful budget. The plan's
 * future-streaming TODO (10k+ tenants) is explicitly out-of-scope
 * here (see `.claude/plans/jolly-shimmying-sundae.md` § Risks).
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
 * `row_count` so an RD audit can correlate the bookkeeper's filing
 * spreadsheet to the export action without reconstructing the byte
 * stream. Failure paths return a typed Result and DO NOT emit (the
 * caller surfaces 5xx).
 */
import { err, ok, type Result } from '@/lib/result';
import { z } from 'zod';
import type { InvoiceRepo } from '../ports/invoice-repo';
import type { AuditPort } from '../ports/audit-port';
import type { Invoice } from '../../domain/invoice';

// --- Input + Output ----------------------------------------------------

export const exportPaidInvoicesCsvSchema = z.object({
  tenantId: z.string().min(1),
  actorUserId: z.string().min(1),
  requestId: z.string().nullable().optional(),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
});

export type ExportPaidInvoicesCsvInput = z.infer<
  typeof exportPaidInvoicesCsvSchema
>;

export type ExportPaidInvoicesCsvError =
  | { readonly code: 'invalid_range'; readonly reason: 'inverted' | 'too_wide' }
  | { readonly code: 'list_failed' };

export interface ExportPaidInvoicesCsvOutput {
  readonly csv: string;
  readonly filename: string;
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
  readonly invoiceRepo: InvoiceRepo;
  readonly audit: AuditPort;
  readonly paymentMethodLookup: PaymentMethodLookupPort;
}

// --- Constants ---------------------------------------------------------

const PAGE_SIZE = 100;
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
];

// --- Public use-case ---------------------------------------------------

export async function exportPaidInvoicesCsv(
  deps: ExportPaidInvoicesCsvDeps,
  input: ExportPaidInvoicesCsvInput,
): Promise<Result<ExportPaidInvoicesCsvOutput, ExportPaidInvoicesCsvError>> {
  // 1. Range validation. Zod handles shape; we own semantics.
  if (input.from > input.to) {
    return err({ code: 'invalid_range', reason: 'inverted' });
  }
  if (daysBetween(input.from, input.to) > MAX_DAYS) {
    return err({ code: 'invalid_range', reason: 'too_wide' });
  }

  // 2. Page through every paid invoice for the tenant + filter to range.
  // F5R3 SB-2 (2026-05-16) — wrap in try/catch so a Neon transient
  // (connection pool exhaust mid-scan, RLS misconfig, etc.) returns
  // the typed `list_failed` Result.err instead of bubbling as a bare
  // throw → opaque Next.js 500 with no log/audit trail. The route
  // layer maps `code: 'list_failed'` to 500 + `logger.error`.
  const inRange: Invoice[] = [];
  let offset = 0;
  let total = 0;
  try {
    do {
      const { rows, total: t } = await deps.invoiceRepo.listPaged(input.tenantId, {
        offset,
        pageSize: PAGE_SIZE,
        status: 'paid',
        includeDrafts: false,
      });
      total = t;
      for (const r of rows) {
        if (r.paidAt === null) continue;
        const paidYmd = paidAtToBangkokYmd(r.paidAt);
        if (paidYmd >= input.from && paidYmd <= input.to) inRange.push(r);
      }
      offset += PAGE_SIZE;
    } while (offset < total);
  } catch {
    // Constructor name preserved by the route's logger.error pattern.
    // We intentionally drop the cause object here — `list_failed` is
    // the contractual signal; the route side logs `e.constructor.name`
    // separately so we don't widen this Result.err shape with `unknown`.
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
  const csv = '﻿' + lines.join('\r\n') + '\r\n';

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
    summary: `CSV export ${input.from} → ${input.to} (${inRange.length} rows)`,
    payload: {
      from: input.from,
      to: input.to,
      row_count: inRange.length,
      actor_user_id: input.actorUserId,
      route: 'export-paid-invoices-csv',
    },
  });

  return ok({
    csv,
    filename: `invoices-paid-${input.from}-to-${input.to}.csv`,
    rowCount: inRange.length,
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
    inv.documentNumber?.raw ?? '',
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
  ];
  return cells.map(escapeCsv).join(',');
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

/**
 * Convert an `inv.paidAt` ISO timestamp to a Bangkok-local `YYYY-MM-DD`
 * for range comparison. Pure UTC offset (+07:00, no DST in TH) — avoids
 * pulling js-joda for a single boundary.
 */
function paidAtToBangkokYmd(paidAtIso: string): string {
  const ms = Date.parse(paidAtIso);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms + 7 * 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
