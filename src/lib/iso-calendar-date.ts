/**
 * `YYYY-MM-DD` URL-param validator: the strict shape AND a real calendar
 * date. V8's lenient parser ROLLS OVER out-of-range days instead of
 * rejecting them (`2026-02-30T00:00:00Z` parses as Mar 2), so a NaN check
 * alone is not enough — the UTC round-trip must reproduce the input exactly.
 * Anything else → undefined (param ignored; never a 500).
 *
 * Client-safe (no js-joda): the admin invoice list's server page and its
 * filter chips share it for `?dueBefore` / `?dueAfter`, so the data and the
 * chip can never split-brain.
 */
export function parseIsoCalendarDate(raw: string | null | undefined): string | undefined {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return undefined;
  const ms = Date.parse(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString().slice(0, 10) === raw ? raw : undefined;
}
