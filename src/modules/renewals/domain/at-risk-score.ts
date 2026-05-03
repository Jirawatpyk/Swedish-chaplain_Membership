/**
 * T038 (F8 Phase 2 Wave D) — `AtRiskScore` Domain entity.
 *
 * 8-factor at-risk score formula per spec FR-029 + research.md R7
 * + F6-readiness fallback per FR-029a.
 *
 * Each factor contributes 0–N points; the sum is clipped to [0, 100]
 * and translated to a `RiskBand` via `value-objects/risk-band.ts`.
 *
 * F6-readiness fallback (FR-029a): when F6 EventAttendees integration
 * is not yet available (`eventAttendeesAvailable=false`), the
 * `eventAttendanceFactor` reverts to a sentinel score of 0 (full
 * credit — no penalty) so members aren't unfairly penalised before
 * F6 ships. The `factorsBreakdown` payload includes a
 * `eventAttendanceFactorSkipped: true` flag so the audit trail shows
 * the fallback was active.
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { ok, type Result } from '@/lib/result';
import { type RiskBand, bandForScore } from './value-objects/risk-band';

/**
 * The 8 input signals. All optional except where the at-risk-scorer
 * port can guarantee values; the formula tolerates missing factors by
 * skipping them (contributes 0).
 */
export interface AtRiskFactors {
  /** Tenure in days (members <30d skip the score per FR-029 min-tenure). */
  readonly tenureDays?: number;
  /** Days since last_activity_at on the member row. */
  readonly daysSinceLastActivity?: number;
  /** Count of dispatched reminder emails opened in last 90d. */
  readonly recentEmailOpenCount?: number;
  /** Count of dispatched reminder emails ignored (sent but not opened) in last 90d. */
  readonly recentEmailIgnoreCount?: number;
  /** Stripe payment_failed events in current cycle. */
  readonly paymentFailureCount?: number;
  /** Days the member has been in `awaiting_payment` past their grace period. */
  readonly daysPastGrace?: number;
  /** True when member has been email_unverified for ≥7 days (F1 bounce gate). */
  readonly emailUnverifiedOver7Days?: boolean;
  /** F6 events attended in last 12mo. Sentinel-fallback when F6 is unavailable. */
  readonly eventsAttendedLast12Months?: number;
}

export interface AtRiskComputeContext {
  /** Per-tenant min-tenure threshold (default 30 from tenant_renewal_settings). */
  readonly minTenureDays: number;
  /**
   * F6 readiness gate per FR-029a. When false, eventAttendance factor
   * is skipped + flagged in the breakdown.
   */
  readonly eventAttendeesAvailable: boolean;
}

/** Per-factor contribution (0–N). Sum clipped to 100. */
export interface FactorContribution {
  readonly factor: string;
  readonly points: number;
}

export interface AtRiskScoreResult {
  readonly score: number;
  readonly band: RiskBand;
  readonly contributions: readonly FactorContribution[];
  /** True when min-tenure gate skipped scoring entirely. */
  readonly skippedBelowMinTenure: boolean;
  /** True when F6 fallback was active. */
  readonly eventAttendanceFactorSkipped: boolean;
}

const MAX_SCORE = 100;

const POINTS = {
  inactivity90Plus: 25,
  inactivity30Plus: 10,
  paymentFailureEach: 10,
  emailUnverified7Plus: 15,
  daysPastGraceEach: 5,
  emailIgnoreStreak: 15,
  noRecentOpens: 5,
  noEventsAttendedF6: 10,
} as const;

/**
 * Compute the at-risk score. Always returns `ok` — score saturates
 * at the [0,100] bounds. Result is structured so callers can persist
 * `score`, `band`, AND `contributions` JSONB to `members.risk_score_*`
 * columns (data-model.md § 3.1).
 */
export function computeAtRiskScore(
  factors: AtRiskFactors,
  ctx: AtRiskComputeContext,
): Result<AtRiskScoreResult, never> {
  // Min-tenure gate — members newer than threshold skip scoring per FR-029.
  if (
    factors.tenureDays != null &&
    factors.tenureDays < ctx.minTenureDays
  ) {
    return ok({
      score: 0,
      band: 'healthy',
      contributions: [],
      skippedBelowMinTenure: true,
      eventAttendanceFactorSkipped: !ctx.eventAttendeesAvailable,
    });
  }

  const contribs: FactorContribution[] = [];

  // Factor 1+2 — inactivity
  if (factors.daysSinceLastActivity != null) {
    if (factors.daysSinceLastActivity >= 90) {
      contribs.push({
        factor: 'inactivity_90_plus',
        points: POINTS.inactivity90Plus,
      });
    } else if (factors.daysSinceLastActivity >= 30) {
      contribs.push({
        factor: 'inactivity_30_plus',
        points: POINTS.inactivity30Plus,
      });
    }
  }

  // Factor 3 — payment failures
  if (factors.paymentFailureCount != null && factors.paymentFailureCount > 0) {
    contribs.push({
      factor: 'payment_failures',
      points: factors.paymentFailureCount * POINTS.paymentFailureEach,
    });
  }

  // Factor 4 — email unverified streak
  if (factors.emailUnverifiedOver7Days === true) {
    contribs.push({
      factor: 'email_unverified_7_plus',
      points: POINTS.emailUnverified7Plus,
    });
  }

  // Factor 5 — past grace period
  if (factors.daysPastGrace != null && factors.daysPastGrace > 0) {
    contribs.push({
      factor: 'past_grace',
      points: factors.daysPastGrace * POINTS.daysPastGraceEach,
    });
  }

  // Factor 6 — email engagement (ignore streak penalty)
  if (
    factors.recentEmailIgnoreCount != null &&
    factors.recentEmailOpenCount != null &&
    factors.recentEmailIgnoreCount >= 3 &&
    factors.recentEmailOpenCount === 0
  ) {
    contribs.push({
      factor: 'email_ignore_streak',
      points: POINTS.emailIgnoreStreak,
    });
  } else if (
    factors.recentEmailOpenCount != null &&
    factors.recentEmailOpenCount === 0 &&
    (factors.recentEmailIgnoreCount ?? 0) > 0
  ) {
    contribs.push({
      factor: 'no_recent_opens',
      points: POINTS.noRecentOpens,
    });
  }

  // Factor 7 — F6 event attendance (or fallback)
  let eventAttendanceFactorSkipped = false;
  if (!ctx.eventAttendeesAvailable) {
    eventAttendanceFactorSkipped = true;
    // Fallback: don't penalise (FR-029a). Add no contribution.
  } else if (
    factors.eventsAttendedLast12Months != null &&
    factors.eventsAttendedLast12Months === 0
  ) {
    contribs.push({
      factor: 'no_events_attended_12mo',
      points: POINTS.noEventsAttendedF6,
    });
  }

  // Factor 8 reserved — placeholder for future signals (NPS / etc.).

  // Sum + clamp.
  const rawSum = contribs.reduce((acc, c) => acc + c.points, 0);
  const score = Math.max(0, Math.min(MAX_SCORE, rawSum));

  const bandResult = bandForScore(score);
  // bandForScore can only fail on out-of-range; we just clamped to [0,100]
  // so this branch is unreachable.
  /* istanbul ignore next */
  const band: RiskBand = bandResult.ok ? bandResult.value : 'healthy';

  return ok({
    score,
    band,
    contributions: contribs,
    skippedBelowMinTenure: false,
    eventAttendanceFactorSkipped,
  });
}
