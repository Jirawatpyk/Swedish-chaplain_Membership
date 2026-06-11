/**
 * Wave-4 S14 — shared, client-safe "today in Asia/Bangkok" as `YYYY-MM-DD`.
 *
 * The `en-CA` locale renders the ISO date shape directly, so this is a pure
 * Intl one-liner with no library weight — the client-bundle twin of the
 * server-side js-joda `bangkokLocalDate(nowIso)` in `src/lib/fiscal-year.ts`
 * (which converts an arbitrary UTC instant and is the one to use inside
 * use-cases with an injectable clock). Use THIS helper in client components
 * that need wall-clock "today" (date-input defaults / max clamps).
 *
 * Bangkok has no DST, so the Intl conversion is stable year-round.
 */
export function bangkokTodayIso(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
