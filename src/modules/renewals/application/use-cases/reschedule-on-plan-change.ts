/**
 * F8 Phase 7 T188a — `rescheduleOnPlanChange` use-case.
 *
 * Separate listener concern from `supersedePendingTierUpgrade` (T184).
 * When F2 fires `member_plan_manually_changed` the member's
 * tier-bucket may shift (e.g. Regular → Premium), which means the
 * not-yet-fired schedule steps under the OLD bucket no longer apply
 * — the new bucket's schedule steps take over from the next render.
 *
 * Per spec.md Edge Cases: **already-sent reminders are NOT recalled**;
 * only the not-yet-fired remaining steps for the active cycle change
 * cadence.
 *
 * This use-case computes the diff (cancelled vs new step ids) and
 * emits a single audit `renewal_schedule_rescheduled` carrying the
 * forensic chain so dashboards can attribute schedule changes to
 * mid-cycle plan flips. Atomic with the F2 plan-change tx via
 * `emitInTx` per Constitution Principle VIII.
 *
 * Idempotent: re-firing the listener for the same old→new bucket
 * pair is a no-op (the audit-port payload's `old_tier_bucket` +
 * `new_tier_bucket` discriminate; same-bucket calls early-return).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { TenantTx } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
// Type-only — runtime no-op brand cast (Constitution Principle III).
import type { MemberId, PlanId } from '@/modules/members';

// Phase 7 review-fix C-CODE-1: F2 plan_id is `text` (slug-style — e.g.
// 'regular', 'premium'), not UUID. See migration 0117 fix on
// tier_upgrade_suggestions for the mirror precedent. The original
// `.uuid()` constraint rejected every legitimate F2 plan id at runtime
// (sister use-case `supersede-pending-tier-upgrade.ts:40` already
// shipped the correct `.min(1)` shape).
export const rescheduleOnPlanChangeInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  oldPlanId: z.string().min(1),
  newPlanId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type RescheduleOnPlanChangeInput = z.infer<
  typeof rescheduleOnPlanChangeInputSchema
>;

// Phase 7 review-fix Round 2 IMP-7: bucket fields use Domain
// `TierBucket` literal-union instead of bare string.
import type { TierBucket } from '../../domain/value-objects/tier-bucket';

export interface RescheduleOnPlanChangeOutput {
  readonly cancelledStepIds: ReadonlyArray<string>;
  readonly newStepIds: ReadonlyArray<string>;
  readonly oldTierBucket: TierBucket | null;
  readonly newTierBucket: TierBucket | null;
}

export type RescheduleOnPlanChangeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * Listener entry point — called by the F2 plan-change bridge inside
 * the F2 tx. Atomic with the F2 plan-change.
 */
