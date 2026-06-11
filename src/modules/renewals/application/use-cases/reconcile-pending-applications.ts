/**
 * F8 Phase 7 T185 — `reconcilePendingApplications` use-case.
 *
 * Weekly cron entry per E19 reconciliation pass. Detects orphaned
 * `accepted_pending_apply` suggestions whose `target_apply_at_cycle_id`
 * cycle is `cancelled` or `lapsed` (the F4 invoice-paid hook will
 * never fire for them) and transitions them to `dismissed` with
 * `reason='orphan_target_cycle_terminal'` so a fresh cycle's eval
 * pass can re-suggest cleanly.
 *
 * Audit per orphan: emits `tier_upgrade_pending_orphan_detected`
 * with the target cycle's status discriminant. Atomic with the
 * dismiss transition per Principle VIII.
 *
 * Idempotent: dismissed orphan rows are excluded from the next
 * pass's `listOrphanedPending` query (status filter at the repo
 * layer).
 *
 * Pure Application — no framework imports (Constitution Principle III).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import { parseInput } from './_lib/parse-input';
import type { CycleId } from '../../domain/renewal-cycle';
import type { MemberId } from '@/modules/members';
// 065 S1/S2 — discriminate the benign CAS-loser (a concurrent
// transition already resolved the orphan between the list read and this
// dismiss UPDATE) from a genuine dismiss failure.
import { TierUpgradeStatusConflictError } from '../ports/tier-upgrade-suggestion-repo';

export const reconcilePendingApplicationsInputSchema = z.object({
  tenantId: z.string().min(1),
  correlationId: z.string().min(1),
  requestId: z.string().nullable().optional(),
});

export type ReconcilePendingApplicationsInput = z.infer<
  typeof reconcilePendingApplicationsInputSchema
>;

export interface ReconcilePendingApplicationsOutput {
  readonly orphansDetected: number;
  readonly orphansDismissed: number;
  /**
   * 065 S1/S2 — orphans that were ALREADY transitioned by a concurrent
   * accept / supersede / apply between the `listOrphanedPending` read
   * and this cron's dismiss UPDATE (CAS-loser, `TierUpgradeStatusConflictError`).
   * These are NOT failures — the orphan is already resolved — so they
   * are counted here separately and do NOT bump the alertable
   * `tierUpgradeReconcileErrors` counter. The accounting invariant is
   * `orphansDetected === orphansDismissed + orphansSkippedBenign +
   * (genuine failures)`, so `detected > dismissed` no longer implies a
   * failure on its own.
   */
  readonly orphansSkippedBenign: number;
  readonly durationMs: number;
}

export type ReconcilePendingApplicationsError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

const ORPHAN_REASON_TERMINAL_CYCLE = 'orphan_target_cycle_terminal';
const ORPHAN_REASON_PLAN_DIVERGED = 'orphan_member_plan_diverged';

export async function reconcilePendingApplications(
  deps: RenewalsDeps,
  rawInput: ReconcilePendingApplicationsInput,
): Promise<
  Result<
    ReconcilePendingApplicationsOutput,
    ReconcilePendingApplicationsError
  >
> {
  const inputResult = parseInput(
    reconcilePendingApplicationsInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;

  const startedAt = Date.now();
  let dismissed = 0;
  // 065 S1/S2 — benign CAS-losers (orphan already resolved concurrently).
  let skippedBenign = 0;

  let orphans: Awaited<
    ReturnType<typeof deps.tierUpgradeRepo.listOrphanedPending>
  >;
  try {
    orphans = await deps.tierUpgradeRepo.listOrphanedPending(input.tenantId);
  } catch (e) {
    return err({
      kind: 'server_error',
      message: `list_orphaned_failed: ${(e as Error)?.message ?? 'unknown'}`,
    });
  }

  const now = deps.clock.now();
  const closedAt = now.toISOString();

  for (const orphan of orphans) {
    // Round 6 W-002 — discriminate dismiss reason by orphan shape.
    // Terminal-cycle orphans get the original
    // `orphan_target_cycle_terminal` reason; manual-plan-change
    // orphans (W-002) get the new `orphan_member_plan_diverged`
    // reason so dashboards can attribute backstop frequency to the
    // F2 supersede-listener failure rate vs cycle-terminal rate.
    const dismissedReason =
      orphan.targetCycleStatus === 'manual_plan_change'
        ? ORPHAN_REASON_PLAN_DIVERGED
        : ORPHAN_REASON_TERMINAL_CYCLE;
    try {
      await runInTenant(deps.tenant, async (tx) => {
        await deps.tierUpgradeRepo.transitionStatus(
          tx,
          input.tenantId,
          orphan.suggestion.suggestionId,
          {
            to: 'dismissed' as const,
            // 065 Fix 1 — CAS guard: `listOrphanedPending` only
            // returns `accepted_pending_apply` rows; a concurrent
            // transition between that read and this UPDATE throws
            // `TierUpgradeStatusConflictError`, which the per-orphan
            // catch below already treats as log-and-continue.
            expectedFrom: 'accepted_pending_apply' as const,
            dismissedReason,
            closedAt,
          },
        );
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'tier_upgrade_pending_orphan_detected',
            payload: {
              suggestion_id: orphan.suggestion.suggestionId,
              member_id: orphan.suggestion.memberId as MemberId,
              target_apply_at_cycle_id:
                (orphan.suggestion.targetApplyAtCycleId ?? '') as CycleId,
              target_cycle_status: orphan.targetCycleStatus,
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: null,
            actorRole: 'cron',
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
          },
        );
      });
      dismissed++;
    } catch (e) {
      // 065 S1/S2 — benign CAS-loser FIRST, BEFORE the alertable
      // counter + error log. `listOrphanedPending` only returns
      // `accepted_pending_apply` rows; if a concurrent accept /
      // supersede / apply transitioned the row off that state between
      // the list read and this dismiss UPDATE, the CAS throws
      // `TierUpgradeStatusConflictError`. That is NOT a failure — the
      // orphan is already resolved — so it must NOT bump
      // `tierUpgradeReconcileErrors` (which routes Vercel alerts) and
      // must NOT log at `error` level (which would page on-call for a
      // self-healing race). Count it as a benign skip and continue.
      if (e instanceof TierUpgradeStatusConflictError) {
        skippedBenign++;
        logger.info(
          {
            suggestionId: orphan.suggestion.suggestionId,
            actualStatus: e.actualStatus,
          },
          '[reconcile-pending-applications] orphan already transitioned concurrently — benign skip',
        );
        continue;
      }
      // Phase 7 review-fix S-3-errors: per-tenant counter so multi-
      // tenant fan-out can route alerts when one tenant's orphans
      // persistently fail to dismiss. The aggregate
      // `orphansDetected vs orphansDismissed` mismatch was already
      // returned in the result, but Vercel alert rules attach to OTel
      // counters not log strings.
      renewalsMetrics.tierUpgradeReconcileErrors(input.tenantId);
      logger.error(
        {
          err: e instanceof Error ? e.message : String(e),
          suggestionId: orphan.suggestion.suggestionId,
        },
        '[reconcile-pending-applications] orphan dismiss failed — continuing',
      );
    }
  }

  return ok({
    orphansDetected: orphans.length,
    orphansDismissed: dismissed,
    orphansSkippedBenign: skippedBenign,
    durationMs: Date.now() - startedAt,
  });
}
