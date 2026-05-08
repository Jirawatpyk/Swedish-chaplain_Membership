/**
 * T032 (F8 Phase 2 Wave D) — `RiskBand` Domain value object.
 *
 * 4-band classification for the at-risk score (data-model.md § 3.1
 * + spec.md FR-029). Domain owns:
 *   - canonical band list
 *   - threshold table (score → band)
 *   - parser
 *
 * Mirrors the F3 `members.risk_score_band` column CHECK constraint
 * added by migration 0094. Score is 0–100 (DB-side bounds also via
 * CHECK).
 *
 * Pure TypeScript — no framework/ORM imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';

export const RISK_BANDS = [
  'healthy',
  'warning',
  'at-risk',
  'critical',
] as const;

export type RiskBand = (typeof RISK_BANDS)[number];

/**
 * Threshold table mapping score (0–100) → band. Boundaries chosen at
 * /speckit.clarify Q1 round 1 + research.md R7 (8-factor formula).
 *   0–24   healthy
 *   25–49  warning
 *   50–74  at-risk
 *   75–100 critical
 *
 * The at-risk widget query (members_at_risk_idx partial index in
 * migration 0094) filters `risk_score >= 50` — i.e. shows `at-risk`
 * + `critical` bands.
 */
export const RISK_BAND_THRESHOLDS: Readonly<
  Record<RiskBand, { readonly minInclusive: number; readonly maxInclusive: number }>
> = {
  healthy: { minInclusive: 0, maxInclusive: 24 },
  warning: { minInclusive: 25, maxInclusive: 49 },
  'at-risk': { minInclusive: 50, maxInclusive: 74 },
  critical: { minInclusive: 75, maxInclusive: 100 },
};

export type RiskBandError =
  | { readonly kind: 'invalid_risk_band'; readonly raw: string }
  | { readonly kind: 'score_out_of_range'; readonly score: number };

export function asRiskBand(raw: string): RiskBand {
  return raw as RiskBand;
}

export function parseRiskBand(raw: string): Result<RiskBand, RiskBandError> {
  if ((RISK_BANDS as readonly string[]).includes(raw)) {
    return ok(raw as RiskBand);
  }
  return err({ kind: 'invalid_risk_band', raw });
}

/**
 * Compute the band for a numeric score using the F6-active fixed table
 * (max=100). Returns an error for non-finite or out-of-range values
 * rather than throwing — callers are expected to surface the typed
 * error (e.g. an at-risk-scorer that produced a malformed score).
 *
 * **Prefer `bandForScoreProportional`** (added F8 Phase 6 Wave A1) — it
 * handles both F6-active (max=100) and F6-inactive (max=70) modes per
 * FR-030. This fixed-table function stays exported for the
 * Phase-1-Wave-D callers that still use it; new code should use the
 * proportional variant.
 */
export function bandForScore(score: number): Result<RiskBand, RiskBandError> {
  if (!Number.isFinite(score) || score < 0 || score > 100) {
    return err({ kind: 'score_out_of_range', score });
  }
  for (const band of RISK_BANDS) {
    const range = RISK_BAND_THRESHOLDS[band];
    if (score >= range.minInclusive && score <= range.maxInclusive) {
      return ok(band);
    }
  }
  // Unreachable — `RISK_BAND_THRESHOLDS` covers 0–100 contiguously.
  /* v8 ignore next */
  return err({ kind: 'score_out_of_range', score });
}

/**
 * F8 Phase 6 Wave A1 — proportional band derivation per FR-030.
 *
 * Bands are computed as fractions of `activeMax` so they remain
 * meaningful whether F6 is active (max=100) or not (max=70):
 *
 *   - `healthy`  = score < 25% of activeMax
 *   - `warning`  = 25% ≤ score < 50% of activeMax
 *   - `at-risk`  = 50% ≤ score < 75% of activeMax
 *   - `critical` = score ≥ 75% of activeMax
 *
 * For activeMax=100 → bands at 0–24 / 25–49 / 50–74 / 75–100.
 * For activeMax=70  → bands at 0–17 / 18–34 / 35–52 / 53–70.
 *
 * `score` MUST be in `[0, activeMax]`; out-of-range inputs return a
 * typed error rather than throwing. `activeMax` MUST be a positive
 * finite number; pathological inputs return `score_out_of_range`.
 */
export function bandForScoreProportional(
  score: number,
  activeMax: number,
): Result<RiskBand, RiskBandError> {
  if (
    !Number.isFinite(score) ||
    !Number.isFinite(activeMax) ||
    activeMax <= 0 ||
    score < 0 ||
    score > activeMax
  ) {
    return err({ kind: 'score_out_of_range', score });
  }
  const ratio = score / activeMax;
  if (ratio < 0.25) return ok('healthy');
  if (ratio < 0.5) return ok('warning');
  if (ratio < 0.75) return ok('at-risk');
  return ok('critical');
}

/** True when band would surface in the at-risk widget (≥50 score range). */
export function isAtRiskWidgetBand(band: RiskBand): boolean {
  return band === 'at-risk' || band === 'critical';
}
