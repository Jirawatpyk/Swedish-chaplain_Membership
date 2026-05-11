/**
 * T012 (F8 Phase 2 Wave B) — `getEffectivePlanForRenewal` resolver.
 *
 * Resolves the plan_id that an upcoming renewal invoice should be
 * priced against. F4's renewal-invoice-creation hook calls this at
 * cycle-creation time (Phase 5+ — US5 T183).
 *
 * Resolution order:
 *   1. If there is a `pending` `scheduled_plan_changes` row for
 *      (member, cycle) → return its `to_plan_id` (source `'scheduled'`).
 *   2. Otherwise → call `currentPlanResolver.resolveCurrentPlanId` and
 *      return that (source `'current'`).
 *
 * Terminal rows (`applied`, `superseded`, `cancelled`) are ignored —
 * they live on as audit trail only. Only `pending` drives resolution.
 *
 * Pure Application code — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  CurrentPlanResolverPort,
  ScheduledPlanChangeRepo,
} from './ports';
import type {
  EffectivePlanForRenewal,
  GetEffectivePlanForRenewalError,
} from '../domain/scheduled-plan-change';

export interface GetEffectivePlanForRenewalDeps {
  readonly tenant: TenantContext;
  readonly repo: ScheduledPlanChangeRepo;
  readonly currentPlanResolver: CurrentPlanResolverPort;
}

export interface GetEffectivePlanForRenewalInput {
  readonly memberId: string;
  readonly cycleId: string;
}

export async function getEffectivePlanForRenewal(
  deps: GetEffectivePlanForRenewalDeps,
  input: GetEffectivePlanForRenewalInput,
): Promise<Result<EffectivePlanForRenewal, GetEffectivePlanForRenewalError>> {
  try {
    const pending = await deps.repo.findPendingForCycle(
      deps.tenant,
      input.memberId,
      input.cycleId,
    );
    if (pending) {
      return ok({ planId: pending.toPlanId, source: 'scheduled' });
    }
    const currentPlanId = await deps.currentPlanResolver.resolveCurrentPlanId(
      deps.tenant,
      input.memberId,
    );
    return ok({ planId: currentPlanId, source: 'current' });
  } catch (e) {
    return err({
      code: 'server_error',
      message: `getEffectivePlanForRenewal: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }
}
