/**
 * Tenant-timezone day-boundary helpers for date-range filters (F9 US2 audit
 * viewer, FR-009).
 *
 * A `YYYY-MM-DD` picked in a `<input type="date">` is a CALENDAR day in the
 * operator's (tenant's) timezone, not UTC. Treating it as UTC silently drops a
 * partial day for any non-UTC tenant — e.g. Asia/Bangkok (UTC+7) loses
 * 00:00–06:59 local. These helpers convert a local calendar day to the exact
 * UTC instants that bound it, via js-joda zone rules (DST-correct), so the
 * keyset query filters by the day the operator actually meant.
 */
import { LocalDate, LocalTime, ZoneId } from '@js-joda/core';
import '@js-joda/timezone';

/**
 * `YYYY-MM-DD` CALENDAR-VALID guard. Callers MUST validate with this BEFORE
 * passing a date to `tenantDay*Utc` — those throw `JsJodaException` on any input
 * `LocalDate.parse` rejects, which a caller should map to a 400 / invalid-range
 * rather than a 500.
 *
 * Shape alone is NOT enough: `2026-02-30`, `2026-13-01`, and a non-leap
 * `2026-02-29` all match `\d{4}-\d{2}-\d{2}` yet `LocalDate.parse` throws on
 * them. So this round-trips through `LocalDate.parse` (the exact validator
 * `tenantDay*Utc` use) — a `true` result GUARANTEES those helpers won't throw.
 */
export function isYmd(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  try {
    LocalDate.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** UTC instant (ISO 8601) at the START of `ymd` in tenant tz `tz`. */
export function tenantDayStartUtc(ymd: string, tz: string): string {
  return LocalDate.parse(ymd).atStartOfDay(ZoneId.of(tz)).toInstant().toString();
}

/**
 * UTC instant (ISO 8601) at the END (23:59:59.999999) of `ymd` in tenant tz `tz`.
 *
 * Capped at MICROsecond precision (999_999_000 ns), not millisecond: the
 * `audit_log.timestamp` column is `timestamptz(6)` (microsecond) and the reader
 * filters `lte(timestamp, to)` inclusively. A millisecond cap (`.999`) would
 * silently drop an event committed in the final [.999001, .999999] µs of the
 * selected day — the same truncation class the keyset cursor already guards
 * against. (code-review max F9 — finding #14)
 */
export function tenantDayEndUtc(ymd: string, tz: string): string {
  return LocalDate.parse(ymd)
    .atTime(LocalTime.of(23, 59, 59, 999_999_000))
    .atZone(ZoneId.of(tz))
    .toInstant()
    .toString();
}
