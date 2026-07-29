/**
 * Round-3 importer — PURE satang money helpers (docs/import/ROUND3_PLAN.md
 * § Invoice import; review finding R3-2, 2026-07-29).
 *
 * The sheet's Amount / Vat 7% / Total cells feed `createInvoiceDraft`'s
 * `renewalSignal.unitPriceSatang`, and the system then mints
 * `vat = round_half_away_from_zero(subtotal × 7%)` + `total = subtotal + vat`
 * (src/modules/invoicing/domain/policies/calculate-vat.ts via
 * Money.multiplyByFraction). A tolerance-based sheet guard (±0.02 / ±0.5 THB)
 * could therefore accept a row whose minted total differs from the sheet's
 * total by a few satang — a silent money divergence on a tax document. This
 * module gives the sheet reader the EXACT same arithmetic, in satang bigints:
 *
 *   - `thbToSatang` mirrors `Money.fromTHB`'s IEEE-754-safe rounding
 *     (`toFixed(2)` half-away-from-zero BEFORE the integer cast — a bare
 *     `Math.round(thb * 100)` drifts on borderline floats);
 *   - `vat7Satang(a)` = `(a*7 + 50) / 100` (bigint division truncates toward
 *     zero, so this IS half-away-from-zero) — byte-identical to
 *     `Money.multiplyByFraction(700n, 10000n)` used by `calculateVat` with the
 *     0.0700 VatRate, because (700a + 5000) div 10000 ≡ (7a + 50) div 100;
 *   - `sheetMoneyErrors` — the guard itself. A row passing it is GUARANTEED
 *     to mint byte-identical vat/total (property-tested against the real
 *     Money + calculateVat in tests/unit/scripts/import-round3-money.test.ts).
 *
 * Deliberately import-free (unit-testable without DATABASE_URL; shared by
 * finalized-sheet.ts and invoice-import-core.ts without a runtime cycle).
 */

/** THB (possibly float-noisy Excel number) → exact satang bigint.
 *  Rounds half-away-from-zero at 2 decimals, Money.fromTHB-style. Total on
 *  negative input (sign-split) — the sheet guard rejects such rows anyway. */
export function thbToSatang(thb: number): bigint {
  if (!Number.isFinite(thb)) {
    throw new Error(`thbToSatang: non-finite THB ${thb}`);
  }
  // Mirror Money.fromTHB: toFixed(2) applies half-away-from-zero at satang
  // precision BEFORE the integer cast (reviewer L5 — keeps the guard's view
  // of a cell byte-identical to what the draft use-case will receive).
  const [intPart, fracRaw = '00'] = Math.abs(thb).toFixed(2).split('.');
  const frac = (fracRaw + '00').slice(0, 2);
  const satang = BigInt(intPart!) * 100n + BigInt(frac);
  return thb < 0 ? -satang : satang;
}

/** 7% VAT in satang, rounded half-away-from-zero — byte-identical to what
 *  `calculateVat` (Money.multiplyByFraction with VatRate 0.0700) mints. */
export function vat7Satang(amountSat: bigint): bigint {
  const scaled = amountSat * 7n;
  return (scaled >= 0n ? scaled + 50n : scaled - 50n) / 100n;
}

export type SheetMoneyErrorCode = 'money_vat_not_7pct' | 'money_total_mismatch';

/**
 * Satang-EXACT sheet money guard (replaces the former ±0.02/±0.5 tolerance).
 * Empty array = the row will mint byte-identical vat + total. Violations are
 * ERRORS at the call site (blocking --commit), never warnings.
 */
export function sheetMoneyErrors(m: {
  readonly amountThb: number;
  readonly vatThb: number;
  readonly totalThb: number;
}): readonly SheetMoneyErrorCode[] {
  const amountSat = thbToSatang(m.amountThb);
  const vatSat = thbToSatang(m.vatThb);
  const totalSat = thbToSatang(m.totalThb);
  const errors: SheetMoneyErrorCode[] = [];
  if (vatSat !== vat7Satang(amountSat)) errors.push('money_vat_not_7pct');
  if (amountSat + vatSat !== totalSat) errors.push('money_total_mismatch');
  return errors;
}
