/**
 * `formatGraceTimestamp` — locale-correct rendering of a
 * grace-window-active-until ISO timestamp for F6 surfaces.
 *
 * Round 2 fix (2026-05-13) — extracted from `webhook-config-wizard.tsx`
 * so the rotate-secret dialog (R-H2) and any future surface displaying
 * the same field share a single implementation.
 *
 * Behaviour:
 *   - Renders via `next-intl`'s `useFormatter().dateTime()` so TH and
 *     SV see locale-correct date+time copy (Thai script + Buddhist Era
 *     in `th-TH`; Swedish 24h clock in `sv-SE`).
 *   - Pinned to `Asia/Bangkok` (MED-05): the grace window is a chamber-
 *     ops invariant — a Stockholm-based admin (CET) should see the same
 *     cutoff the Bangkok chamber operator observes, not their local
 *     clock. The (Bangkok time) suffix is rendered by the caller via
 *     i18n if the locale benefits from it.
 *   - Falls back to the raw ISO if `Date` rejects the input — defensive
 *     against a future receiver-side change to the adapter that
 *     emits a malformed shape.
 *
 * Pure presentation helper — no framework state. Caller must inject
 * the `useFormatter()` instance (client-side hook).
 */
import { useFormatter } from 'next-intl';

export function formatGraceTimestamp(
  format: ReturnType<typeof useFormatter>,
  iso: string,
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return format.dateTime(d, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Asia/Bangkok',
  });
}
