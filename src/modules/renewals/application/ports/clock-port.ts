/**
 * F8 Round-5 review-finding M6 — Application port for deterministic
 * time source in the renewals module. Mirrors the established Clock
 * pattern in `members`, `invoicing`, `payments`, and `broadcasts`.
 *
 * Pre-Round-5 the renewals module threaded `now: z.date()` through
 * use-case input schemas (R4-W1 fix in `processTimeout`,
 * Round-5 H5 fix in `recompute-at-risk-scores-batch`). That worked
 * but conflated "the clock" (composition-root concern) with "request
 * input" (caller-supplied data) — and left `cancel-cycle.ts` +
 * `mark-paid-offline.ts` as half-migrated outliers calling
 * `new Date()` directly.
 *
 * The ClockPort moves the dependency to `deps.clock` so:
 *   - All renewals use-cases share one injection seam.
 *   - Tests pass `{ now: () => FIXED_DATE }` once via deps.
 *   - Production composition root binds a single `() => new Date()`
 *     adapter — no per-call-site clock plumbing.
 *   - Aligns with sibling modules (consistency reduces cognitive
 *     load when reading cross-module use-cases).
 */
export interface ClockPort {
  now(): Date;
}

/**
 * Production adapter — wall-clock. Default for `RenewalsDeps.clock`.
 * Tests override via `{ now: () => FIXED_DATE }` in their fakeDeps.
 */
export const wallClock: ClockPort = {
  now: () => new Date(),
};
