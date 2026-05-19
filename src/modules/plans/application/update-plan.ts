/**
 * `update-plan` use case (T116, US3 FR-012 + FR-014).
 *
 * Admin edits an existing plan's mutable fields. The flow:
 *
 *   1. Load the plan via `planRepo.findOne` — returns
 *      `not_found` (404-never-403) if the plan doesn't exist or
 *      belongs to a different tenant (RLS-filtered).
 *   2. Validate the partial patch through `planPatchSchema`. Shape
 *      faults land in `invalid_body` (→ 400); cross-field integrity
 *      rules (partnership↔corporate) land in
 *      `partnership_corporate_mismatch` (→ 422). The classification
 *      helper mirrors the one in `create-plan.ts` so the two paths
 *      stay consistent.
 *   3. Run `detectLockedFieldChanges(oldPlan, patch, currentYear)` —
 *      if non-empty, return `prior_year_locked_fields` (→ 422) with
 *      the list of offending fields. The UI uses this to render a
 *      "clone to current year + edit" offer (FR-014).
 *   4. Apply the patch via `planRepo.update`. The repo re-runs the
 *      guard inside its transaction as a defence-in-depth check — if
 *      it fires, we surface a `server_error` because the Application
 *      layer already blocked the same state and a race is a bug.
 *   5. Compute the before/after diff (only changed fields) and
 *      append a `plan_updated` audit event with that diff.
 *   6. Return the updated plan.
 *
 * **Audit failure is a use-case failure** — same contract as create-plan.
 *
 * LWW concurrency: two concurrent edits from different admins race at
 * the SQL UPDATE layer. The later write wins; earlier non-overlapping
 * column writes survive because Drizzle's `.set()` only touches the
 * columns named in the patch. See research.md § 8 for the decision
 * not to implement optimistic locking in F2.
 */

import { err, ok, type Result } from '@/lib/result';
import { planMetrics } from '@/lib/metrics';
import type { TenantContext } from '@/modules/tenants';
import type {
  AuditPort,
  ClockPort,
  MemberAttachmentChecker,
  PlanRepo,
} from './ports';
import { recordAuditEvent } from './record-audit-event';
import { classifyZodIssues } from './classify-zod-issues';
import type { Plan, PlanSlug, PlanYear } from '../domain/plan';
import {
  detectLockedFieldChanges,
  type LockedField,
} from '../domain/locked-field-rule';
import {
  planPatchSchema,
  type PlanPatchInput,
  type PlanPatchOutput,
} from '../domain/plan-validators';
import type { AuditDiff, MutableAuditDiff } from '../domain/audit-event';

// --- Input / output types ---------------------------------------------------

export type UpdatePlanInput = {
  readonly planId: PlanSlug;
  readonly year: PlanYear;
  readonly patch: PlanPatchInput;
  readonly actorUserId: string;
  readonly requestId: string;
  readonly sourceIp: string | null;
  readonly idempotencyKey: string;
};

export type UpdatePlanError =
  | {
      readonly type: 'invalid_body';
      readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>;
    }
  | {
      readonly type: 'partnership_corporate_mismatch';
      readonly issues: ReadonlyArray<string>;
    }
  | { readonly type: 'not_found' }
  | {
      readonly type: 'prior_year_locked_fields';
      readonly locked_fields: ReadonlyArray<LockedField>;
    }
  | { readonly type: 'idempotency_conflict' }
  | { readonly type: 'audit_failed'; readonly message: string }
  | { readonly type: 'server_error'; readonly message: string };

export type UpdatePlanDeps = {
  readonly tenant: TenantContext;
  readonly planRepo: PlanRepo;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  readonly members: MemberAttachmentChecker;
};

// --- Diff helper ------------------------------------------------------------

