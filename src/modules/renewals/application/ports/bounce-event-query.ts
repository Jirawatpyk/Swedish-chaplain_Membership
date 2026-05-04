/**
 * F8 Phase 4 Wave I2d — `BounceEventQuery` Application port.
 *
 * Per-member bounce-event reader. Powers T090 detect-bounce-threshold
 * which is the F1-webhook-driven gate that flips
 * `members.email_unverified=true` when bounce volume exceeds one of
 * three thresholds (FR-012a / Clarification Q4 round 2):
 *
 *   - 1 hard bounce (Resend `bounce_type === 'permanent'`)
 *   - 3 soft bounces in same renewal cycle
 *   - 5 soft bounces in rolling 30-day window
 *
 * Counts are computed against F1's `email_delivery_events` table —
 * but F1's current schema does NOT differentiate hard vs soft bounces
 * (the webhook discards Resend's `bounce.type` field). The Wave I2d
 * stub adapter returns zeros so T090's logic + tests can land; the
 * real adapter ships in Wave I4 alongside the F1 schema extension
 * (`email_delivery_events.bounce_type` column) + T101 webhook hook.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface BounceCounts {
  /**
   * Total hard bounces (bounce_type='permanent') ever recorded for
   * this member's primary contact email. Reset to 0 only when admin
   * manually clears via `members.email_unverified=false` (T091) +
   * member's bounce history is implicitly retained for audit.
   */
  readonly hardBounces: number;
  /**
   * Soft bounces (bounce_type='transient') recorded since the start
   * of the member's current active renewal cycle. Null when the
   * member has no active cycle (rare — pre-renewal-creation members,
   * or all cycles in terminal states); use-case treats null as
   * "soft-in-cycle threshold not applicable".
   */
  readonly softBouncesInCycle: number | null;
  /**
   * Soft bounces in the rolling 30-day window prior to `now`. Decays
   * automatically as the window slides forward.
   */
  readonly softBouncesIn30Days: number;
}

export interface BounceEventQuery {
  /**
   * Compute the three threshold counts in a single round-trip. Caller
   * (T090) provides the active cycle's start timestamp (or null) and
   * the `now` clock (injectable for tests). Real Drizzle adapter (Wave
   * I4) issues a single query against F1's `email_delivery_events`
   * with FILTER aggregates per threshold.
   */
  countBounces(
    tenantId: string,
    memberId: string,
    args: {
      readonly cycleStartedAt: string | null;
      readonly nowIso: string;
    },
  ): Promise<BounceCounts>;
}
