/**
 * `update-schedule-policy` use-case (F8 admin schedule editor).
 *
 * Admin replaces the step list for a (tenant, tier_bucket) schedule
 * policy. Powers `PUT /api/admin/renewals/settings/schedules/[tierBucket]`
 * (the schedule editor "Save" action — see
 * `src/app/api/admin/renewals/settings/schedules/[tierBucket]/route.ts`).
 *
 * Atomic state+audit per Constitution Principle VIII:
 *   - Opens `runInTenant(ctx, tx => …)` so the upsert + the
 *     `renewal_schedule_policy_updated` audit emit commit together
 *     (or both roll back).
 *   - Steps are validated by the Domain `parseSchedulePolicySteps`
 *     before reaching the repo so the persisted JSONB always satisfies
 *     the Domain invariants (channel discriminant + offset_days range
 *     + step_id uniqueness). DB CHECK constraints provide defence-in-
 *     depth but the use-case is the primary gatekeeper.
 *
 * Audit payload carries `change_diff` per data-model.md § 4 — the
 * step_id sets {added, removed, unchanged} for compact diff display
 * in the audit-viewer (FR-058). Full before/after step bodies are
 * intentionally OMITTED (they live in the Drizzle `updatedAt`
 * row-versioning trail; audit events are a control-plane log, not a
 * full-history mirror).
 *
 * Manager-role enforcement is the route handler's job per the
 * standard F8 RBAC pattern — manager gets 403 + `f8_role_violation_blocked`
 * audit before reaching this use-case. The use-case validates only the
 * input shape (admin actor expected; no manager actor-role accepted).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  TIER_BUCKETS,
  type TierBucket,
} from '../../domain/value-objects/tier-bucket';
import {
  parseSchedulePolicySteps,
  type TenantRenewalSchedulePolicy,
  type SchedulePolicyError,
} from '../../domain/tenant-renewal-schedule-policy';

// ---------------------------------------------------------------------------
// Input schema — tolerates the JSONB-shape steps array directly so route
// handlers don't have to re-shape from the wire format.
// ---------------------------------------------------------------------------

const stepInputSchema = z.object({
  step_id: z.string().min(1),
  offset_days: z.number().int(),
  channel: z.enum(['email', 'task']),
  template_id: z.string().min(1).optional(),
  task_type: z.string().min(1).optional(),
  assignee_role: z.enum(['admin', 'manager', 'executive_director']).optional(),
});

export const updateSchedulePolicyInputSchema = z.object({
  tenantId: z.string().min(1),
  tierBucket: z.enum(TIER_BUCKETS),
  steps: z.array(stepInputSchema).min(1).max(20),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type UpdateSchedulePolicyInput = z.infer<
  typeof updateSchedulePolicyInputSchema
>;

export interface UpdateSchedulePolicyOutput {
  readonly policy: TenantRenewalSchedulePolicy;
  readonly changeDiff: {
    readonly added: readonly string[];
    readonly removed: readonly string[];
    readonly unchanged: readonly string[];
  };
}

export type UpdateSchedulePolicyError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'invalid_steps'; readonly error: SchedulePolicyError };

// ---------------------------------------------------------------------------
// Diff helper — compares prior step_id set vs new step_id set.
// ---------------------------------------------------------------------------

function computeStepDiff(
  prior: ReadonlyArray<{ readonly stepId: string }>,
  next: ReadonlyArray<{ readonly stepId: string }>,
): {
  added: string[];
  removed: string[];
  unchanged: string[];
} {
  const priorIds = new Set(prior.map((s) => s.stepId));
  const nextIds = new Set(next.map((s) => s.stepId));
  const added: string[] = [];
  const removed: string[] = [];
  const unchanged: string[] = [];
  for (const id of nextIds) {
    if (priorIds.has(id)) unchanged.push(id);
    else added.push(id);
  }
  for (const id of priorIds) {
    if (!nextIds.has(id)) removed.push(id);
  }
  return { added, removed, unchanged };
}

// ---------------------------------------------------------------------------
// Use-case
// ---------------------------------------------------------------------------

export async function updateSchedulePolicy(
  deps: RenewalsDeps,
  rawInput: UpdateSchedulePolicyInput,
): Promise<Result<UpdateSchedulePolicyOutput, UpdateSchedulePolicyError>> {
  return withActiveSpan(
    renewalsTracer(),
    'admin_schedule_policy_update',
    {
      'tenant.id': rawInput.tenantId,
      'tier.bucket': rawInput.tierBucket,
      'actor.role': rawInput.actorRole,
    },
    async (span) => {
      const result = await updateInner();
      if (result.ok) {
        span.setAttribute(
          'renewals.added_count',
          result.value.changeDiff.added.length,
        );
        span.setAttribute(
          'renewals.removed_count',
          result.value.changeDiff.removed.length,
        );
        span.setAttribute(
          'renewals.unchanged_count',
          result.value.changeDiff.unchanged.length,
        );
      }
      return result;
    },
  );

  async function updateInner(): Promise<
    Result<UpdateSchedulePolicyOutput, UpdateSchedulePolicyError>
  > {
  const parsed = updateSchedulePolicyInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  // Domain-validate the steps array. This catches every shape that the
  // wire-level zod cannot express (channel-payload discriminant, range,
  // step_id uniqueness). On failure we surface the structured Domain
  // error so the route handler can map to a precise 422 response body.
  const stepsResult = parseSchedulePolicySteps(input.steps);
  if (!stepsResult.ok) {
    return err({ kind: 'invalid_steps', error: stepsResult.error });
  }
  const validatedSteps = stepsResult.value;
  const tierBucket: TierBucket = input.tierBucket;
  // Pre-load prior policy outside the tx for diff computation. RLS hides
  // cross-tenant rows so this lookup also doubles as defence-in-depth.
  // Null prior is fine: it means this tenant_bucket pair has no row yet
  // (a new tenant onboarded without seed-fixture sync); the upsert
  // creates the row + the diff reports every step as "added".
  const prior = await deps.schedulePolicyRepo.findByBucket(
    input.tenantId,
    tierBucket,
  );
  const priorSteps = prior?.steps ?? [];
  const changeDiff = computeStepDiff(priorSteps, validatedSteps);
  // Atomic upsert + audit emit.
  try {
    return await runInTenant(deps.tenant, async (tx) => {
      const policy = await deps.schedulePolicyRepo.upsertSteps(
        tx,
        input.tenantId,
        tierBucket,
        validatedSteps,
      );
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_schedule_policy_updated',
          payload: {
            tier_bucket: tierBucket,
            change_diff: {
              added: changeDiff.added,
              removed: changeDiff.removed,
              unchanged_count: changeDiff.unchanged.length,
            },
            step_count_before: priorSteps.length,
            step_count_after: validatedSteps.length,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
          summary:
            `Admin updated ${tierBucket} schedule policy ` +
            `(+${changeDiff.added.length} -${changeDiff.removed.length} ` +
            `=${changeDiff.unchanged.length})`,
        },
      );
      return ok({
        policy,
        changeDiff: {
          added: changeDiff.added,
          removed: changeDiff.removed,
          unchanged: changeDiff.unchanged,
        },
      });
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: input.tenantId,
        tierBucket,
        correlationId: input.correlationId,
      },
      'updateSchedulePolicy: unexpected error',
    );
    throw e;
  }
  }
}
