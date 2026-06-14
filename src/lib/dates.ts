/**
 * Shared UTC date arithmetic helpers.
 *
 * 068 cluster G — `addMonthsUtc` was duplicated byte-for-byte as
 * `mark-paid-offline.ts:deriveNewExpiresAt` and
 * `create-cycle-in-tx.ts:addMonthsUtc`. Extracted to a single source of truth.
 */

/**
 * Add `months` calendar months to an ISO-8601 UTC instant via direct UTC
 * arithmetic, CLAMPING a month-end overflow to the last day of the target
 * month (the billing-period anniversary intent).
 *
 * Asia/Bangkok is UTC+7 with no DST, so direct UTC month arithmetic produces
 * a UTC instant that lands at the same Bangkok calendar date for every
 * supported plan term (1–60 months) — NO js-joda needed, and it matches the
 * existing repo arithmetic the renewal cycle period derivation relies on.
 *
 * Month-end clamping (068 R2-2): a naïve `setUTCMonth(+N)` overflows when the
 * origin's day-of-month exceeds the target month's length — e.g. Jan 31 + 1
 * month would roll into Mar 3 (Feb has no 31st), and Feb 29 (leap) + 12 months
 * would roll into Mar 1 (the next Feb has no 29th). For billing periods that
 * silently drifts the renewal anniversary forward a few days every time it
 * overflows (and COMPOUNDS when the result is re-advanced — see
 * `create-cycle-in-tx.ts:advanceAnchorToCurrentPeriod`). We instead clamp to
 * the last day of the target month so a month-end anniversary is preserved:
 * Jan 31 + 1mo → Feb 28/29, Feb 29 + 12mo → Feb 28. A non-month-end
 * day-of-month is never affected (it fits in every month). Time-of-day is
 * preserved.
 */
export function addMonthsUtc(iso: string, months: number): string {
  const d = new Date(iso);
  const day = d.getUTCDate();
  // Snap to the 1st before shifting the month so `setUTCMonth` can never
  // overflow into the following month, then restore the day-of-month clamped
  // to the target month's length.
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return d.toISOString();
}
