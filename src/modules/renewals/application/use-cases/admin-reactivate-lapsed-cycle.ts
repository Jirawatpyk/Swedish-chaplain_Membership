/**
 * F8 Phase 5 Wave A · T136 — `adminReactivateLapsedCycle`.
 *
 * Admin approves a cycle that's stuck in `pending_admin_reactivation`
 * after a payment landed against an admin-blocked auto-reactivation
 * member (FR-005b override). The use-case transitions the cycle from
 * `pending_admin_reactivation` → `completed` with `closed_reason =
 * 'admin_reactivated'` and emits `lapsed_member_admin_reactivated`
 * audit atomically.
 *
 * Concurrency guard: per-(tenant, cycle) advisory lock via
 * `acquireCycleLockInTx` (namespace `renewals:`, disjoint from F4
 * `invoicing:` and F5 `payments:`). Defeats the dual-admin-click race
 * (two admins approving the same pending cycle simultaneously).
 *
 * State precondition: cycle MUST be in `pending_admin_reactivation`.
 * Other statuses yield `cycle_not_pending`. After the lock acquires we
 * re-read via `findByIdInTx` to defeat TOCTOU between read + lock.
 *
 * Audit: `lapsed_member_admin_reactivated` is in the F8 catalogue
 * (pgEnum value added in migration 0109). Emit-in-tx per Constitution
 * Principle VIII.
 *
 * Out of scope (deferred to T123 mark-cycle-complete-from-invoice-paid):
 *   - Advancing `members.expires_at`
 *   - Creating the next `RenewalCycle` row
 * The cycle's existing `expires_at` was already advanced when the
 * payment was originally recorded (entered the pending state). Admin
 * approval here releases the hold; subsequent rollover is handled by
 * the F4 paid-callback path that fires when payment was made.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  parseCycleId,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import type { CycleStatus } from '../../domain/value-objects/cycle-status';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';

export const adminReactivateLapsedCycleInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  actorUserId: z.string().min(1),
  actorRole: z.literal('admin'),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type AdminReactivateLapsedCycleInput = z.infer<
  typeof adminReactivateLapsedCycleInputSchema
>;

export interface AdminReactivateLapsedCycleOutput {
  readonly cycleStatus: 'completed';
  readonly closedReason: 'admin_reactivated';
  readonly closedAt: string;
}

export type AdminReactivateLapsedCycleError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | {
      readonly kind: 'cycle_not_pending';
      readonly currentStatus: CycleStatus | 'unknown';
    }
  | { readonly kind: 'server_error'; readonly message: string };

export async function adminReactivateLapsedCycle(
  deps: RenewalsDeps,
  rawInput: AdminReactivateLapsedCycleInput,
): Promise<
  Result<
    AdminReactivateLapsedCycleOutput,
    AdminReactivateLapsedCycleError
  >
> {
  const parsed = adminReactivateLapsedCycleInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return err({
      kind: 'invalid_input',
      message: parsed.error.issues[0]?.message ?? 'invalid input',
    });
  }
  const input = parsed.data;
  const cycleIdParsed = parseCycleId(input.cycleId);
  if (!cycleIdParsed.ok) {
    return err({ kind: 'invalid_input', message: 'invalid cycle id' });
  }
  const cycleId: CycleId = cycleIdParsed.value;

  return runInTenant(deps.tenant, async (tx) => {
    // Per-cycle advisory lock — auto-released at tx end.
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

    // Tx-bound re-read after lock to defeat TOCTOU.
    const cycle: RenewalCycle | null = await deps.cyclesRepo.findByIdInTx(
      tx,
      input.tenantId,
      cycleId,
    );
    if (!cycle) {
      return err({ kind: 'cycle_not_found' });
    }
    if (cycle.status !== 'pending_admin_reactivation') {
      return err({
        kind: 'cycle_not_pending',
        currentStatus: cycle.status,
      });
    }

    const closedAt = new Date().toISOString();
    let updated: RenewalCycle;
    try {
      updated = await deps.cyclesRepo.transitionStatus(
        tx,
        input.tenantId,
        cycleId,
        {
          from: 'pending_admin_reactivation',
          to: 'completed',
          closedAt,
          closedReason: 'admin_reactivated',
        },
      );
    } catch (e) {
      if (e instanceof CycleTransitionConflictError) {
        // Another tx already moved the cycle out of pending_admin_reactivation
        // between our re-read + transition. Re-read once for the
        // user-friendly error.
        const re = await deps.cyclesRepo.findByIdInTx(
          tx,
          input.tenantId,
          cycleId,
        );
        return err({
          kind: 'cycle_not_pending',
          currentStatus: re?.status ?? 'unknown',
        });
      }
      if (e instanceof CycleNotFoundError) {
        return err({ kind: 'cycle_not_found' });
      }
      logger.error(
        { err: e instanceof Error ? e.message : String(e), cycleId },
        '[admin-reactivate-lapsed-cycle] transition failed',
      );
      return err({
        kind: 'server_error',
        message: 'cycle transition failed',
      });
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'lapsed_member_admin_reactivated' as const,
          payload: {
            cycle_id: updated.cycleId,
            member_id: updated.memberId,
            actor_user_id: input.actorUserId,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: 'admin',
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
        },
      );
    } catch (e) {
      // Constitution Principle VIII reverse-direction atomicity: audit
      // emit failure inside tx MUST roll back the state mutation.
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[admin-reactivate-lapsed-cycle] audit emit failed inside tx — rolling back',
      );
      throw e;
    }

    return ok({
      cycleStatus: 'completed',
      closedReason: 'admin_reactivated',
      closedAt,
    });
  });
}
