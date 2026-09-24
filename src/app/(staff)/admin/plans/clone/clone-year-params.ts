/**
 * `?from=` / `?to=` parsing for /admin/plans/clone.
 *
 * The prior-year lock banner links here with both params. Only a single,
 * plain four-digit year inside the range the clone API accepts (2000–2100)
 * is honoured; anything else (missing, repeated, non-numeric, out of range)
 * returns `null` so the page falls back to its default.
 */
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;

export function parseCloneYearParam(
  raw: string | string[] | undefined,
): number | null {
  if (typeof raw !== 'string' || !/^\d{4}$/.test(raw)) return null;
  const year = Number.parseInt(raw, 10);
  return year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}
