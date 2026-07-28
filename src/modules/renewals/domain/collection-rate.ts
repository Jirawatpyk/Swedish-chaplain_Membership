/**
 * DV-Wave2 ⑥ — due-cohort collection-rate helper (pure Domain).
 *
 * The ONE place the "collection rate" percentage is computed, so it can never
 * drift between the server render and any future client use. Zero framework
 * imports (safe under the Domain layer), so it is fast-check-testable.
 *
 * Semantics (financial-reporting spec § 4, Task 6): a DUE-COHORT snapshot —
 * `settled / (settled + overdue)`, both legs bounded to membership invoices
 * whose `due_date` falls in the current fiscal-year-to-date window. This is
 * NOT the banned flow÷stock rate (`collected / (collected + overdue)`), which
 * resets every calendar month and can exceed 100%.
 *
 * `settled ≤ settled + overdue` always (both ≥ 0), so the result is always
 * ≤ 100 — no month-reset, no >100% artifact.
 */

/**
 * Due-cohort collection rate as a percentage in [0, 100], or `null` (render
 * as "—") when nothing has come due yet this fiscal year (denominator 0).
 *
 * Integer-safe: multiply before the single divide; the intermediate quotient
 * is ≤ 10000 so `Number()` never loses precision. e.g. settled=190000,
 * overdue=50000 → 190000·10000 / 240000 = 7916 → 79.16.
 */
export function collectionRatePct(
  settledSatang: bigint,
  overdueSatang: bigint,
): number | null {
  const denom = settledSatang + overdueSatang;
  if (denom <= 0n) return null;
  return Number((settledSatang * 10000n) / denom) / 100;
}
