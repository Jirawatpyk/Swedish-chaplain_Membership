/**
 * `soft-delete-plan` use case (T129, US4 FR-010).
 *
 * Admin soft-deletes a plan (sets `deleted_at`). The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns `not_found`
 *      if missing or cross-tenant.
 *   2. Short-circuit idempotent no-op if the plan is already deleted.
 *   3. Call `planRepo.softDeleteGuarded(...)` — this method runs in ONE
 *      `runInTenant` tx: acquires `pg_advisory_xact_lock` on
 *      `plans:softdelete:<tenantSlug>:<planId>:<planYear>`, counts active
 *      members (status=active|inactive), refuses if count>0, and sets
 *      `deleted_at` if 0. Returns a discriminated union:
 *        - `{kind:'deleted',plan}` → step 4 (audit)
 *        - `{kind:'has_active_members',count}` → 409
 *        - `{kind:'not_found'}` → 404 (row vanished between step 1 and step 3)
 *   4. Append `plan_soft_deleted` audit event with
 *      `{deleted_at: {before: null, after: <ISO string>}}` diff. The
 *      audit adapter JSON-serialises Dates to ISO strings by default,
 *      so the serialized payload matches the test assertion.
 *   5. Return the deleted plan.
 *
 * W0-02 fix: the former two-step pattern (separate `MemberAttachmentChecker`
 * round-trip + `planRepo.softDelete` call) has been replaced by the single
 * atomic `softDeleteGuarded` method that serialises under a shared advisory
 * lock — see `plan-repo.ts` for the lock key and `change-plan.ts` for Side B.
 * The `MemberAttachmentChecker` port and `members` dep remain in `PlansDeps`
 * for backward compat (used by other possible callers and tests that were not
 * refactored in W0-02); this use case no longer calls it.
 *
 * **F3 TODO**: When F3 adds the real `MemberAttachmentChecker`, also
 * add a "referenced by partnership plans" guard — soft-deleting a
 * corporate plan that is still linked via `includes_corporate_plan_id`
 * on an active partnership plan would leave a dangling reference.
 */

import { err, ok, type Result } from '@/lib/result';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
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
  readonly audit: AuditPort;
  readonly clock: ClockPort;
};

export async function softDeletePlan(
  input: SoftDeletePlanInput,
  deps: SoftDeletePlanDeps,
): Promise<Result<Plan, SoftDeletePlanError>> {
  // 1. Load plan (read-only; outside the advisory lock — safe for the
  //    idempotent short-circuit and the initial not_found gate).
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

  // 3. Atomic guard: advisory-lock + count-check + soft-delete in one tx.
  //    (W0-02 fix — replaces the former separate countActivePlanMembers +
  //    softDelete two-step pattern.)
  const deletedAt = deps.clock.now();
  let guardResult: Awaited<ReturnType<PlanRepo['softDeleteGuarded']>>;
  try {
    guardResult = await deps.planRepo.softDeleteGuarded(
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

  if (guardResult.kind === 'has_active_members') {
    return err({ type: 'has_active_members', count: guardResult.count });
  }
  if (guardResult.kind === 'not_found') {
    return err({ type: 'not_found' });
  }

  const updated = guardResult.plan;

  // 4. Append plan_soft_deleted audit event
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
