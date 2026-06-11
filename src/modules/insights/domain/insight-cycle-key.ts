/**
 * F9 insight cycle-key computation (US1 / data-model § 2 / critique L3).
 *
 * A dismissal suppresses an insight for one CYCLE; the granularity is
 * per-insight (declared in `INSIGHT_CATALOGUE`):
 *   - membership_year → calendar year in the TENANT timezone ("2026")
 *   - iso_week        → ISO week-year + week ("2026-W01")
 *
 * Both are computed in the tenant's timezone so the year/week boundary matches
 * what the chamber sees (FR-023 / Q "membership year" = calendar year, tenant TZ).
 *
 * Pure — uses only `Intl.DateTimeFormat` (a JS built-in, not a framework) +
 * arithmetic. No framework/ORM imports (Constitution Principle III).
 */
import { INSIGHT_CATALOGUE, type InsightKey } from './smart-insight';

/**
 * Local Y-M-D in the given IANA timezone, via the en-CA "YYYY-MM-DD" format.
 * (Same Intl idiom as the shared `src/lib/bangkok-today.ts` — kept local
 * here because this Domain variant takes an arbitrary instant + timezone,
 * not wall-clock Bangkok "now"; wave-4 S14.)
 */
function localYmd(at: Date, timeZone: string): { y: number; m: number; d: number } {
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
  const [y, m, d] = ymd.split('-').map(Number);
  return { y: y!, m: m!, d: d! };
}

/** ISO 8601 week-year + week number for a calendar date (Thursday-based). */
function isoWeek(y: number, m: number, d: number): { isoYear: number; week: number } {
  const date = new Date(Date.UTC(y, m - 1, d));
  // Shift to the Thursday of the current ISO week (Mon=0 … Sun=6).
  const dayMon0 = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayMon0 + 3);
  const isoYear = date.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayMon0 = (jan4.getUTCDay() + 6) % 7;
  const week =
    1 +
    Math.round(
      ((date.getTime() - jan4.getTime()) / 86_400_000 - 3 + jan4DayMon0) / 7,
    );
  return { isoYear, week };
}

export function cycleKeyFor(
  insightKey: InsightKey,
  at: Date,
  timeZone: string,
): string {
  const { y, m, d } = localYmd(at, timeZone);
  if (INSIGHT_CATALOGUE[insightKey] === 'iso_week') {
    const { isoYear, week } = isoWeek(y, m, d);
    return `${isoYear}-W${String(week).padStart(2, '0')}`;
  }
  // membership_year
  return String(y);
}
