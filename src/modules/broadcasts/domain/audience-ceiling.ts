/**
 * 108 PR-C T085 (FR-041 / FR-042; research R9, contract broadcast-audience
 * § 3) — the ONE audience ceiling.
 *
 * Before 108 the number 5,000 lived in the resolver's `AUDIENCE_HARD_CAP`,
 * the F3 read's `.limit(5000)` and four i18n copy strings × 3 locales
 * (submit and dispatch had no number of their own — they relayed the
 * resolver's refusal), and the F7.1a batching path — built for 5,001–50,000 —
 * was unreachable because the resolver refused everything above 5,000 first
 * (R-C § 4). Now every caller reads this function through the composition
 * root (`currentAudienceCeiling()` in broadcasts-deps) and compares against
 * the same value at count, submit and dispatch, so the estimate a member
 * sees at compose is the number that decides the send.
 *
 *   - `false` → 5,000: the F7 MVP figure; a single Resend audience pushed by
 *     one dispatch tick.
 *   - `true`  → 50,000: the DB CHECK `broadcasts_estimated_recipient_cap
 *     (0..50000)` and `MAX_RECIPIENT_COUNT` — unchanged — are the hard bound.
 *
 * The composition root passes `isF71aUs1Enabled() && contactMarketingRecipients`
 * (review H-2, 2026-09-07): the wide ceiling was raised FOR the 1:N audience,
 * so it moves with the 1:N flag, not with batching alone — prod has batching
 * ON, and batching alone would have raised prod to 50,000 on a flag-OFF deploy.
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
 *
 * **5,001–10,000 IS a gap — do not re-derive that it is not.** Round 2 of the
 * 2026-09-07 review called this band "the intended SINGLE-audience path under
 * `RESEND_PER_AUDIENCE_CAP`, not a gap": a correct statement about ROUTING
 * (Resend permits 10,000 contacts per audience) that never checked the WALL
 * CLOCK. Pass 4 of the staff review did. `split-large-broadcasts` skips
 * `resolvedCount <= SPLIT_THRESHOLD_RECIPIENTS`, so the band falls to
 * `dispatch-scheduled`, whose push is a SERIAL one-contact-at-a-time loop at
 * ~2 req/s inside `maxDuration = 300` — and `plan.md:268` states the serial
 * push cannot finish even 5,000 contacts in that budget. Such a broadcast is
 * accepted at submit and never delivered. Unreachable while the 1:N flag is
 * OFF (the ceiling is 5,000 then); a precondition of the flag flip — see the
 * US5 AMENDMENT in `spec.md` and `reviews/pr-c.md` row 33.
 */
export const SPLIT_THRESHOLD_RECIPIENTS = 10_000;
