/**
 * The Issue dialog's subtotal / VAT / total per VAT treatment — plain data the
 * server prices with the issue use case's own `computeIssuePricing`
 * (`[invoiceId]/_lib/issue-totals-by-treatment.ts`), so the dialog shows the
 * figures the issued bill pins for the treatment the admin picks.
 *
 * The summary used to show the page's standard-rate preview, so a zero-rated
 * event fee read VAT 7% and a VAT-inclusive draft read its line sum × 1.07.
 *
 * Client-safe leaf: types only, no invoicing import (the barrel's
 * runtime graph is server-only, and deep imports are guarded by
 * `tests/unit/architecture/invoicing-presentation-imports.test.ts`).
 */
import type { VatTreatmentChoice } from './issue-vat-treatment';

/** Satang as plain numbers — a bigint cannot cross the RSC → client boundary. */
export type IssueTotals = {
  readonly subtotalSatang: number;
  readonly vatSatang: number;
  readonly totalSatang: number;
  /** The applied rate, e.g. `'7.00%'`, or `'0.00%'` when zero-rated. */
  readonly vatPercent: string;
};

export type IssueTotalsByTreatment = Readonly<Record<VatTreatmentChoice, IssueTotals>>;

