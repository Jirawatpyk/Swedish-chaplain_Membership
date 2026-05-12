/**
 * Match-rate percent formatter (F6 Domain).
 *
 * Computes `matchRatePct = (matched / total) × 100` rounded to 1
 * decimal. The wire format pinned by `contracts/admin-events-api.md`
 * example (`93.6`) drives the rounding precision; the UI then renders
 * "Match rate: NN.N% (M of N)" per US2 AS2.
 *
 * Extracted to Domain (H2 round-3 fix 2026-05-12) so `listEvents` +
 * `loadEventDetail` use-cases share a single implementation, and the
 * unit test at `tests/unit/modules/events/match-rate.test.ts` exercises
 * the REAL function — not a duplicated re-derivation.
 *
 * Pure function, zero dependencies → safe Domain placement
 * (Constitution Principle III).
 */

export function computeMatchRatePct(matched: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((matched / total) * 1000) / 10;
}
