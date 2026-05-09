/**
 * F8 Phase 7 T179 — `TierUpgradeEvalCandidateRepo` Application port.
 *
 * Composite-query reader for the weekly tier-upgrade-evaluate cron
 * (T179 `evaluateTierUpgrade`). Returns enriched rows containing
 * everything the cron's decision tree needs:
 *
 *   - `memberId`, `tenantId`
 *   - `currentPlanId` — `members.plan_id`
 *   - `currentRenewalTierBucket` — joined from `membership_plans`
 *   - `turnoverThb` — `members.turnover_thb` (nullable)
 *   - `paidInvoiceVolume12mThb` — sum of paid F4 invoices in last 365d
 *
 * Why a NEW port instead of extending `DispatchCandidateRepo`:
 * separation of concerns. `DispatchCandidateRepo` is the daily
 * reminder-dispatcher composite (hot path, ~5,000 rows/day);
 * `TierUpgradeEvalCandidateRepo` is the weekly cron composite
 * (~5,000 rows/week, different join shape).
 *
 * Phase 7 review-fix I-TYPE-1: bucket label is `TierBucket` typed.
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TierBucket } from '../../domain/value-objects/tier-bucket';

export interface TierUpgradeEvalCandidate {
  readonly tenantId: string;
  readonly memberId: string;
  readonly currentPlanId: string;
  /** Joined from `membership_plans.renewal_tier_bucket` (Domain TierBucket). */
  readonly currentRenewalTierBucket: TierBucket;
  /** `members.turnover_thb` — nullable per F3 schema. */
  readonly turnoverThb: number | null;
  /**
   * Sum of paid F4 invoices in the last 365 days for this member, in
   * THB. Zero when no paid invoices exist. Computed by the adapter via
   * a CTE join on `invoices` filtered by status='paid' AND
   * paid_at >= now() - INTERVAL '365 days'.
   */
  readonly paidInvoiceVolume12mThb: number;
}

export interface TierUpgradeEvalCandidatePage {
  readonly items: ReadonlyArray<TierUpgradeEvalCandidate>;
  readonly nextCursor: string | null;
}

export interface TierUpgradeEvalCandidateListArgs {
  readonly pageSize: number;
  readonly cursor?: string;
}

export interface TierUpgradeEvalCandidateRepo {
  /**
   * Cursor-paginated list of "active members" (per FR-007a canonical
   * definition: `members.status='active'` AND `renewal_cycles.status
   * NOT IN ('lapsed','cancelled')`) ordered by `(member_id ASC)` for
   * deterministic batching. Filters out members whose
   * `members.plan_id` is NULL (no current plan).
   */
  list(
    tenantId: string,
    args: TierUpgradeEvalCandidateListArgs,
  ): Promise<TierUpgradeEvalCandidatePage>;
}
