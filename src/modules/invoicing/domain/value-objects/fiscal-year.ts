/**
 * T026 — FiscalYear value object (F4).
 *
 * Branded number guaranteeing the calendar year is in a plausible
 * range (2000..2100) and was derived via the Bangkok-TZ helper in
 * `src/lib/fiscal-year.ts`. The Domain module imports that helper
 * directly (it is a pure timezone utility — no framework deps).
 */
import {
  deriveFiscalYear,
  type FiscalYearStartMonth,
} from '@/lib/fiscal-year';

export type FiscalYearError =
  | { kind: 'out_of_range'; value: number };

export type FiscalYear = number & { readonly __brand: 'FiscalYear' };

const MIN = 2000;
const MAX = 2100;

export function asFiscalYear(year: number): { ok: true; value: FiscalYear } | { ok: false; error: FiscalYearError } {
  if (!Number.isInteger(year) || year < MIN || year > MAX) {
    return { ok: false, error: { kind: 'out_of_range', value: year } };
  }
  return { ok: true, value: year as FiscalYear };
}

export function asFiscalYearUnsafe(year: number): FiscalYear {
  const r = asFiscalYear(year);
  if (!r.ok) throw new Error(`FiscalYear.asFiscalYearUnsafe: invalid ${year}`);
  return r.value;
}

export function fiscalYearFromUtcIso(
  utcIso: string,
  startMonth: FiscalYearStartMonth = 1,
): FiscalYear {
  return deriveFiscalYear(utcIso, startMonth) as unknown as FiscalYear;
}
