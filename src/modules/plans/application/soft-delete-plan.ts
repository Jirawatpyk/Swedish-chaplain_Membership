/**
 * `soft-delete-plan` use case (T129, US4 FR-010).
 *
 * Admin soft-deletes a plan (sets `deleted_at`). The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns `not_found`
 *      if missing or cross-tenant.
 *   2. Short-circuit idempotent no-op if the plan is already deleted.
 *   3. Ask `MemberAttachmentChecker.countActivePlanMembers` — if > 0,
 *      return `{type: 'has_active_members', count}` so the API maps
 *      to 409 with `details.affected_member_count`. FR-010 says
 *      plans with attached members cannot be deleted.
 *   4. Call `planRepo.softDelete(deletedAt)` using the ClockPort.
 *   5. Append `plan_soft_deleted` audit event with
 *      `{deleted_at: {before: null, after: <ISO string>}}` diff. The
 *      audit adapter JSON-serialises Dates to ISO strings by default,
 *      so the serialized payload matches the test assertion.
 *   6. Return the deleted plan.
 *
 * F2 uses a stub checker that always returns 0 (no `members` table
 * yet). F3 swaps in a real implementation without touching this file.
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

export type SoftDeletePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type SoftDeletePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'has_active_members'; readonly count: number }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type SoftDeletePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function softDeletePlan(
  input: SoftDeletePlanInput,
  deps: SoftDeletePlanDeps,
): Promise<Result<Plan, SoftDeletePlanError>> {
  // 1. Load plan
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

  // 2. Idempotent no-op — already deleted
  if (existing.deleted_at !== null) {
    return ok(existing);
  }

  // 3. Member-attachment check (FR-010)
  let memberCount: number;
  try {
    memberCount = await deps.members.countActivePlanMembers(
      deps.tenant,
      input.planId,
      input.year,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (memberCount > 0) {
    return err({ type: 'has_active_members', count: memberCount });
  }

  // 4. Soft-delete via repo (deleted_at = clock.now())
  const deletedAt = deps.clock.now();
  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.softDelete(
      deps.tenant,
      input.planId,
      input.year,
      deletedAt,
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

  // 5. Append plan_soft_deleted audit event
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_soft_deleted',
      payload: {
        plan_id: input.planId,
        plan_year: input.year,
        diff: {
          deleted_at: {
            before: null,
            after: deletedAt.toISOString(),
          },
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
