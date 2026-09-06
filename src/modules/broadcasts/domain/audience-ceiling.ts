/**
 * 108 PR-C T085 (FR-041 / FR-042; research R9, contract broadcast-audience
 * § 3) — the ONE audience ceiling.
 *
 * Before 108 the number 5,000 lived in four places (`AUDIENCE_HARD_CAP` in
 * the resolver, the submit and dispatch checks, and the F3 read's
 * `.limit(5000)`), and the F7.1a batching path — built for 5,001–50,000 —
 * was unreachable because the resolver refused everything above 5,000 first
 * (R-C § 4). Now every caller reads this function through the composition
 * root (`currentAudienceCeiling()` in broadcasts-deps) and compares against
 * the same value at count, submit and dispatch, so the estimate a member
 * sees at compose is the number that decides the send.
 *
 *   - batching OFF → 5,000: the F7 MVP figure; a single Resend audience
 *     pushed by one dispatch tick.
 *   - batching ON  → 50,000: the DB CHECK `broadcasts_estimated_recipient_cap
 *     (0..50000)` and `MAX_RECIPIENT_COUNT` — unchanged — are the hard bound.
 *
 * Pure Domain: the flag value is passed in; nothing here reads the env.
 */
export function audienceCeiling(batchingEnabled: boolean): number {
  return batchingEnabled ? 50_000 : 5_000;
}

/**
 * Above this many resolved recipients the `split-large-broadcasts` cron
 * routes a broadcast through per-batch audiences instead of one push. It
 * MUST stay strictly below `audienceCeiling(true)` — an accepted audience
 * the split never picks up would sit in `approved` forever — and it is
 * only ever reached with batching ON (`audienceCeiling(false)` is below
 * it). Pinned by `tests/unit/broadcasts/domain/audience-ceiling.test.ts`.
 */
export const SPLIT_THRESHOLD_RECIPIENTS = 10_000;
