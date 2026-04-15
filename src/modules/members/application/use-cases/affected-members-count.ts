/**
 * `affected-members-count` use case (T085, US3 FR-010).
 *
 * Given a (plan_id, plan_year), returns the count of members currently
 * enrolled on that plan in the tenant. Drives the bundle-change warning
 * dialog when an admin re-targets a Partnership tier to a different
 * corporate bundle.
 *
 * SLO: p95 < 200 ms at 500-member tenant (SC-008). Backed by the
 * composite index `members_tenant_status_plan_idx`.
 *
 * Only active/inactive members count — archived are excluded (they're no
 * longer on the plan for billing/bundle purposes).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { PlanLookupPort } from '../ports/plan-lookup-port';

export type AffectedMembersCountInput = {
  readonly planId: string;
  readonly planYear: number;
};

export type AffectedMembersCountError = {
  type: 'server_error';
  message: string;
};

export type AffectedMembersCountDeps = {
  tenant: TenantContext;
  plans: PlanLookupPort;
};

export async function affectedMembersCount(
  input: AffectedMembersCountInput,
  deps: AffectedMembersCountDeps,
): Promise<Result<{ count: number }, AffectedMembersCountError>> {
  const result = await deps.plans.countAffectedMembers(
    deps.tenant,
    input.planId,
    input.planYear,
  );
  if (!result.ok)
    return err({
      type: 'server_error',
      message: `affected-members: ${result.error.code}`,
    });
  return ok({ count: result.value.count });
}
