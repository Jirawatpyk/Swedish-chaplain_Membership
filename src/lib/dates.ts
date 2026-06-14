/**
 * Shared UTC date arithmetic helpers.
 *
 * 068 cluster G — `addMonthsUtc` was duplicated byte-for-byte as
 * `mark-paid-offline.ts:deriveNewExpiresAt` and
 * `create-cycle-in-tx.ts:addMonthsUtc`. Extracted to a single source of truth.
 */

/**
 * Add `months` calendar months to an ISO-8601 UTC instant via direct UTC
 * arithmetic (`setUTCMonth(+N)`).
 *
 * Asia/Bangkok is UTC+7 with no DST, so a `setUTCMonth(+N)` produces a UTC
 * instant that lands at the same Bangkok calendar date for every supported
 * plan term (1–60 months) — NO js-joda needed, and it matches the existing
 * repo arithmetic the renewal cycle period derivation relies on.
 *
 * Note on month-end roll-over: this delegates to the platform `Date`
 * semantics (e.g. Jan 31 + 1 month → Mar 3, since Feb has no 31st). That is
 * the behaviour both former call sites already had; preserved intentionally.
 */
export function addMonthsUtc(iso: string, months: number): string {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}