export async function rescheduleOnPlanChangeInTx(
  deps: RenewalsDeps,
  _tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly memberId: string;
    readonly oldPlanId: string;
    readonly newPlanId: string;
    readonly correlationId: string;
    readonly requestId: string | null;
  },
): Promise<RescheduleOnPlanChangeOutput> {
  // Resolve OLD + NEW tier buckets via plan lookup.
  const oldPlan = await deps.planLookupForRenewal.loadPlanFrozenFields({
    tenantId: args.tenantId,
    planId: args.oldPlanId,
  });
  const newPlan = await deps.planLookupForRenewal.loadPlanFrozenFields({
    tenantId: args.tenantId,
    planId: args.newPlanId,
  });

  const oldBucket =
    oldPlan.status === 'found' ? oldPlan.plan.tierBucket : null;
  const newBucket =
    newPlan.status === 'found' ? newPlan.plan.tierBucket : null;

  if (oldBucket === null || newBucket === null) {
    // Phase 7 review-fix S-2-errors: explicit forensic-chain entry.
    // Without this audit + counter, a F2 plan-flip with broken plan
    // lookup would commit silently and the reminder dispatcher would
    // keep using the OLD bucket's policy unobserved.
    const reason: 'old_plan_not_found' | 'new_plan_not_found' | 'both_not_found' =
      oldBucket === null && newBucket === null
        ? 'both_not_found'
        : oldBucket === null
          ? 'old_plan_not_found'
          : 'new_plan_not_found';
    const counterSide: 'old' | 'new' | 'both' =
      reason === 'both_not_found' ? 'both' : reason === 'old_plan_not_found' ? 'old' : 'new';
    renewalsMetrics.rescheduleBucketResolutionFailed(counterSide);
    // Phase 7 review-fix Round 2 CRIT-1: emitInTx is the atomic-must-
    // throw flavour — wrapping it in try/catch + swallow violates
    // Constitution Principle VIII (the throw IS the rollback signal).
    // The outer F2 plan-flip tx caller (`change-plan.ts`) wraps every
    // listener through `wrapListener` which catches + log + counts +
    // swallows for failure isolation, so an audit-emit throw here
    // bubbles to that wrapper without rolling F2 back. Result: F2
    // commits, audit row missing, BUT counter `rescheduleBucket
    // ResolutionFailed` already fired BEFORE the emit and `manual
    // PlanChangeListenerFailed` fires inside `wrapListener` — both
    // observability signals intact.
    await deps.auditEmitter.emitInTx(
      _tx,
      {
        type: 'renewal_schedule_reschedule_skipped',
        payload: {
          member_id: args.memberId as MemberId,
          old_plan_id: args.oldPlanId as PlanId,
          new_plan_id: args.newPlanId as PlanId,
          reason,
        },
      },
      {
        tenantId: args.tenantId,
        actorUserId: null,
        actorRole: 'system',
        correlationId: args.correlationId,
        requestId: args.requestId,
      },
    );
    logger.warn(
      {
        tenantId: args.tenantId,
        oldPlanId: args.oldPlanId,
        newPlanId: args.newPlanId,
        oldBucket,
        newBucket,
        reason,
      },
      '[reschedule-on-plan-change] could not resolve buckets — emitting reschedule_skipped audit',
    );
    return {
      cancelledStepIds: [],
      newStepIds: [],
      oldTierBucket: oldBucket,
      newTierBucket: newBucket,
    };
  }

  if (oldBucket === newBucket) {
    return {
      cancelledStepIds: [],
      newStepIds: [],
      oldTierBucket: oldBucket,
      newTierBucket: newBucket,
    };
  }

  // Resolve the member's active cycle to determine which schedule
  // steps are "not yet fired" (offset window after now → expires_at).
  const activeCycle = await deps.cyclesRepo.findActiveForMember(
    args.tenantId,
    args.memberId,
  );
  if (activeCycle === null) {
    return {
      cancelledStepIds: [],
      newStepIds: [],
      oldTierBucket: oldBucket,
      newTierBucket: newBucket,
    };
  }

  // Load both bucket policies in parallel.
  const [oldPolicy, newPolicy] = await Promise.all([
    deps.schedulePolicyRepo.findByBucket(args.tenantId, oldBucket),
    deps.schedulePolicyRepo.findByBucket(args.tenantId, newBucket),
  ]);

  const now = deps.clock.now();
  const expiresAt = new Date(activeCycle.expiresAt);
  // Future steps = steps whose computed dispatch date is AFTER now.
  const futureStepIdsFor = (
    policy: Awaited<
      ReturnType<typeof deps.schedulePolicyRepo.findByBucket>
    >,
  ): ReadonlyArray<string> => {
    if (policy === null) return [];
    return policy.steps
      .filter((step) => {
        const dispatchAt = new Date(
          expiresAt.getTime() - step.offsetDays * 24 * 60 * 60 * 1000,
        );
        return dispatchAt.getTime() > now.getTime();
      })
      .map((step) => step.stepId);
  };

  const oldFuture = new Set(futureStepIdsFor(oldPolicy));
  const newFuture = new Set(futureStepIdsFor(newPolicy));
  const cancelled = [...oldFuture].filter((id) => !newFuture.has(id));
  const added = [...newFuture].filter((id) => !oldFuture.has(id));

  // No-op when both step sets are identical (e.g. policies coincide).
  if (cancelled.length === 0 && added.length === 0) {
    return {
      cancelledStepIds: [],
      newStepIds: [],
      oldTierBucket: oldBucket,
      newTierBucket: newBucket,
    };
  }

  // Phase 7 verify-fix C2 — emit `renewal_schedule_rescheduled` audit
  // (migration 0118 added the pgEnum value). Atomic with the F2 plan-
  // change tx per Constitution Principle VIII.
  await deps.auditEmitter.emitInTx(
    _tx,
    {
      type: 'renewal_schedule_rescheduled',
      payload: {
        member_id: args.memberId as MemberId,
        cycle_id: activeCycle.cycleId,
        old_tier_bucket: oldBucket,
        new_tier_bucket: newBucket,
        cancelled_step_ids: cancelled,
        new_step_ids: added,
      },
    },
    {
      tenantId: args.tenantId,
      actorUserId: null,
      actorRole: 'system',
      correlationId: args.correlationId,
      requestId: args.requestId,
    },
  );

  logger.debug(
    {
      tenantId: args.tenantId,
      memberId: args.memberId,
      oldTierBucket: oldBucket,
      newTierBucket: newBucket,
      cancelledStepIds: cancelled,
      newStepIds: added,
      cycleId: activeCycle.cycleId,
    },
    '[reschedule-on-plan-change] schedule diff committed',
  );
  return {
    cancelledStepIds: cancelled,
    newStepIds: added,
    oldTierBucket: oldBucket,
    newTierBucket: newBucket,
  };
}

export async function rescheduleOnPlanChange(
  deps: RenewalsDeps,
  rawInput: RescheduleOnPlanChangeInput,
): Promise<
  Result<RescheduleOnPlanChangeOutput, RescheduleOnPlanChangeError>
> {
  const inputResult = parseInput(rescheduleOnPlanChangeInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  try {
    const result = await runInTenant(deps.tenant, async (tx) =>
      rescheduleOnPlanChangeInTx(deps, tx, {
        tenantId: input.tenantId,
        memberId: input.memberId,
        oldPlanId: input.oldPlanId,
        newPlanId: input.newPlanId,
        correlationId: input.correlationId,
        requestId: input.requestId ?? null,
      }),
    );
    return ok(result);
  } catch (e) {
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}
