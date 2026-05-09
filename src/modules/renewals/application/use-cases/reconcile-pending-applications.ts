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
  readonly durationMs: number;
}

export type ReconcilePendingApplicationsError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'server_error'; readonly message: string };

const ORPHAN_REASON = 'orphan_target_cycle_terminal';

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
    try {
      await runInTenant(deps.tenant, async (tx) => {
        await deps.tierUpgradeRepo.transitionStatus(
          tx,
          input.tenantId,
          orphan.suggestion.suggestionId,
          {
            to: 'dismissed' as const,
            dismissedReason: ORPHAN_REASON,
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
    durationMs: Date.now() - startedAt,
  });
}
