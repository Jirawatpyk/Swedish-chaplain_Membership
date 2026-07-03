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
 * The registers. All bucket by the admin-entered PAYMENT date (`payment_date`,
 * the §78/1 VAT tax point — a Bangkok-local calendar date), falling back to the
 * server mark-paid timestamp (`paid_at`, Bangkok-local) only when a receipt row
 * has no `payment_date`, so no receipt is ever dropped. NOT the bill/issue
 * `fiscal_year` column — per the schema comment at schema-invoices.ts:100-109
 * (receipts carry their §87 fiscal year on the `{PREFIX}-{FY}-…` number, dated
 * by the payment tax point).
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
 * (VAT return). BOTH receipt streams are STANDARD-rated 7% output VAT — the
 * §86/4 vs §105 split is about document FORM, not VAT liability — so the GROSS
 * period output VAT = `rcVatSatang + reVatSatang`. Summing VAT (not sales)
 * means the §80/1(5) zero-rate subset of the RC stream contributes 0 and needs
 * no explicit exclusion.
 *
 * VOIDED (cancelled) receipts are EXCLUDED from `rcVatSatang` / `reVatSatang`:
 * per the Revenue Code a cancelled tax invoice must still be listed in the
 * sales report but its VAT must not be counted in the period total. `credited`
 * / `partially_credited` receipts STAY counted here — their reduction is a
 * §86/10 credit note, netted via `creditNoteVatSatang` (double-counting the
 * reduction would understate on the wrong side).
 *
 * `creditNoteVatSatang` is the period's §86/10 (ใบลดหนี้) VAT that REDUCES the
 * seller's output VAT in the month the credit note is ISSUED (`issue_date`).
 * The net ภ.พ.30 output VAT owed = `rcVatSatang + reVatSatang -
 * creditNoteVatSatang` (computed by the use-case).
 */
export interface PeriodOutputVatSummary {
  /**
   * §86/4 RC-stream GROSS output VAT for the period (satang decimal string),
   * EXCLUDING voided receipts.
   */
  readonly rcVatSatang: string;
  /**
   * §105 RE-stream GROSS output VAT for the period (satang decimal string),
   * EXCLUDING voided receipts.
   */
  readonly reVatSatang: string;
  /**
   * §86/10 credit-note VAT ISSUED in the period (satang decimal string) — the
   * amount to SUBTRACT from gross output VAT for the net ภ.พ.30 figure.
   */
  readonly creditNoteVatSatang: string;
}

export interface TaxRegisterRepo {
  /**
   * Return every receipt whose PAYMENT date (`payment_date` tax point, else
   * `paid_at` fallback) falls inside the inclusive Bangkok-local `[from, to]`
   * range, ordered by `receipt_document_number_raw` ASC (sequential order).
   * VOIDED (cancelled) receipts ARE returned — per the Revenue Code a cancelled
   * tax invoice must still appear in the sales report (marked cancelled). By
   * kind:
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
   * PAYMENT-date (`payment_date` tax point, else `paid_at`) range, split into
   * the §86/4 RC stream and the §105 RE stream, EXCLUDING voided receipts; plus
   * the §86/10 credit-note VAT ISSUED in the same period (`credit_notes.
   * issue_date`, to be subtracted for the net ภ.พ.30 figure). Independent of
   * the caller's selected register kind — it always covers the WHOLE period so
   * the ภ.พ.30 output-VAT figure is correct on every view. RLS-scoped via
   * `runInTenant`.
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
