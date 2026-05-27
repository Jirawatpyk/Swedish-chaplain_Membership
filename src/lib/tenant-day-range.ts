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
 * `YYYY-MM-DD` shape guard. Callers MUST validate with this BEFORE passing a
 * date to `tenantDay*Utc` — those throw `JsJodaException` on a malformed input,
 * which a caller should map to a 400 / invalid-range rather than a 500.
 */
export function isYmd(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/** UTC instant (ISO 8601) at the START of `ymd` in tenant tz `tz`. */
export function tenantDayStartUtc(ymd: string, tz: string): string {
  return LocalDate.parse(ymd).atStartOfDay(ZoneId.of(tz)).toInstant().toString();
}

/** UTC instant (ISO 8601) at the END (23:59:59.999) of `ymd` in tenant tz `tz`. */
export function tenantDayEndUtc(ymd: string, tz: string): string {
  return LocalDate.parse(ymd)
    .atTime(LocalTime.of(23, 59, 59, 999_000_000))
    .atZone(ZoneId.of(tz))
    .toInstant()
    .toString();
}
