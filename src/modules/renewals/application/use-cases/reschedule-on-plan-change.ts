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
 * mid-cycle plan flips.
 *
 * **Failure semantics** (Round 4 CRIT-1 — both emits fire-and-forget):
 *
 * Both audit emits in this file (the bucket-resolution-failed
 * `renewal_schedule_reschedule_skipped` AND the success-path
 * `renewal_schedule_rescheduled`) use `emit()` (own tx), NOT
 * `emitInTx(_tx)`. Round 2 had used `emitInTx` citing Constitution
 * Principle VIII atomicity, but the listener wraps inside the F3-
 * owned plan-change tx (members.change-plan use-case). An `emitInTx`
 * INSERT failure would taint that tx and cause Postgres to downgrade
 * the F3 COMMIT to ROLLBACK — losing the admin's plan-flip silently.
 *
 * Round 3 CRIT-1 fixed the early-return (skipped) emit; Round 4
 * CRIT-1 closes the success-path symmetric gap. Defence-in-depth:
 * `rescheduleAuditEmitFailed{audit_type}` counter (Round 4 IMP-8)
 * fires inside the per-emit try/catch when the audit row never
 * lands, so on-call retains a forensic signal even though the F3
 * plan-flip commits.
 *
 * Idempotent: re-firing the listener for the same old→new bucket
 * pair is a no-op (the audit-port payload's `old_tier_bucket` +
 * `new_tier_bucket` discriminate; same-bucket calls early-return).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { deriveFiscalYear } from '@/lib/fiscal-year';
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
 * InTx variant — receives an already-open tenant tx from the caller and
 * runs within it. Intended for callers that need this work to be atomic
 * with their own transaction.
 *
 * **Not atomic with the surrounding tx by design** (Round 4 CRIT-1):
 * see the file-level "Failure semantics" block above for why both
 * audit emits use `emit()` (own tx) instead of `emitInTx(_tx)` —
 * `emitInTx` would taint the F3 caller's tx and cause silent
 * COMMIT→ROLLBACK on audit-row INSERT failure.
 *
 * Since 063 (Option A) the F2 plan-change bridge (`f2-plan-change-bridge.ts`)
 * calls the NON-`InTx` wrapper (`rescheduleOnPlanChange`) POST-COMMIT —
 * after the plan-flip has committed durably — opening its own
 * `runInTenant` tx. This `InTx` variant is preserved for other callers
 * that still need the in-transaction behaviour. The "inside the F3-owned
 * plan-change tx" phrasing applies to this variant only, NOT to the
 * current bridge path.
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
  // Resolve the member's active cycle UP-FRONT (was loaded later, after
  // the bucket lookups). 070 §86/4 — its `period_from` supplies the
  // fiscal year for the plan lookups below so the tier buckets resolve
  // against the cycle's OWN catalogue year, not "most-recent active". When
  // there is no active cycle (the bucket-resolution-failure forensic path
  // still emits a `reschedule_skipped` audit), fall back to the current
  // fiscal year (server clock) — this caller only reads `tierBucket`
  // (`mode: 'freeze'`), and a plan's bucket is stable across its catalogue
  // years, so the clock-year fallback is safe.
  const activeCycle = await deps.cyclesRepo.findActiveForMember(
    args.tenantId,
    args.memberId,
  );
  const fiscalYear = deriveFiscalYear(
    activeCycle?.periodFrom ?? deps.clock.now().toISOString(),
  );

  // Resolve OLD + NEW tier buckets via plan lookup (070 — exact-year-first
  // via `fiscalYear`; `mode: 'freeze'` because this is a bucket read, not
  // a plan-offer check).
  const oldPlan = await deps.planLookupForRenewal.loadPlanFrozenFields({
    tenantId: args.tenantId,
    planId: args.oldPlanId,
    fiscalYear,
    mode: 'freeze',
  });
  const newPlan = await deps.planLookupForRenewal.loadPlanFrozenFields({
    tenantId: args.tenantId,
    planId: args.newPlanId,
    fiscalYear,
    mode: 'freeze',
  });

  const oldBucket =
    oldPlan.status === 'found' ? oldPlan.plan.tierBucket : null;
  const newBucket =
    newPlan.status === 'found' ? newPlan.plan.tierBucket : null;

  if (oldBucket === null || newBucket === null) {
    // Phase 7 review-fix S-2-errors + Round 4 IMP-3: explicit
    // forensic-chain entry. Without this audit + counter, the F3-
    // owned plan-change tx (members.change-plan use-case, semantically
    // a F2 plan-management operation) would commit silently when plan
    // lookup is broken and the reminder dispatcher would keep using
    // the OLD bucket's policy unobserved.
    const reason: 'old_plan_not_found' | 'new_plan_not_found' | 'both_not_found' =
      oldBucket === null && newBucket === null
        ? 'both_not_found'
        : oldBucket === null
          ? 'old_plan_not_found'
          : 'new_plan_not_found';
    const counterSide: 'old' | 'new' | 'both' =
      reason === 'both_not_found' ? 'both' : reason === 'old_plan_not_found' ? 'old' : 'new';
    renewalsMetrics.rescheduleBucketResolutionFailed(counterSide);
    // Phase 7 review-fix Round 3 CRIT-1 + Round 4 IMP-8: use fire-and-
    // forget `emit()` (own tx) instead of `emitInTx(_tx)` so a row-
    // level INSERT failure (RLS / NOT-NULL / pgEnum drift) does NOT
    // taint the F3-owned plan-change tx (members.change-plan caller).
    // The `rescheduleBucketResolutionFailed` counter above already
    // fired BEFORE the emit (load-bearing forensic signal). Round 4
    // IMP-8 added the dedicated `rescheduleAuditEmitFailed` counter
    // inside the try/catch so audit-row loss is independently
    // observable — `manualPlanChangeListenerFailed` only fires for
    // pre-flight pgEnum-drift throws (the runtime DB-fault swallow
    // contract inside the emitter does NOT escape to wrapListener).
    try {
      await deps.auditEmitter.emit(
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
    } catch (auditErr) {
      renewalsMetrics.rescheduleAuditEmitFailed(
        'renewal_schedule_reschedule_skipped',
      );
      logger.error(
        {
          err: auditErr instanceof Error ? auditErr.message : String(auditErr),
          tenantId: args.tenantId,
          memberId: args.memberId,
          reason,
        },
        '[reschedule-on-plan-change] reschedule_skipped audit emit failed — counter bumped; F3 plan-flip will still commit',
      );
    }
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

  // `activeCycle` was already resolved up-front (above) — it determines
  // which schedule steps are "not yet fired" (offset window after now →
  // expires_at). No active cycle → nothing to reschedule.
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

  // Phase 7 verify-fix C2 + Round 4 CRIT-1 — emit `renewal_schedule_
  // rescheduled` audit (migration 0118 added the pgEnum value).
  //
  // Round 2 used `emitInTx(_tx)` per Principle VIII atomicity, but
  // Round 3 CRIT-1 + Round 4 CRIT-1 traced a Postgres tainted-tx
  // silent-rollback class: an INSERT failure aborts the F3-owned
  // tx, F3's COMMIT downgrades to ROLLBACK, the admin's plan-flip
  // is silently lost. The early-return path was fixed in Round 3;
  // this success-path emit is the symmetric fix in Round 4.
  //
  // `emit()` (own tx) keeps the audit failure isolated; the
  // `rescheduleAuditEmitFailed` counter (Round 4 IMP-8) inside
  // the try/catch is the load-bearing observability signal because
  // `manualPlanChangeListenerFailed` does NOT fire for runtime
  // DB-fault swallows.
  try {
    await deps.auditEmitter.emit(
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
  } catch (auditErr) {
    renewalsMetrics.rescheduleAuditEmitFailed(
      'renewal_schedule_rescheduled',
    );
    logger.error(
      {
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        tenantId: args.tenantId,
        memberId: args.memberId,
        cycleId: activeCycle.cycleId,
        oldTierBucket: oldBucket,
        newTierBucket: newBucket,
      },
      '[reschedule-on-plan-change] rescheduled audit emit failed — counter bumped; F3 plan-flip will still commit',
    );
  }

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
    // S-3 (070 speckit-review): a throw from the in-tx body (cycle/bucket
    // repo read, plan lookup, RLS reject) surfaces as `server_error` to the
    // caller — but this is a fire-and-forget post-commit listener off the F3
    // plan-change, so without a log here the failure is invisible to SRE
    // (the caller may swallow the `server_error`). Log loudly so a non-audit
    // infra fault is observable independent of caller behaviour.
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: input.tenantId,
        memberId: input.memberId,
        errorId: 'F8.RESCHEDULE.WRAPPER_THREW',
      },
      '[reschedule-on-plan-change] unexpected error in reschedule wrapper — F3 plan-flip already committed; reschedule skipped',
    );
    return err({
      kind: 'server_error',
      message: (e as Error)?.message ?? 'unknown',
    });
  }
}
