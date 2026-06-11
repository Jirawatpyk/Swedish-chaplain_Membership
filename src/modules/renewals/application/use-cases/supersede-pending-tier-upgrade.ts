/**
 * F8 Phase 7 T184 — `supersedePendingTierUpgrade` use-case.
 *
 * F2 → F8 event listener for `member_plan_manually_changed`. When an
 * admin uses F2's `changeMemberPlan` to manually flip a member's
 * plan (mid-cycle override), any active tier-upgrade suggestion for
 * that member is auto-cancelled per FR-039 step 5:
 *
 *   - `open` → `superseded` (pre-acceptance — admin's `open` review
 *     is invalidated; clean cancel)
 *   - `accepted_pending_apply` → `superseded` (post-acceptance —
 *     admin's earlier Accept is invalidated; the manual override
 *     wins)
 *
 * Audit: emits `tier_upgrade_pending_superseded_by_manual_change`
 * with `superseded_from_status` discriminator + the manual-change
 * actor + superseding plan id (forensic chain).
 *
 * Idempotent on terminal states — re-firing the use-case for an
 * already-terminal suggestion is a silent no-op.
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import type { TenantTx } from '@/lib/db';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import { type SuggestionId } from '../../domain/tier-upgrade-suggestion';
// 065 Fix 1 — CAS-loser error from the repo's transitionStatus.
import { TierUpgradeStatusConflictError } from '../ports/tier-upgrade-suggestion-repo';
import type { MemberId, PlanId } from '@/modules/members';
import type { UserId } from '@/modules/auth';

export const supersedePendingTierUpgradeInputSchema = z.object({
  tenantId: z.string().min(1),
  memberId: z.string().uuid(),
  manualChangeActorUserId: z.string().min(1),
  // F2 plan_id is `text` (slug-style — e.g. 'regular', 'premium'),
  // not UUID. See migration 0117 fix on tier_upgrade_suggestions.
  supersedingPlanId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type SupersedePendingTierUpgradeInput = z.infer<
  typeof supersedePendingTierUpgradeInputSchema
>;

export interface SupersedePendingTierUpgradeOutput {
  readonly supersededSuggestionId: SuggestionId | null;
  readonly fromStatus: 'open' | 'accepted_pending_apply' | null;
}

export type SupersedePendingTierUpgradeError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

/**
 * InTx variant — receives an already-open tenant tx from the caller and
 * runs within it, so the supersede + audit emit roll back together with
 * the caller's transaction if it aborts. Intended for callers that need
 * this work to be atomic with their own transaction.
 *
 * Since 063 (Option A) the F2 plan-change bridge (`f2-plan-change-bridge.ts`)
 * calls the NON-`InTx` wrapper (`supersedePendingTierUpgrade`) POST-COMMIT —
 * after the plan-flip has committed durably — opening its own
 * `runInTenant` tx. This `InTx` variant is preserved for other callers
 * that still need the in-transaction behaviour. The "atomic with the F2
 * plan-change tx / threads the F2 tx so it rolls back together" semantics
 * apply to this variant only, NOT to the current bridge path.
 */
export async function supersedePendingTierUpgradeInTx(
  deps: RenewalsDeps,
  tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly memberId: string;
    readonly manualChangeActorUserId: string;
    readonly supersedingPlanId: string;
    readonly correlationId: string;
    readonly requestId: string | null;
  },
): Promise<{
  readonly supersededSuggestionId: SuggestionId | null;
  readonly fromStatus: 'open' | 'accepted_pending_apply' | null;
}> {
  const active = await deps.tierUpgradeRepo.findActiveForMember(
    args.tenantId,
    args.memberId,
  );
  if (active === null) return { supersededSuggestionId: null, fromStatus: null };
  if (active.status !== 'open' && active.status !== 'accepted_pending_apply') {
    return { supersededSuggestionId: null, fromStatus: null };
  }

  const fromStatus = active.status;
  const now = deps.clock.now().toISOString();

  try {
    await deps.tierUpgradeRepo.transitionStatus(
      tx,
      args.tenantId,
      active.suggestionId,
      {
        to: 'superseded' as const,
        // 065 S7 — set-membership CAS, NOT a value-pinned one. A manual
        // override is valid from EITHER `open` OR `accepted_pending_apply`
        // (FR-039 step 5). The `findActiveForMember` read above runs in
        // its OWN tx (the port has no tx arg) and is STALE by the time
        // this UPDATE fires: pinning `expectedFrom: fromStatus` made the
        // CAS no-op when a concurrent accept moved the row across the
        // open→accepted_pending_apply boundary in the read→update window,
        // orphaning the suggestion (it would then re-apply at renewal —
        // money bug). The set guard supersedes regardless of which in-set
        // state the row committed to, mirroring the pre-065 id-only WHERE.
        // `fromStatus` (captured above) is retained for the audit label
        // ONLY — it reflects this use-case's belief at read time, not the
        // committed FROM state.
        expectedFromIn: ['open', 'accepted_pending_apply'] as const,
        closedAt: now,
      },
    );
  } catch (e) {
    // 065 Fix 1 — CAS loser: a concurrent transition moved the
    // suggestion off `fromStatus` after the findActiveForMember read.
    // Documented contract above: idempotent silent no-op on
    // already-transitioned suggestions. The first write in this tx is
    // the UPDATE itself, so skipping the audit emit leaves no partial
    // state behind.
    if (e instanceof TierUpgradeStatusConflictError) {
      return { supersededSuggestionId: null, fromStatus: null };
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'tier_upgrade_pending_superseded_by_manual_change',
      payload: {
        suggestion_id: active.suggestionId,
        superseded_from_status: fromStatus,
        manual_change_actor_user_id:
          args.manualChangeActorUserId as UserId,
        superseding_plan_id: args.supersedingPlanId as PlanId,
      },
    },
    {
      tenantId: args.tenantId,
      actorUserId: args.manualChangeActorUserId,
      actorRole: 'system',
      correlationId: args.correlationId,
      requestId: args.requestId,
    },
  );

  void (active.memberId as MemberId); // type-only assertion

  return { supersededSuggestionId: active.suggestionId, fromStatus };
}

export async function supersedePendingTierUpgrade(
  deps: RenewalsDeps,
  rawInput: SupersedePendingTierUpgradeInput,
): Promise<
  Result<SupersedePendingTierUpgradeOutput, SupersedePendingTierUpgradeError>
> {
  const inputResult = parseInput(
    supersedePendingTierUpgradeInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  try {
    const result = await runInTenant(deps.tenant, async (tx) =>
      supersedePendingTierUpgradeInTx(deps, tx, {
        tenantId: input.tenantId,
        memberId: input.memberId,
        manualChangeActorUserId: input.manualChangeActorUserId,
        supersedingPlanId: input.supersedingPlanId,
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
