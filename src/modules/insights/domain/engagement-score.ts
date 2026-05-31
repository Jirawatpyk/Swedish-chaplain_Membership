/**
 * F9 Engagement Score (US1 / FR-007a / data-model § 6) — pure Domain projection.
 *
 * The positive-framed inverse of the shipped F8 at-risk score — NO new scoring
 * pipeline (Constitution X / research R3). Staff-facing only (never shown to
 * members; enforced at the presentation layer).
 *
 *   score = clamp(100 − riskScore, 0, 100)   // null riskScore → null score
 *   band  = invert(riskScoreBand)
 *           critical → critical · at-risk → warning · warning → moderate · healthy → healthy
 *           null → null
 *
 * Pure — no I/O, no framework/ORM imports (Constitution Principle III).
 */

/** The F8 at-risk band (input). */
export type RiskBand = 'healthy' | 'warning' | 'at-risk' | 'critical';

/** The positive-framed engagement band (output). */
export type EngagementBand = 'healthy' | 'moderate' | 'warning' | 'critical';

export interface EngagementInput {
  /** F8 risk score 0–100 (higher = worse); null until F8's cron scores the tenant. */
  readonly riskScore: number | null;
  readonly riskScoreBand: RiskBand | null;
}

export interface EngagementScore {
  /** 0–100 (higher = healthier); null when un-scored. */
  readonly score: number | null;
  readonly band: EngagementBand | null;
}

/** riskBand → engagementBand inversion map (data-model § 6). */
const BAND_INVERSION: Record<RiskBand, EngagementBand> = {
  critical: 'critical',
  'at-risk': 'warning',
  warning: 'moderate',
  healthy: 'healthy',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function projectEngagementScore(input: EngagementInput): EngagementScore {
  return {
    score: input.riskScore === null ? null : clamp(100 - input.riskScore, 0, 100),
    band: input.riskScoreBand === null ? null : BAND_INVERSION[input.riskScoreBand],
  };
}
