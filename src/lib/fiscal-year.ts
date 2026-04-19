/**
 * T006 — Fiscal-year boundary derivation (F4).
 *
 * Derives the fiscal year (FY) a UTC timestamp falls into for a given
 * tenant, correctly handling the Bangkok timezone boundary + tenant
 * `fiscal_year_start_month` configuration.
 *
 * Why `@js-joda/timezone` (not raw `Date` / `Intl.DateTimeFormat`):
 *   - Immutable `ZonedDateTime` with total-ordering.
 *   - DST-correct and clock-skew-resilient (Asia/Bangkok has no DST, but
 *     the allocator must still convert from UTC to wall-clock Bangkok
 *     time before deciding FY — raw `Date` is full of subtle pitfalls).
 *   - Exhaustive timezone data pinned by a dependency, not the OS.
 *
 * Used by:
 *   - `src/modules/invoicing/domain/value-objects/fiscal-year.ts`
 *     (Domain imports FROM here — this is a leaf util with no
 *     Domain-forbidden dependencies.)
 *   - `SequentialNumberAllocator` (infrastructure) to tag a new
 *     invoice/credit-note with the correct FY at issue time.
 *
 * Convention: FY `n` starts on the 1st day of
 * `fiscal_year_start_month` of calendar year `n` in Asia/Bangkok wall
 * time. For SweCham, start month = 1 (January), so FY == CE year.
 * Other tenants (e.g. April-start fiscal year) are supported by passing
 * a different `startMonth`.
 */

import '@js-joda/timezone';
import { Instant, LocalDate, ZoneId, ZonedDateTime } from '@js-joda/core';

export const BANGKOK_ZONE: ZoneId = ZoneId.of('Asia/Bangkok');

export type FiscalYearStartMonth = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12;

export type FiscalYear = number & { readonly __brand: 'FiscalYear' };

/**
 * Derive the fiscal year a UTC ISO timestamp falls into.
 *
 * @param utcIso ISO-8601 UTC timestamp (e.g. from DB `now()` or
 *   request-time clock).
 * @param startMonth Tenant's fiscal-year start month (1-12). 1 = CE year.
 */
export function deriveFiscalYear(
  utcIso: string,
  startMonth: FiscalYearStartMonth = 1,
): FiscalYear {
  const zoned: ZonedDateTime = ZonedDateTime.ofInstant(
    Instant.parse(utcIso),
    BANGKOK_ZONE,
  );

  const month = zoned.monthValue();
  const year = zoned.year();

  // If we're before the start month, we're still in the previous FY.
  // Example: April-start tenant on 2026-03-15 Bangkok → FY 2025.
  const fy = month >= startMonth ? year : year - 1;
  return fy as FiscalYear;
}

/**
 * Derive the fiscal year from a Date instance (rarely needed — ISO
 * string is the preferred input because it forces the caller to
 * serialize deliberately).
 */
export function deriveFiscalYearFromInstant(
  instant: Instant,
  startMonth: FiscalYearStartMonth = 1,
): FiscalYear {
  const zoned = ZonedDateTime.ofInstant(instant, BANGKOK_ZONE);
  const month = zoned.monthValue();
  const year = zoned.year();
  const fy = month >= startMonth ? year : year - 1;
  return fy as FiscalYear;
}

/**
 * Format a UTC ISO timestamp as a YYYY-MM-DD date string in Asia/Bangkok
 * local time. This is the canonical "invoice date" convention — the
 * calendar date on the document follows wall-clock Bangkok, not UTC.
 */
export function bangkokLocalDate(utcIso: string): string {
  const zoned = ZonedDateTime.ofInstant(Instant.parse(utcIso), BANGKOK_ZONE);
  return zoned.toLocalDate().toString();
}

/**
 * Add `days` to a YYYY-MM-DD calendar date, returning the new date as a
 * YYYY-MM-DD string. Pure calendar math — no timezone / DST concerns
 * because we operate on `LocalDate`, not instants.
 */
export function addDays(dateYmd: string, days: number): string {
  return LocalDate.parse(dateYmd).plusDays(days).toString();
}
