/**
 * T011 (F8 Phase 2 Wave B) — `scheduleNextRenewalPlanChange` use-case.
 *
 * Captures admin intent to switch a member's plan AT the next renewal
 * boundary. Atomic supersede+insert: any prior pending row for the
 * SAME (member, cycle) is flipped to `superseded` first, then a fresh
 * `pending` row lands. Terminal rows on the same (member, cycle) are
 * left untouched (data-model.md § 2.9 partial unique allows them to
 * coexist alongside one fresh pending row).
 *
 * F2 boundary contract — research.md R13:
 *   - F8 calls this from its accept-tier-upgrade flow (Phase 5+ T187).
 *   - F4's renewal-invoice-creation hook resolves `getEffectivePlanForRenewal`.
 *   - F4's invoice-paid hook calls `transitionStatus(..., 'applied')` (Phase 5+).
 *   - F2 manual `changeMemberPlan` emits `member_plan_manually_changed`
 *     (T013); F8 listens and calls `transitionStatus(..., 'superseded')`
 *     for the matching pending row (Phase 5+ T184).
 *
 * Pure Application code — no framework imports (Constitution Principle III).
 */
import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { ScheduledPlanChangeRepo } from './ports';
import type {
  ScheduledPlanChange,
  ScheduleNextRenewalPlanChangeError,
  ScheduleNextRenewalPlanChangeInput,
} from '../domain/scheduled-plan-change';

export interface ScheduleNextRenewalPlanChangeDeps {
  readonly tenant: TenantContext;
  readonly repo: ScheduledPlanChangeRepo;
}

export async function scheduleNextRenewalPlanChange(
  deps: ScheduleNextRenewalPlanChangeDeps,
  input: ScheduleNextRenewalPlanChangeInput,
): Promise<Result<ScheduledPlanChange, ScheduleNextRenewalPlanChangeError>> {
  // Light Domain validation — full zod input schema lives at the API
  // boundary; here we only assert what's needed for the repo write to
  // be safe.
  if (!input.memberId) return err({ code: 'invalid_input', field: 'memberId' });
  if (!input.effectiveAtCycleId)
    return err({ code: 'invalid_input', field: 'effectiveAtCycleId' });
  if (!input.fromPlanId)
    return err({ code: 'invalid_input', field: 'fromPlanId' });
  if (!input.toPlanId)
    return err({ code: 'invalid_input', field: 'toPlanId' });
  if (!input.scheduledByUserId)
    return err({ code: 'invalid_input', field: 'scheduledByUserId' });
  if (input.fromPlanId === input.toPlanId)
    return err({ code: 'invalid_input', field: 'toPlanId' });

  try {
    // Atomic supersede + insert pair (Constitution Principle VIII —
    // Reliability). The repo's `supersedeAndInsertPendingAtomically`
    // wraps both writes in a single DB tx; a failure on either statement
    // rolls both back so the (tenant, member, cycle) never observes a
    // "no pending row" intermediate state. Resolves Wave B verify-run
    // finding F1 (the earlier two-call pattern via `transitionStatus`
    // + `insertPending` had a crash window between calls).
    //
    // Terminal rows on the same (member, cycle) are left untouched by
    // the adapter — the partial unique
    // `(tenant_id, member_id, effective_at_cycle_id) WHERE status='pending'`
    // permits any number of terminal rows to coexist alongside one
    // fresh pending row (data-model.md § 2.9).
    const result = await deps.repo.supersedeAndInsertPendingAtomically(
      deps.tenant,
      input,
    );
    return ok(result.inserted);
  } catch (e) {
    return err({
      code: 'server_error',
      message: `scheduleNextRenewalPlanChange: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }
}
