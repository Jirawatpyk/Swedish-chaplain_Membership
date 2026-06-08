/**
 * `formatGraceTimestamp` — locale-correct rendering of a
 * grace-window-active-until ISO timestamp for F6 surfaces.
 *
 * Behaviour:
 *   - Renders via `next-intl`'s `useFormatter().dateTime()` so TH and
 *     SV see locale-correct date+time copy (Thai script + Buddhist Era
 *     in `th-TH`; Swedish 24h clock in `sv-SE`).
 *   - Timezone is inherited from the global next-intl config (`Asia/Bangkok`)
 *     set in `src/i18n/request.ts` — no explicit `timeZone` needed at the
 *     call site.
 *   - Falls back to the raw ISO if `Date` rejects the input. Round 3
 *     M-err-1 (2026-05-13) — emits a `console.error` so a malformed
 *     adapter shape is at least visible in DevTools rather than
 *     silently rendering a machine-readable ISO blob to a Thai or
 *     Swedish admin.
 *
 * Round 3 M-type-3 — `format` parameter typed as a local structural
 * `GraceFormatter` interface instead of `ReturnType<typeof useFormatter>`.
 * Decouples from next-intl's internal return-type shape so a future
 * version narrowing or restructuring of `useFormatter`'s return type
 * fails loudly here rather than silently compiling.
 *
 * 061-date-standardization — `GraceFormatter.dateTime` uses a single
 * union signature (preset key or inline options) rather than two separate
 * overloads. Both forms are structurally assignable from `useFormatter()`,
 * so `_AssertCompat` holds with a single signature. The overload approach
 * previously used here was based on a false claim about contravariance
 * necessity — a single union signature compiles and `_AssertCompat`
 * remains `true`.
 *
 * Pure presentation helper — no framework state. Caller injects the
 * `useFormatter()` instance (client-side hook).
 */
import type { useFormatter } from 'next-intl';
import type { DateTimePresetKey } from '@/i18n/formats';

/**
 * Subset of the inline-options shape from next-intl's DateTimeFormatOptions.
 * Named for clarity in the signature below.
 */
type GraceInlineOpts = {
  readonly year?: 'numeric' | '2-digit';
  readonly month?: 'numeric' | '2-digit' | 'short' | 'long' | 'narrow';
  readonly day?: 'numeric' | '2-digit';
  readonly hour?: 'numeric' | '2-digit';
  readonly minute?: 'numeric' | '2-digit';
  readonly timeZone?: string;
};

export interface GraceFormatter {
  /**
   * Single union signature covering both intended call shapes:
   *  - `(d, opts?)` — inline options object (e.g. `{ year: 'numeric' }`).
   *  - `(d, preset, opts?)` — named preset from `buildFormats()` (e.g.
   *    `'dateTimeMedium'`), narrowed to `DateTimePresetKey` for type safety.
   *
   * A single union signature is sufficient for structural assignability:
   * `ReturnType<typeof useFormatter>` extends `GraceFormatter` because
   * `useFormatter().dateTime`'s overloads are assignable to this union
   * signature. The `_AssertCompat` assertion below verifies this at
   * compile time.
   */
  dateTime(d: Date, formatOrOptions?: DateTimePresetKey | GraceInlineOpts, options?: GraceInlineOpts): string;
}

// Compile-time check: `GraceFormatter` must remain a structural subset of
// `useFormatter()`'s return type. This guards against upstream narrowing or
// incompatible changes — if next-intl restructures `useFormatter().dateTime`,
// this assignment fails and the build breaks loudly rather than silently
// drifting. Note: a pure widening of the upstream type keeps this assertion
// green (the subset relation still holds). The `void` consumer suppresses
// the unused-binding lint rule without a directive.
type _AssertCompat = ReturnType<typeof useFormatter> extends GraceFormatter
  ? true
  : never;
const _formatterCompat: _AssertCompat = true;
void _formatterCompat;

export function formatGraceTimestamp(
  format: GraceFormatter,
  iso: string,
): string {
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
  return format.dateTime(d, 'dateTimeMedium');
}
