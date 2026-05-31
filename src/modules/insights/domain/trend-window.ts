/**
 * F9 trend-window helpers (FR-001a) — pure, tenant-timezone-aware month keys
 * for the 12-month dashboard trend charts. No framework/ORM imports.
 *
 * A "month key" is `YYYY-MM` in the TENANT timezone (not UTC) so the buckets
 * line up with the membership-year / fiscal conventions used elsewhere. The
 * `Intl.DateTimeFormat('en-CA', …)` `YYYY-MM-DD` shape gives a stable,
 * locale-independent prefix to slice.
 */

/** The tenant-local `YYYY-MM` month key for an instant. */
export function monthKeyOf(at: Date, timeZone: string): string {
  // en-CA → `YYYY-MM-DD`; slice the year-month prefix.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(at)
    .slice(0, 7);
}

/**
 * The last `n` month keys (oldest → newest), inclusive of the month containing
 * `now`, in the tenant timezone. e.g. n=12 ending 2026-06 →
 * ['2025-07', …, '2026-06'].
 */
export function lastNMonthKeys(now: Date, timeZone: string, n: number): string[] {
  const current = monthKeyOf(now, timeZone); // 'YYYY-MM'
  const year = Number(current.slice(0, 4));
  const month = Number(current.slice(5, 7)); // 1-12
  const keys: string[] = [];
  // Walk back n-1 months from the current month using plain integer math on
  // (year, month) so DST / timezone offsets never shift a bucket.
  for (let i = n - 1; i >= 0; i--) {
    let m = month - i;
    let y = year;
    while (m <= 0) {
      m += 12;
      y -= 1;
    }
    keys.push(`${y}-${String(m).padStart(2, '0')}`);
  }
  return keys;
}
