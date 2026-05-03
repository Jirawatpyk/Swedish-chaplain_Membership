/**
 * T050 (F8 Phase 2 Wave E) — `AtRiskScorer` Application port.
 *
 * Owns the I/O side of computing a member's at-risk score: gathers
 * the 8 input factors from F1+F3+F4+F5+F6 (via composition-root-
 * wired bridges), then delegates the pure formula to
 * `computeAtRiskScore` from the Domain.
 *
 * Wave E ships the interface only; the adapter (Wave G+) reads from:
 *   - F3 members → tenureDays, daysSinceLastActivity, emailUnverifiedOver7Days
 *   - F4 invoices → recent payment history
 *   - F5 payments → paymentFailureCount
 *   - F8 reminder events → recentEmailOpenCount/IgnoreCount (via Resend webhooks)
 *   - F6 events (via EventAttendeesPort) → eventsAttendedLast12Months
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { AtRiskScoreResult } from '../../domain/at-risk-score';

export interface AtRiskScorer {
  /**
   * Compute the at-risk score for a single member. The adapter
   * gathers factors from cross-module bridges + delegates to the
   * Domain formula; returns the typed result for direct persistence
   * to F3 members.risk_score_* columns.
   *
   * Errors are swallowed at the adapter boundary (logged + factor
   * skipped) so a partial signal yields a partial score rather than
   * blocking the at-risk recompute cron entirely. The
   * `at_risk_compute_partial_failure` audit event flags the
   * degradation per audit-port.md.
   */
  scoreMember(
    tenantId: string,
    memberId: string,
  ): Promise<AtRiskScoreResult>;

  /**
   * Batch variant — used by the weekly recompute cron. Adapter
   * issues per-member queries in chunks (per-tenant connection-pool
   * friendliness). Order is implementation-defined; callers iterate
   * and persist as they arrive.
   */
  scoreMembers(
    tenantId: string,
    memberIds: ReadonlyArray<string>,
  ): AsyncIterable<{
    readonly memberId: string;
    readonly result: AtRiskScoreResult;
  }>;
}
