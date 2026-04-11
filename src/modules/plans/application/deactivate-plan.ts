/**
 * `deactivate-plan` use case (T128, US4 FR-009).
 *
 * Mirror of `activate-plan` — flips `is_active` to `false`, emits the
 * `plan_deactivated` audit event with the opposite diff shape.
 * See `activate-plan.ts` for the rationale on no-op short-circuit and
 * audit-as-use-case-failure contract.
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

export type DeactivatePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type DeactivatePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type DeactivatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function deactivatePlan(
  input: DeactivatePlanInput,
  deps: DeactivatePlanDeps,
): Promise<Result<Plan, DeactivatePlanError>> {
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

  // Idempotent no-op — already inactive
  if (existing.is_active === false) {
    return ok(existing);
  }

  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.setActive(
      deps.tenant,
      input.planId,
      input.year,
      false,
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

  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_deactivated',
      payload: {
        plan_id: input.planId,
        plan_year: input.year,
        diff: {
          is_active: { before: true, after: false },
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
