/**
 * T046 (F8 Phase 2 Wave E) — `TenantRenewalSchedulePolicyRepo` port.
 *
 * Repository over `tenant_renewal_schedule_policies` (Wave C
 * migration 0089; 5-row-per-tenant tier-bucket → reminder ladder
 * mapping). Hot path for the dispatcher cron — reads are dominant;
 * adapter caches per-tenant.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import type { TenantRenewalSchedulePolicy } from '../../domain/tenant-renewal-schedule-policy';
import type { TierBucket } from '../../domain/value-objects/tier-bucket';
import type { ReminderStep } from '../../domain/value-objects/reminder-step';

export interface TenantRenewalSchedulePolicyRepo {
  /**
   * Look up the policy for a (tenant, tier_bucket). Returns null when
   * no policy is configured (rare — SweCham seed in migration 0089
   * provides defaults; tenant onboarding mirrors). Use-case falls
   * back to a reduced no-op behaviour when null + emits an audit
   * for observability.
   */
  findByBucket(
    tenantId: string,
    tierBucket: TierBucket,
  ): Promise<TenantRenewalSchedulePolicy | null>;

  /** List all 5 policies for a tenant — used by admin config screen. */
  listAllForTenant(
    tenantId: string,
  ): Promise<ReadonlyArray<TenantRenewalSchedulePolicy>>;

  /**
   * Replace the steps for a (tenant, bucket). Caller pre-validates
   * the steps via `parseSchedulePolicySteps` from the Domain layer
   * before calling this — adapter trusts the array.
   */
  upsertSteps(
    tx: TenantTx,
    tenantId: string,
    tierBucket: TierBucket,
    steps: ReadonlyArray<ReminderStep>,
  ): Promise<TenantRenewalSchedulePolicy>;
}
