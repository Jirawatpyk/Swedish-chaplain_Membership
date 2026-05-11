/**
 * F8 Phase 4 Wave I2a — `AtRiskOutreachReadRepo` Application port.
 *
 * Read-only repository over `at_risk_outreach` (Wave C migration 0090).
 * F8's pause-reminders-after-outreach use-case reads outreach rows
 * within the last N days to decide whether the daily dispatcher should
 * skip a member's email steps (FR-033 / P5-r1 — 7-day reminder pause
 * after admin records an outreach).
 *
 * The full mutating surface (insertOutreach, list-for-member-timeline,
 * etc.) ships with US4 (at-risk widget) — Phase 6. F8 Phase 4 only
 * needs the read path for the pause check.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */

export interface OutreachWithinWindowResult {
  readonly hasOutreach: boolean;
  /**
   * Most recent outreach timestamp within the window. Null when
   * `hasOutreach=false`. Useful for a future "pause expires at" UI
   * affordance.
   */
  readonly latestAt: string | null;
}

export interface AtRiskOutreachReadRepo {
  /**
   * Returns whether the member has at least one logged outreach within
   * `[now - withinDays, now]`. Caller passes `withinDays=7` per FR-033
   * default; left as parameter so a per-tenant override is possible
   * later without port-shape change.
   */
  hasOutreachWithinDays(
    tenantId: string,
    memberId: string,
    withinDays: number,
  ): Promise<OutreachWithinWindowResult>;
}
