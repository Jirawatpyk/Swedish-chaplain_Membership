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
  /**
   * COMBINED-mode tax invoices ISSUED in the period — rows whose §87 INV number
   * is the §86/4 tax invoice (no RC/RE, no SC bill): before the tax-at-payment
   * switch, or on a tenant with it off. Every non-void, non-draft one counts,
   * paid or not — a tax invoice issued before payment has its §78/1(1)(ก) tax
   * point at issue. They are outside both register streams, so a non-zero
   * count means the net figure is not the whole period.
   */
  readonly legacyCombinedCount: number;
}

/**
 * One §86/10 credit note for the CSV export — a narrow projection (no PDF or
 * line hydration) joined to the invoice it reduces, so the use-case can name
 * the original tax invoice (`resolveCreditNoteOriginalDocuments`) and its VAT
 * rate. Amounts are the positive stored values; the export negates them.
 */
export interface CreditNoteExportRow {
  readonly creditNoteNumberRaw: string;
  /** `YYYY-MM-DD` — the month the note reduces output VAT in. */
  readonly issueDate: string;
  /** From the credit note's own member snapshot. */
  readonly legalName: string;
  readonly taxId: string;
  readonly creditAmountSatang: bigint;
  readonly vatSatang: bigint;
  readonly totalSatang: bigint;
  /** The original invoice's currency (`THB` when the join finds no row). */
  readonly currency: string;
  readonly originalReceiptDocumentNumberRaw: string | null;
  readonly originalDocumentNumberRaw: string | null;
  readonly originalBillDocumentNumberRaw: string | null;
  /** The original invoice's `vat_rate_snapshot`, e.g. `"0.0700"`. */
  readonly originalVatRateRaw: string | null;
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

  /**
   * The rows the paid-invoices CSV export writes for the inclusive Bangkok-
   * local `[from, to]` range, bucketed by the SAME tax point as the registers
   * (`payment_date`, else `paid_at`), so the CSV of a month always reconciles
   * to that month's register:
   *   - every NON-VOID receipt that {@link sumPeriodOutputVat} counts — the
   *     §86/4 RC and §105 RE streams, whatever the status (`credited` /
   *     `partially_credited` included: their reduction is a §86/10 credit
   *     note in the month the note is issued, not a missing sale);
   *   - plus PAID combined-mode tax invoices (the §87 INV number is the
   *     §86/4 tax invoice; no RC/RE — before the tax-at-payment switch, or on
   *     a tenant with `FEATURE_088_TAX_AT_PAYMENT` off) ISSUED in the period:
   *     their tax point is the issue date (§78/1(1)(ก)). The registers never
   *     list them; `sumPeriodOutputVat.legacyCombinedCount` counts them (plus
   *     any still unpaid).
   * Ordered by each row's tax point, then receipt / invoice number. Rows carry
   * `lines: []`. RLS-scoped via `runInTenant`.
   */
  listForExport(
    tenantId: string,
    opts: {
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly from: string;
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly to: string;
    },
  ): Promise<readonly Invoice[]>;

  /**
   * Every §86/10 credit note ISSUED in the inclusive `[from, to]` range — the
   * SAME predicate as {@link sumPeriodOutputVat}'s `creditNoteVatSatang`, so
   * the CSV's negative rows sum to exactly that figure. Ordered by issue date,
   * then credit-note number. RLS-scoped via `runInTenant`.
   */
  listCreditNotesForExport(
    tenantId: string,
    opts: {
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly from: string;
      /** Inclusive `YYYY-MM-DD` Bangkok-local. */
      readonly to: string;
    },
  ): Promise<readonly CreditNoteExportRow[]>;
}
