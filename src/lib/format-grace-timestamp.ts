/**
 * `formatGraceTimestamp` — locale-correct rendering of a
 * grace-window-active-until ISO timestamp for F6 surfaces.
 *
 * Behaviour:
 *   - Renders the `dateTimeMedium` preset through the central
 *     `formatDatePreset` helper: en-GB day-first with a 24-hour clock for
 *     English (docs/ux-standards.md § 12.3), Thai script + Buddhist Era for
 *     th, Swedish 24h clock for sv — all in Bangkok wall time.
 *   - Falls back to the raw ISO if `Date` rejects the input. Round 3
 *     M-err-1 (2026-05-13) — emits a `console.error` so a malformed
 *     adapter shape is at least visible in DevTools rather than
 *     silently rendering a machine-readable ISO blob to a Thai or
 *     Swedish admin.
 *
 * Pure presentation helper — the caller passes its `useLocale()`.
 */
import { formatDatePreset } from '@/lib/format-date-localised';

export function formatGraceTimestamp(locale: string, iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Round 3 M-err-1 — surface the silent fallback so a malformed
    // adapter shape is at least visible in DevTools. The grace badge
    // is mission-critical (admins rely on it to time the Zapier swap),
    // and showing raw ISO bytes to a TH/SV operator looks like the
    // value is "valid" — exactly the silent-failure-that-looks-like-
    // success class `feedback_skip_is_not_pass` warns against.
    console.error('[chamber-os] formatGraceTimestamp: Invalid Date input', { iso });
    return iso;
  }
  return formatDatePreset(d, locale, 'dateTimeMedium');
}
