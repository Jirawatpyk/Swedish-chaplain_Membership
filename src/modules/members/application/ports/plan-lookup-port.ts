/**
 * Application port — read-only plan lookup from the F2 plans module.
 *
 * Consumed by create/update-member use cases for plan-aware validation
 * (turnover band, startup duration, age eligibility, bundle-change count).
 * Adapter implementation imports from `@/modules/plans` (public barrel) —
 * Application layer knows nothing about F2's internals.
 */
import type { Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { PlanId, TenantId } from '../../domain/member';
import type { RepoError } from './member-repo';

export type PlanSummary = {
  readonly tenantId: TenantId;
  readonly planId: PlanId;
  readonly planYear: number;
  /**
   * English display name of the plan. Canonical admin display — a
   * tenant-localised lookup can be layered on top later via i18n.
   */
  readonly planNameEn: string;
  readonly planCategory: 'corporate' | 'partnership';
  readonly memberTypeScope: 'company' | 'individual' | 'both';
  readonly minTurnoverThb: number | null;
  readonly maxTurnoverThb: number | null;
  readonly maxDurationYears: number | null;
  readonly maxMemberAge: number | null;
  /** For partnership tiers, the corporate tier it bundles. */
  readonly includesCorporatePlanId: PlanId | null;
};

export interface PlanLookupPort {
  getPlan(
    ctx: TenantContext,
    planId: PlanId,
    planYear: number,
  ): Promise<Result<PlanSummary, RepoError>>;

  /**
   * SC-008 — count members on a given plan tier in this tenant.
   * Used by the bundle-change warning dialog (FR-010).
   */
  countAffectedMembers(
    ctx: TenantContext,
    planId: PlanId,
    planYear: number,
  ): Promise<Result<{ count: number }, RepoError>>;
}