/**
 * Recursive deep-equal comparison for audit diff computation.
 * Plan fields are never arrays (only scalars, nulls, LocaleText objects,
 * and BenefitMatrix JSONB) — array values are treated as changed.
 * Avoids `JSON.stringify` which is sensitive to property ordering.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  // Plan locked/diff fields are never arrays — treat any array value as changed.
  if (Array.isArray(a) || Array.isArray(b)) return false;

  const keysA = Object.keys(a as Record<string, unknown>);
  const keysB = Object.keys(b as Record<string, unknown>);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) =>
    deepEqual(
      (a as Record<string, unknown>)[k],
      (b as Record<string, unknown>)[k],
    ),
  );
}

/**
 * Compute the `{field: {before, after}}` diff between the old plan
 * and the validated patch. Only fields that are present in the patch
 * AND have a value different from the current plan are included.
 */
function computeDiff(
  oldPlan: Plan,
  patch: PlanPatchOutput,
): AuditDiff {
  const diff: MutableAuditDiff = {};
  const patchFields = Object.keys(patch) as Array<keyof PlanPatchOutput>;
  for (const field of patchFields) {
    const before = (oldPlan as unknown as Record<string, unknown>)[field];
    const after = (patch as unknown as Record<string, unknown>)[field];
    if (after === undefined) continue;
    if (deepEqual(before, after)) continue;
    diff[field] = { before, after };
  }
  return diff;
}

// --- Use case ---------------------------------------------------------------

export async function updatePlan(
  input: UpdatePlanInput,
  deps: UpdatePlanDeps,
): Promise<Result<Plan, UpdatePlanError>> {
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

  // 2. Validate patch
  const parsed = planPatchSchema.safeParse(input.patch);
  if (!parsed.success) {
    const classified = classifyZodIssues(parsed.error.issues);
    if (classified.kind === 'integrity') {
      return err({
        type: 'partnership_corporate_mismatch',
        issues: classified.details,
      });
    }
    return err({ type: 'invalid_body', issues: classified.details });
  }
  const patch = parsed.data;

  // 3. Prior-year lock check
  const currentYear = deps.clock.currentYear();
  const lockedChanges = detectLockedFieldChanges(
    existing,
    patch as Partial<Plan>,
    currentYear,
  );
  if (lockedChanges.length > 0) {
    return err({
      type: 'prior_year_locked_fields',
      locked_fields: lockedChanges,
    });
  }

  // 4. Compute diff BEFORE the update so we capture before/after cleanly.
  //    If the diff is empty (client sent fields whose values match the
  //    stored row), short-circuit the use-case: no DB write, no audit
  //    emit, return the existing plan. This guarantees the write+audit
  //    invariant — if `planRepo.update` runs, an audit row is appended.
  //    A regression in `computeDiff` that returned `{}` for a real
  //    change previously persisted the row silently with no audit
  //    trail; that path is now unreachable.
  const diff = computeDiff(existing, patch);
  if (Object.keys(diff).length === 0) {
    // R2 Batch 3i (R2-S7) — observability signal for noisy clients
    // submitting phantom-edit PATCHes. Counter is fire-and-forget;
    // `safeMetric` inside the helper guarantees no exception leaks.
    planMetrics.updateNoOpShortCircuit(deps.tenant.slug);
    return ok(existing);
  }

  // 5. Apply patch via repo (defence-in-depth guard re-runs inside tx)
  let updated: Plan | undefined;
  try {
    updated = await deps.planRepo.update(
      deps.tenant,
      input.planId,
      input.year,
      patch,
      input.actorUserId,
    );
  } catch (e) {
    return err({
      type: 'server_error',
      message: e instanceof Error ? e.message : String(e),
    });
  }
  if (!updated) {
    // Row vanished between findOne and update — racy delete, treat as not_found
    return err({ type: 'not_found' });
  }

  // 6. Append plan_updated audit event with the diff. Always emits when
  //    `planRepo.update` ran — empty-diff short-circuit above ensures
  //    write+audit stay paired.
  const auditResult = await recordAuditEvent(
    deps.audit,
    {
      tenant: deps.tenant,
      actorUserId: input.actorUserId,
      requestId: input.requestId,
      sourceIp: input.sourceIp,
    },
    {
      event_type: 'plan_updated',
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
