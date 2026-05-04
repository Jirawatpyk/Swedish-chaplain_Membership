/**
 * F8 Phase 3 Wave H2 · T058 — `cancel-cycle` use-case.
 *
 * Admin manual cancel with reason audit. Transitions a renewal cycle
 * from one of {`upcoming`, `reminded`, `awaiting_payment`,
 * `pending_admin_reactivation`} to `cancelled`.
 *
 * Atomic state+audit per Constitution Principle VIII:
 *   - Opens `runInTenant(ctx, tx => …)` so the cycle UPDATE +
 *     `renewal_cycle_cancelled` audit emit commit together (or both
 *     roll back).
 *   - Race protection: the Drizzle adapter's `transitionStatus` does
 *     `WHERE status = $from` so concurrent cancels deterministically
 *     produce one winner + one `CycleTransitionConflictError`.
 *
 * Non-cancellable terminal states (`completed | cancelled | lapsed`)
 * yield `cycle_not_cancellable` per FR-046 invariant. Cross-tenant
 * probes yield `cycle_not_found` + `renewal_cross_tenant_probe` audit.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  parseCycleId,
  type CycleId,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';
import { isTerminalCycleStatus } from '../../domain/value-objects/cycle-status';

export const cancelCycleInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  reason: z.string().min(1).max(500),
  actorUserId: z.string().min(1),
  actorRole: z.enum(['admin']),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type CancelCycleInput = z.infer<typeof cancelCycleInputSchema>;

export interface CancelCycleOutput {
  readonly status: 'cancelled';
  readonly closedAt: string;
}

export type CancelCycleError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | { readonly kind: 'cycle_not_cancellable'; readonly currentStatus: string };

export async function cancelCycle(
  deps: RenewalsDeps,
  rawInput: CancelCycleInput,
): Promise<Result<CancelCycleOutput, CancelCycleError>> {
  const parsed = cancelCycleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdResult = parseCycleId(input.cycleId);
  if (!cycleIdResult.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdResult.value;

  // Pre-load cycle to surface the right error variant cleanly. RLS
  // hides cross-tenant rows so this lookup also doubles as a probe.
  const cycle = await deps.cyclesRepo.findById(input.tenantId, cycleId);
  if (!cycle) {
    // Probe audit MUST NOT block the 404 response — wrap defensively
    // even though `emit()` already swallows internally (defence in depth
    // against future emitter implementations that might not).
    try {
      await deps.auditEmitter.emit(
        {
          type: 'renewal_cross_tenant_probe',
          payload: {
            attempted_cycle_id: cycleId,
            route: 'cancel-cycle',
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          cycleId,
          correlationId: input.correlationId,
        },
        'cancelCycle: probe audit emit failed (swallowed — never blocks 404)',
      );
    }
    return err({ kind: 'cycle_not_found' });
  }
  if (isTerminalCycleStatus(cycle.status)) {
    return err({
      kind: 'cycle_not_cancellable',
      currentStatus: cycle.status,
    });
  }

  // Atomic transition + audit emit.
  try {
    const closedAt = new Date().toISOString();
    return await runInTenant(deps.tenant, async (tx) => {
      // Per-(tenant, cycle) advisory lock — prevents two concurrent
      // admin cancels from racing past the pre-load check. Same lock
      // namespace as mark-paid-offline ensures the two paths serialise
      // correctly when an admin attempts both within the same instant.
      await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

      // Re-load inside lock to defeat TOCTOU (state may have changed
      // between findById and lock acquisition).
      const lockedCycle = await deps.cyclesRepo.findById(
        input.tenantId,
        cycleId,
      );
      if (!lockedCycle) {
        return err({ kind: 'cycle_not_found' as const });
      }
      if (isTerminalCycleStatus(lockedCycle.status)) {
        return err({
          kind: 'cycle_not_cancellable' as const,
          currentStatus: lockedCycle.status,
        });
      }

      await deps.cyclesRepo.transitionStatus(tx, input.tenantId, cycleId, {
        from: lockedCycle.status,
        to: 'cancelled',
        closedAt,
        closedReason: 'cancelled',
      });
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_cycle_cancelled',
          payload: {
            cycle_id: cycleId,
            member_id: lockedCycle.memberId,
            reason: input.reason,
            previous_status: lockedCycle.status,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
          summary: `Admin cancelled renewal cycle ${cycleId}: ${input.reason.slice(0, 200)}`,
        },
      );
      return ok({ status: 'cancelled' as const, closedAt });
    });
  } catch (e) {
    if (e instanceof CycleTransitionConflictError) {
      // Concurrent cancel won the race — surface as not-cancellable
      // with the new actual status for UI feedback.
      return err({
        kind: 'cycle_not_cancellable',
        currentStatus: e.actualStatus,
      });
    }
    if (e instanceof CycleNotFoundError) {
      // RLS-hidden between pre-load and tx; treat as not-found.
      return err({ kind: 'cycle_not_found' });
    }
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        cycleId,
        tenantId: input.tenantId,
      },
      'cancelCycle: unexpected error',
    );
    throw e;
  }
}
