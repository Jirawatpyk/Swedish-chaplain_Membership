/**
 * `activate-plan` use case (T127, US4 FR-009).
 *
 * Admin flips `is_active = true` on a plan. The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns `not_found`
 *      (404-never-403) if the plan doesn't exist or belongs to a
 *      different tenant.
 *   2. Short-circuit idempotent no-op: if `is_active === true` already,
 *      return the existing plan WITHOUT writing an audit event (no
 *      state change → nothing to log). Prevents audit-log pollution
 *      from retried requests or the UI racing itself.
 *   3. Call `planRepo.setActive(true)` to flip the flag.
 *   4. Append `plan_activated` audit event with
 *      `{is_active: {before: false, after: true}}` diff.
 *   5. Return the updated plan.
 *
 * **Audit-as-use-case-failure** — same contract as create-plan /
 * update-plan. An audit write failure propagates as a use-case
 * failure; silently swallowing it would corrupt the compliance trail.
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
  FeeConfigRepo,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { recordAuditEvent } from './record-audit-event';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';

export type ActivatePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type ActivatePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type ActivatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function activatePlan(
  input: ActivatePlanInput,
  deps: ActivatePlanDeps,
): Promise<Result<Plan, ActivatePlanError>> {
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

  // 2. Idempotent no-op — already in target state
  if (existing.is_active === true) {
    return ok(existing);
  }

  // 3. Flip the flag
  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.setActive(
      deps.tenant,
      input.planId,
      input.year,
      true,
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

  // 4. Append plan_activated audit event with is_active diff
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_activated',
      payload: {
        plan_id: input.planId,
        plan_year: input.year,
        diff: {
          is_active: { before: false, after: true },
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
