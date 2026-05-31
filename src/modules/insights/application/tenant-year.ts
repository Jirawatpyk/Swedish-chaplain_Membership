/**
 * F9 — tenant-timezone calendar-year UTC bounds (Application util).
 *
 * Single source of truth for "the [startMs, endMs) UTC window of calendar year
 * N in timezone tz". The benefit-usage use-case (elapsed-year %) and the event
 * consumption adapter (year-scoped attendance filter) MUST agree on this window
 * exactly or US4's year-scoping silently drifts — so the math lives here, not
 * duplicated at each call site (review-run I-9). Domain stays tz-free
 * (Constitution III), so this util is Application-layer; Infrastructure adapters
 * may import it.
 *
 * js-joda is a pure date library (already used by F4/F7 Application use-cases).
 */
import { LocalDateTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';

export interface TenantYearBounds {
  /** Inclusive start: `year-01-01T00:00 [tz]` as UTC epoch ms. */
  readonly startMs: number;
  /** Exclusive end: `(year+1)-01-01T00:00 [tz]` as UTC epoch ms. */
  readonly endMs: number;
}

export function tenantYearBoundsUtcMs(year: number, timeZone: string): TenantYearBounds {
  const zone = ZoneId.of(timeZone);
  const startOf = (y: number): number =>
    LocalDateTime.of(y, 1, 1, 0, 0, 0).atZone(zone).toInstant().toEpochMilli();
  return { startMs: startOf(year), endMs: startOf(year + 1) };
}
