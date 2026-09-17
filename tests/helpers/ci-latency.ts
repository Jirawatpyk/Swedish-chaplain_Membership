/**
 * Wall-clock budgets written on a laptop do not survive CI.
 *
 * GitHub's runners are in the US; Neon is in `ap-southeast-1`. Every statement
 * pays ~200 ms round-trip there against ~25 ms from Bangkok — measured
 * 2026-07-28: the same 7-file integration set ran 95 s locally and 547 s in CI,
 * and again on 2026-07-30 when the first `members` / `broadcasts` / `events`
 * sweeps failed on budgets like "must finish in 8 s" (took 9.7 s) and
 * "under 10 s" (took 11.1 s).
 *
 * These are anti-hang guards, not performance budgets: their job is to fail
 * when something deadlocks, not to police milliseconds. Scaling them on CI
 * keeps that job intact instead of turning every sweep into noise. A genuine
 * hang still blows through 6× as easily as through 1×.
 *
 * Do NOT use this to paper over a real perf regression — a suite that measures
 * per-query overhead (e.g. the RLS p95 check) cannot be rescued by a bigger
 * number and should take its threshold from an env var the workflow sets, or
 * not run in the sweep at all.
 *
 * The two mechanisms that rule produced, so a new suite copies one instead of
 * inventing a third:
 *
 *   - `INTEGRATION_FOLDER_RUN=1` — set by `.husky/pre-push` and by the nightly
 *     sweep, both of which run many files in ONE fork against one shared Neon
 *     compute. A per-query budget REPORTS there and asserts everything that is
 *     not a clock; it asserts the budget when the file runs alone (see
 *     `tests/integration/members/change-requests-queue-pagination.test.ts`).
 *   - A named env knob — `PERF_RLS_P95_MS`, `PERF_AUDIENCE_20K_MS`,
 *     `PERF_AUDIENCE_PAGE_MS` — when the number is a PRODUCTION SLO measured
 *     in-region and the runner is not. The default stays the SLO; the workflow
 *     raises it to a runaway guard and says so in a comment.
 *
 * Neither is a licence to widen a budget on a workstation to make a red suite
 * green: disclose any override you use, and if the number moved on a machine
 * that should meet it, it is a regression.
 */
export const CI_LATENCY_FACTOR = process.env.CI ? 6 : 1;

/** Scale an anti-hang budget or an explicit per-test timeout for CI. */
export function ciScaled(localMs: number): number {
  return localMs * CI_LATENCY_FACTOR;
}
