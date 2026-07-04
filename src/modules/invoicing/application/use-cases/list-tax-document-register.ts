/**
 * 088 T065b (FR-031, ภ.พ.30 support) — period-scoped tax-document registers for
 * monthly VAT (ภ.พ.30) filing, surfaced to admins alongside the invoice list.
 *
 * Three registers (see {@link TaxRegisterKind}):
 *   - 'rc_register'     — the §86/4 RC tax receipts issued AT PAYMENT in the
 *                         period (output-VAT register), ordered by RC number.
 *   - 'zero_rate_sales' — the §80/1(5) zero-rate subset of that register.
 *   - 're_register'     — the §105 'RE' receipts (no-TIN event/member sales) in
 *                         the period. These carry REAL 7% output VAT.
 *
 * Bucketed by the §78/1 PAYMENT-date tax point (`payment_date`, the admin-
 * entered Bangkok-local calendar date; falls back to `paid_at` only when a
 * receipt has no `payment_date`), reusing the period precedent of
 * `export-paid-invoices-csv` (which already names ภ.พ.30). This use-case is a
 * READ (no audit emit — mirrors `list-invoices`; the CSV export audits because
 * it materialises a downloadable file).
 *
 * 088 B2 review FINDING 1 — every response ALSO carries {@link PeriodOutputVat}:
 * the NET period ภ.พ.30 output-VAT figure, computed over the WHOLE period
 * independent of the selected `kind`:
 *   combined = §86/4 RC + §105 RE (both standard-rated 7%, VOIDED receipts
 *   excluded) − §86/10 credit notes issued in the period.
 * Both receipt forms owe the same output VAT, so an accountant reading any
 * register still sees the CORRECT total — excluding §105 would understate the
 * liability; ignoring credit notes would overstate it.
 */
import { err, ok, type Result } from '@/lib/result';
import { logger } from '@/lib/logger';
import { z } from 'zod';
import type { Invoice } from '../../domain/invoice';
import type { TaxRegisterRepo } from '../ports/tax-register-repo';

export const listTaxDocumentRegisterSchema = z.object({
  tenantId: z.string().min(1),
  kind: z.enum(['rc_register', 'zero_rate_sales', 're_register']),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
  /** Inclusive `YYYY-MM-DD` Bangkok-local. */
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD'),
});

export type ListTaxDocumentRegisterInput = z.infer<
  typeof listTaxDocumentRegisterSchema
>;

export type ListTaxDocumentRegisterError =
  | { readonly code: 'invalid_range'; readonly reason: 'inverted' | 'too_wide' }
  | { readonly code: 'list_failed' };

export interface TaxDocumentRegisterSummary {
  readonly rowCount: number;
  /** Sums as satang decimal strings (bigint-safe; the UI formats to baht). */
  readonly totalSubtotalSatang: string;
  readonly totalVatSatang: string;
  readonly totalSatang: string;
}

/**
 * The period ภ.พ.30 output-VAT figure — CORRECT and OBTAINABLE on every
 * register view (not just `rc_register`). `combinedVatSatang` is the NET
 * standard-rated output VAT the seller owes for the period:
 *
 *   combined = rcVatSatang + reVatSatang − creditNoteVatSatang
 *
 * i.e. gross §86/4 (RC) + §105 (RE) receipt VAT, LESS the §86/10 credit-note
 * (ใบลดหนี้) VAT issued in the period. The §80/1(5) zero-rate rows fold into
 * `rcVatSatang` with a 0 contribution (summed from VAT, not sales), so no
 * explicit exclusion is needed. VOIDED (cancelled) receipts are excluded from
 * `rcVatSatang` / `reVatSatang` at the repo. `combinedVatSatang` MAY be
 * negative in a period where credit notes exceed new receipt VAT (a legitimate
 * ภ.พ.30 net credit) — the figure is a plain subtraction, never clamped. All
 * values are satang decimal strings.
 */
export interface PeriodOutputVat {
  readonly rcVatSatang: string;
  readonly reVatSatang: string;
  /** §86/10 credit-note VAT issued in the period (subtracted into `combined`). */
  readonly creditNoteVatSatang: string;
  readonly combinedVatSatang: string;
}

export interface ListTaxDocumentRegisterOutput {
  readonly rows: readonly Invoice[];
  readonly summary: TaxDocumentRegisterSummary;
  readonly periodOutputVat: PeriodOutputVat;
}

