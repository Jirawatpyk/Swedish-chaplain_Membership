/**
 * Shared `setPlanActive` helper — parameterised on direction (T127/T128, US4 FR-009).
 *
 * Both `activatePlan` and `deactivatePlan` delegate to this function.
 * The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns `not_found`
 *      (404-never-403) if the plan doesn't exist or belongs to a
 *      different tenant.
 *   2. Derive the current PlanState and call `canTransition` — returns
 *      `not_found` if the transition is illegal (e.g. activating a
 *      soft-deleted plan). Soft-deleted plans must be undeleted first.
 *   3. Short-circuit idempotent no-op: if already in target state,
 *      return the existing plan WITHOUT writing an audit event.
 *   4. Call `planRepo.setActive(target)` to flip the flag.
 *   5. Append the corresponding audit event with the is_active diff.
 *   6. Return the updated plan.
 *
 * **Audit-as-use-case-failure** — same contract as create-plan /
 * update-plan. An audit write failure propagates as a use-case
 * failure; silently swallowing it would corrupt the compliance trail.
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type { AuditPort, PlanRepo } from './ports';
import { recordAuditEvent } from './record-audit-event';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';
import { planStateOf, canTransition } from '../domain/plan-state';

export type SetPlanActiveInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
};

export type SetPlanActiveError =
  | { readonly type: 'not_found' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type SetPlanActiveDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
};

export async function setPlanActive(
  input: SetPlanActiveInput,
  deps: SetPlanActiveDeps,
  /** `true` = activate, `false` = deactivate */
  target: boolean,
): Promise<Result<Plan, SetPlanActiveError>> {
  const targetState = target ? 'active' : 'inactive';
  const eventType = target ? 'plan_activated' : 'plan_deactivated';

  // 1. Load plan via RLS-scoped repo
  let existing: Plan | undefined;
  try {
    existing = await deps.planRepo.findOne(deps.tenant, input.planId, input.year);
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!existing) {
    return err({ type: 'not_found' });
  }

  // 2. State machine guard — reject illegal transitions (e.g. soft_deleted → active)
  const currentState = planStateOf(existing);
  const transition = canTransition(currentState, targetState);
  if (!transition.ok) {
    // "404 never 403" — treat illegal transitions the same as not_found
    return err({ type: 'not_found' });
  }

  // 3. Idempotent no-op — already in target state
  if (currentState === targetState) {
    return ok(existing);
  }

  // 4. Flip the flag
  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.setActive(
      deps.tenant,
      input.planId,
      input.year,
      target,
      input.actorUserId,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!updated) {
    return err({ type: 'not_found' });
  }

  // 5. Append audit event with is_active diff
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: eventType,
      payload: {
        plan_id: input.planId,
        plan_year: input.year,
        diff: {
          is_active: { before: !target, after: target },
        },
      },
    },
  );
  if (!auditResult.ok) {
    return err({
      type: 'audit_failed',
      message:
        auditResult.error.type === 'invalid_payload'
          ? auditResult.error.issues.join('; ')
          : auditResult.error.message,
    });
  }

  return ok(updated);
}
