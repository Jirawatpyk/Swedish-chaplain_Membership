/**
 * `undelete-plan` use case (T130, US4 AS4).
 *
 * Admin restores a soft-deleted plan. The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns `not_found` if
 *      missing or cross-tenant. Note: `findOne` returns the row even
 *      if it is soft-deleted — the `showDeleted` filter lives in
 *      `findByTenantAndYear`, NOT in the composite-key lookup.
 *   2. Short-circuit idempotent no-op if the plan is NOT deleted.
 *   3. Call `planRepo.undelete()` which clears `deleted_at` AND forces
 *      `is_active = false` per AS4 (undelete never returns directly
 *      to the active state — the admin must explicitly re-activate).
 *   4. Append `plan_undeleted` audit event with
 *      `{deleted_at: {before: <ISO>, after: null}}` diff. If the row
 *      was active at delete time the repo also flipped `is_active`,
 *      but since `is_active` is normally false before soft-delete
 *      (FR-009 precondition: deactivate → delete), the typical diff
 *      only touches `deleted_at`.
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
import type { AuditDiff, MutableAuditDiff } from '../domain/audit-event';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';

export type UndeletePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type UndeletePlanError =
  | { readonly type: 'not_found' }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type UndeletePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly feeConfigRepo: FeeConfigRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

export async function undeletePlan(
  input: UndeletePlanInput,
  deps: UndeletePlanDeps,
): Promise<Result<Plan, UndeletePlanError>> {
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

  // Idempotent no-op — not deleted
  if (existing.deleted_at === null) {
    return ok(existing);
  }

  const previousDeletedAt = existing.deleted_at;
  const previousActive = existing.is_active;

  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.undelete(
      deps.tenant,
      input.planId,
      input.year,
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

  // Build diff: always clears deleted_at. If the row happened to be
  // is_active=true before soft-delete, the repo forces it false per
  // AS4 — surface that in the audit diff too.
  const mutableDiff: MutableAuditDiff = {
    deleted_at: {
      before: previousDeletedAt.toISOString(),
      after: null,
    },
  };
  if (previousActive === true) {
    mutableDiff.is_active = { before: true, after: false };
  }
  const diff: AuditDiff = mutableDiff;

  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_undeleted',
      payload: {
        plan_id: input.planId,
        plan_year: input.year,
        diff,
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