export interface ListTaxDocumentRegisterDeps {
  readonly registerRepo: TaxRegisterRepo;
}

/** Inclusive-day cap — 1 year (matches export-paid-invoices-csv). */
const MAX_DAYS = 366;

export async function listTaxDocumentRegister(
  deps: ListTaxDocumentRegisterDeps,
  input: ListTaxDocumentRegisterInput,
): Promise<Result<ListTaxDocumentRegisterOutput, ListTaxDocumentRegisterError>> {
  // Range semantics (zod owns shape).
  if (input.from > input.to) {
    return err({ code: 'invalid_range', reason: 'inverted' });
  }
  if (daysBetween(input.from, input.to) > MAX_DAYS) {
    return err({ code: 'invalid_range', reason: 'too_wide' });
  }

  let rows: readonly Invoice[];
  let outputVat: {
    rcVatSatang: string;
    reVatSatang: string;
    creditNoteVatSatang: string;
  };
  try {
    // The selected register's rows + the WHOLE-period output-VAT figure. The
    // latter is independent of `kind` so the ภ.พ.30 total is correct on every
    // view (§86/4 RC + §105 RE) — see FINDING 1.
    [rows, outputVat] = await Promise.all([
      deps.registerRepo.listForPeriod(input.tenantId, {
        kind: input.kind,
        from: input.from,
        to: input.to,
      }),
      deps.registerRepo.sumPeriodOutputVat(input.tenantId, {
        from: input.from,
        to: input.to,
      }),
    ]);
  } catch (e) {
    // Error-audit (whole-feature review) — this catch now guards TWO DB queries
    // (the register rows + the period output-VAT aggregate: RC + RE gross VAT
    // netted by §86/10 credit-note VAT); a failure on
    // the legally-significant ภ.พ.30 surface MUST be diagnosable (RLS/tenant-GUC
    // misconfig, column/type drift after a migration, Neon transient). Log
    // before degrading to the typed error, matching the sibling use-cases
    // (export-paid-invoices-csv, the signed-url readers).
    logger.error(
      {
        err: e,
        tenantId: input.tenantId,
        kind: input.kind,
        from: input.from,
        to: input.to,
      },
      'listTaxDocumentRegister: period register query failed',
    );
    return err({ code: 'list_failed' });
  }

  // Displayed money TOTALS exclude VOIDED (cancelled) receipts so they match
  // the period output-VAT figure (which also excludes void). `rowCount` counts
  // ALL listed rows including void — a cancelled receipt is still SHOWN in the
  // register (marked cancelled) per the Revenue Code, just not summed.
  let subtotal = 0n;
  let vat = 0n;
  let total = 0n;
  for (const r of rows) {
    if (r.status === 'void') continue;
    subtotal += r.subtotal?.satang ?? 0n;
    vat += r.vat?.satang ?? 0n;
    total += r.total?.satang ?? 0n;
  }

  // Net ภ.พ.30 output VAT = gross RC + gross RE − §86/10 credit notes issued in
  // the period. A plain subtraction (never clamped): a net credit is a valid
  // ภ.พ.30 outcome when credit notes exceed new receipt VAT in the month.
  const combinedVat =
    BigInt(outputVat.rcVatSatang) +
    BigInt(outputVat.reVatSatang) -
    BigInt(outputVat.creditNoteVatSatang);

  return ok({
    rows,
    summary: {
      rowCount: rows.length,
      totalSubtotalSatang: subtotal.toString(),
      totalVatSatang: vat.toString(),
      totalSatang: total.toString(),
    },
    periodOutputVat: {
      rcVatSatang: outputVat.rcVatSatang,
      reVatSatang: outputVat.reVatSatang,
      creditNoteVatSatang: outputVat.creditNoteVatSatang,
      combinedVatSatang: combinedVat.toString(),
    },
  });
}

/**
 * Inclusive day count between two `YYYY-MM-DD` strings (UTC-noon anchor avoids
 * DST edges). 1 for same-day, 366 for a full leap year inclusive.
 */
function daysBetween(fromYmd: string, toYmd: string): number {
  const from = Date.parse(`${fromYmd}T12:00:00Z`);
  const to = Date.parse(`${toYmd}T12:00:00Z`);
  return Math.round((to - from) / 86_400_000) + 1;
}
