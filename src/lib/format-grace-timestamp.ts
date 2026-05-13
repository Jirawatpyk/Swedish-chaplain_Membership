/**
 * `formatGraceTimestamp` — locale-correct rendering of a
 * grace-window-active-until ISO timestamp for F6 surfaces.
 *
 * Behaviour:
 *   - Renders via `next-intl`'s `useFormatter().dateTime()` so TH and
 *     SV see locale-correct date+time copy (Thai script + Buddhist Era
 *     in `th-TH`; Swedish 24h clock in `sv-SE`).
 *   - Pinned to `Asia/Bangkok`: the grace window is a chamber-ops
 *     invariant — a Stockholm-based admin (CET) should see the same
 *     cutoff the Bangkok chamber operator observes, not their local
 *     clock.
 *   - Falls back to the raw ISO if `Date` rejects the input. Round 3
 *     M-err-1 (2026-05-13) — emits a `console.error` so a malformed
 *     adapter shape is at least visible in DevTools rather than
 *     silently rendering a machine-readable ISO blob to a Thai or
 *     Swedish admin.
 *
 * Round 3 M-type-3 — `format` parameter typed as a local structural
 * `GraceFormatter` interface instead of `ReturnType<typeof useFormatter>`.
 * Decouples from next-intl's internal return-type shape so a future
 * minor-version widening of `useFormatter`'s return doesn't silently
 * widen our signature.
 *
 * Pure presentation helper — no framework state. Caller injects the
 * `useFormatter()` instance (client-side hook).
 */
import type { useFormatter } from 'next-intl';

export interface GraceFormatter {
  dateTime(d: Date, opts: {
    readonly year?: 'numeric' | '2-digit';
    readonly month?: 'numeric' | '2-digit' | 'short' | 'long' | 'narrow';
    readonly day?: 'numeric' | '2-digit';
    readonly hour?: 'numeric' | '2-digit';
    readonly minute?: 'numeric' | '2-digit';
    readonly timeZone?: string;
  }): string;
}

// Compile-time check: the structural interface stays compatible with
// the actual `useFormatter()` return type. If next-intl widens its
// return shape, this assertion fails and the codebase recompiles
// fast — instead of silently following the upstream change. The
// `void` consumer pattern silences the unused-binding rule without
// needing a directive.
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
  return format.dateTime(d, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  });
}
