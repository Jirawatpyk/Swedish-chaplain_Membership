/**
 * F9 US4 `BenefitUsage` domain VO (T063 / FR-019–FR-023).
 *
 * Pure, framework-free value object describing a member's per-membership-year
 * benefit consumption vs entitlement, plus the aggregate under-use signal.
 *
 * Membership year = **calendar year in the tenant timezone** (FR-023). This
 * module stays tz-agnostic: the Application use-case derives the year's UTC
 * millisecond bounds (it owns the tz) and feeds them to `yearElapsedPct`; the
 * arithmetic here is testable without an Intl/tz dependency (consistent with
 * how `compute-dashboard-snapshot` derives the tenant-tz year in Application).
 *
 * Under-use rule (FR-021): warn when `elapsed-year %` − `aggregate consumed %`
 * ≥ 25 percentage points. The aggregate consumed % is the **mean of the
 * (used ÷ entitlement) ratio of each quantifiable benefit** — benefits with no
 * numeric entitlement (unlimited / active-only, or entitlement 0) carry no
 * ratio and are excluded. A member with no quantifiable benefits never warns.
 *
 * No imports — pure TypeScript (Constitution Principle III: Domain is
 * dependency-free).
 */

/** Gap (elapsed% − consumed%) at/above which the under-use warning fires. */
export const UNDER_USE_WARNING_THRESHOLD_PCT = 25;

/** The numeric benefits F9 quantifies for the usage dashboard (FR-019). */
export type QuantifiableBenefitKey = 'eblast' | 'cultural_tickets';

/**
 * A benefit with a numeric annual entitlement. Only emitted when the plan
 * actually grants it (`entitlement > 0`); a plan that grants 0 of a benefit
 * simply omits it (it is not a benefit of that plan). `lastUsedAt` is ISO 8601
 * UTC or null when never used this year.
 */
export interface QuantifiableBenefit {
  readonly key: QuantifiableBenefitKey;
  readonly used: number;
  readonly entitlement: number;
  readonly lastUsedAt: string | null;
}

/**
 * A non-quantified / unlimited / active-only benefit (FR-020) — shown as
 * "available/active" rather than as a numeric quota. `key` is a stable i18n
 * suffix resolved by presentation (`benefits.active.<key>`).
 */
export interface ActiveBenefit {
  readonly key: string;
}

export interface BenefitUsage {
  /** Calendar year in the tenant timezone the figures are scoped to (FR-023). */
  readonly membershipYear: number;
  /** Fraction of the membership year elapsed, 0–100. */
  readonly elapsedYearPct: number;
  /** Numeric benefits the plan grants (entitlement > 0). */
  readonly quantifiable: readonly QuantifiableBenefit[];
  /** Unlimited / active-only benefits (FR-020). */
  readonly active: readonly ActiveBenefit[];
  /** Mean consumed %, or null when there is no quantifiable benefit. */
  readonly aggregateConsumedPct: number | null;
  /** `elapsedYearPct − aggregateConsumedPct`, or null when no aggregate. */
  readonly gapPct: number | null;
  /** True when `gapPct ≥ 25` (FR-021). Always false with no aggregate. */
  readonly underUseWarning: boolean;
}

/**
 * Fraction of the membership year elapsed (0–100), clamped at the boundaries.
 * Pure arithmetic over UTC millisecond bounds the caller derives from the
 * tenant-tz calendar year. `yearEndMs` is the exclusive end (start of next
 * year); a caller passing `start === end` is degenerate and returns 0.
 */
export function yearElapsedPct(
  nowMs: number,
  yearStartMs: number,
  yearEndMs: number,
): number {
  if (yearEndMs <= yearStartMs) return 0;
  if (nowMs <= yearStartMs) return 0;
  if (nowMs >= yearEndMs) return 100;
  return ((nowMs - yearStartMs) / (yearEndMs - yearStartMs)) * 100;
}

export interface UnderUseAssessment {
  readonly aggregateConsumedPct: number | null;
  readonly gapPct: number | null;
  readonly underUseWarning: boolean;
}

/**
 * Aggregate under-use assessment from the per-benefit consumption ratios
 * (used ÷ entitlement). Ratios are NOT clamped — an over-used benefit (ratio
 * > 1) legitimately offsets an under-used one in the mean. An empty ratio set
 * (no quantifiable benefit) yields a null aggregate and never warns (FR-021).
 */
export function assessUnderUse(
  ratios: readonly number[],
  elapsedYearPct: number,
): UnderUseAssessment {
  if (ratios.length === 0) {
    return { aggregateConsumedPct: null, gapPct: null, underUseWarning: false };
  }
  const mean = ratios.reduce((sum, r) => sum + r, 0) / ratios.length;
  const aggregateConsumedPct = mean * 100;
  const gapPct = elapsedYearPct - aggregateConsumedPct;
  return {
    aggregateConsumedPct,
    gapPct,
    underUseWarning: gapPct >= UNDER_USE_WARNING_THRESHOLD_PCT,
  };
}

export interface BuildBenefitUsageInput {
  readonly membershipYear: number;
  readonly elapsedYearPct: number;
  readonly quantifiable: readonly QuantifiableBenefit[];
  readonly active: readonly ActiveBenefit[];
}

/**
 * Assemble the full `BenefitUsage` VO. The aggregate is computed over the
 * supplied `quantifiable` entries (callers must already have excluded
 * entitlement-0 / unlimited benefits — those belong in `active`).
 */
export function buildBenefitUsage(input: BuildBenefitUsageInput): BenefitUsage {
  // Guard the divide: only finite, non-negative ratios feed the aggregate. A
  // malformed entitlement (0 / negative / NaN from a bad plan-matrix row) would
  // otherwise yield Infinity/NaN and poison the whole member's consumed % +
  // warning (review-run I-2). Callers already exclude entitlement-0 benefits;
  // this is defence-in-depth for any future caller of buildBenefitUsage.
  const ratios = input.quantifiable
    .map((b) => b.used / b.entitlement)
    .filter((r) => Number.isFinite(r) && r >= 0);
  const assessment = assessUnderUse(ratios, input.elapsedYearPct);
  return {
    membershipYear: input.membershipYear,
    elapsedYearPct: input.elapsedYearPct,
    quantifiable: input.quantifiable,
    active: input.active,
    aggregateConsumedPct: assessment.aggregateConsumedPct,
    gapPct: assessment.gapPct,
    underUseWarning: assessment.underUseWarning,
  };
}
