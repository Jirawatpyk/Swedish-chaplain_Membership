/**
 * The Issue dialog's subtotal / VAT / total per VAT treatment — plain data the
 * server prices with the issue use case's own `computeIssuePricing`
 * (`[invoiceId]/_lib/issue-totals-by-treatment.ts`), so the dialog shows the
 * figures the issued bill pins for the treatment the admin picks.
 *
 * The summary used to show the page's standard-rate preview, so a zero-rated
 * event fee read VAT 7% and a VAT-inclusive draft read its line sum × 1.07.
 *
 * Client-safe leaf: types + a formatter, no invoicing import (the barrel's
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

/**
 * Satang → `1,234.56` (no currency). `null` → `—`.
 *
 * N11 — explicit `'en-US'` locale pins thousand-separator output on Vercel
 * runtimes whose process locale may be `C`/`POSIX` (emits no separator).
 * Thai-tax amounts are legal figures; deterministic formatting is required by
 * FR-005.
 */
export function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}
