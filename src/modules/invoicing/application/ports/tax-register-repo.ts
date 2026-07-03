/**
 * 088 T065b (FR-031, ภพ.30 support) — narrow port for the period-scoped tax-
 * document registers surfaced to admins for monthly VAT (ภพ.30) filing.
 *
 * Kept SEPARATE from {@link InvoiceRepo} (rather than growing that port) so the
 * ~15 hand-rolled `InvoiceRepo` mocks are unaffected — mirrors the standalone
 * `ZeroRateCertPruneRepo` pattern in this module. The Drizzle impl
 * (`makeDrizzleTaxRegisterRepo`) reuses the private row→domain mapper.
 */
import type { Invoice } from '../../domain/invoice';

/**
 * The registers. All bucket by PAYMENT date (`paid_at`, Bangkok-local) — NOT
 * the bill/issue `fiscal_year` column — per the schema comment at
 * schema-invoices.ts:100-109 (receipts carry their fiscal year on the
 * `{PREFIX}-{FY}-…` number, set at payment).
 *
 *   - 'rc_register'     — every §86/4 RC tax receipt issued in the period
 *                         (output-VAT register; excludes the §105 'RE' stream).
 *   - 'zero_rate_sales' — the §80/1(5) zero-rate subset of the RC register.
 *   - 're_register'     — every §105 'RE' receipt (no-TIN event/member sales)
 *                         issued in the period. These carry REAL 7% output VAT
 *                         (`splitVatInclusive`) so they belong in the ภ.พ.30
 *                         output-VAT figure even though their document FORM
 *                         (§105 ใบเสร็จรับเงิน) differs from the §86/4 tax
 *                         receipt. Kept as a SEPARATE register because §105 is a
 *                         distinct §87 stream (sequential, not under the §86/4
 *                         no-gaps guarantee).
 */
export type TaxRegisterKind = 'rc_register' | 'zero_rate_sales' | 're_register';

/**
 * Period output-VAT totals split by document stream, for the monthly ภ.พ.30
 * (VAT return). BOTH streams are STANDARD-rated 7% output VAT — the §86/4 vs
 * §105 split is about document FORM, not VAT liability, so the accountant's
 * period output VAT = `rcVatSatang + reVatSatang`. Summing VAT (not sales)
 * means the §80/1(5) zero-rate subset of the RC stream contributes 0 and needs
 * no explicit exclusion.
 */
export interface PeriodOutputVatSummary {
  /** §86/4 RC-stream output VAT for the period (satang decimal string). */
  readonly rcVatSatang: string;
  /** §105 RE-stream output VAT for the period (satang decimal string). */
  readonly reVatSatang: string;
}

export interface TaxRegisterRepo {
  /**
   * Return every receipt whose PAYMENT date falls inside the inclusive
   * Bangkok-local `[from, to]` range, ordered by `receipt_document_number_raw`
   * ASC (sequential order). By kind:
   *   - `rc_register` / `zero_rate_sales` → the §86/4 RC stream
   *     (`receipt_document_number_raw NOT LIKE 'RE-%'`); `zero_rate_sales`
   *     additionally restricts to `vat_treatment = 'zero_rated_80_1_5'`.
   *   - `re_register` → the §105 RE stream (`… LIKE 'RE-%'`).
   * Rows carry `lines: []` (the register never renders line items). RLS-scoped
   * via `runInTenant`.
   */
  listForPeriod(
    tenantId: string,
    opts: {
      readonly kind: TaxRegisterKind;
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly from: string;
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly to: string;
    },
  ): Promise<readonly Invoice[]>;

  /**
   * SUM of output VAT (satang) over the inclusive Bangkok-local `[from, to]`
   * PAYMENT-date range, split into the §86/4 RC stream and the §105 RE stream.
   * Independent of the caller's selected register kind — it always covers the
   * WHOLE period so the ภ.พ.30 output-VAT figure is correct on every view.
   * RLS-scoped via `runInTenant`.
   */
  sumPeriodOutputVat(
    tenantId: string,
    opts: {
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly from: string;
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly to: string;
    },
  ): Promise<PeriodOutputVatSummary>;
}
