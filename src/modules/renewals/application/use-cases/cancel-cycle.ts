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
// Type-only import keeps Application layer free of cross-module runtime
// coupling (Constitution Principle III). The brand is a compile-time
// no-op cast — `lockedCycle.memberId` is a bare `string` per the
// RenewalCycle domain shape, so the inline `as MemberId` is semantically
// identical to invoking `asMemberId(...)` and avoids importing a
// runtime value from `@/modules/members`.
import type { MemberId } from '@/modules/members';
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
  | { readonly kind: 'cycle_not_cancellable'; readonly currentStatus: string }
  // K1-C7: explicit server_error variant for unexpected throws inside
  // the use-case body. Application use-cases MUST surface failure as a
  // Result, not a thrown exception (Constitution Principle III).
  // Throwing escapes the type system — callers that don't wrap in
  // try/catch silently get TypeScript-typed Result<...> returning
  // calls that actually throw at runtime.
  | { readonly kind: 'server_error'; readonly message: string };

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

  // Round 5 W-03 / Round 6 W-R5-3 / Round 7 W-R6-3 / Round 8 W-R7-4 —
  // strip ALL control + structural-format + non-canonical-space bytes
  // from admin-supplied reason before audit_log persistence. Round 8
  // consolidates the prior 2-pass approach into a single regex covering
  // the full Unicode separator + format class. Coverage:
  //   - U+0000-U+001F (C0 controls inc. CR/LF/TAB/BEL/BS/ESC)
  //   - U+007F-U+009F (DEL + C1 inc. NEL, 8-bit CSI)
  //   - U+00A0 (NBSP), U+1680 (OGHAM SPACE)
  //   - U+2000-U+200F (en/em/thin/hair/zero-width spaces + format)
  //   - U+2028/U+2029 (LINE/PARAGRAPH SEPARATOR)
  //   - U+202F (NARROW NBSP), U+205F (MEDIUM MATH SPACE)
  //   - U+3000 (IDEOGRAPHIC SPACE), U+FEFF (BOM)
  // All are log-injection / homoglyph / record-splitting vectors
  // against terminal-rendering log readers and \p{Z}-tokenising log
  // aggregators (Loki / Datadog / Splunk). Admin "reason" free-text
  // legitimately needs only ASCII + standard U+0020 spaces.
  const sanitizedReason = input.reason.replace(
    /[\u0000-\u001f\u007f-\u00a0\u1680\u2000-\u200f\u2028-\u202f\u205f\u3000\ufeff]/g,
    ' ',
  );
  // Atomic transition + audit emit.
  try {
    // Round-5 review-finding M6 — `deps.clock.now()` instead of `new
    // Date()` for testability + consistency with sibling modules.
    const closedAt = deps.clock.now().toISOString();
    return await runInTenant(deps.tenant, async (tx) => {
      // Per-(tenant, cycle) advisory lock — prevents two concurrent
      // admin cancels from racing past the pre-load check. Same lock
      // namespace as mark-paid-offline ensures the two paths serialise
      // correctly when an admin attempts both within the same instant.
      await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

      // Re-load inside lock to defeat TOCTOU (state may have changed
      // between findById and lock acquisition). Round 5 B2 fix: use
      // findByIdInTx with the lock-holding tx so the re-read sees the
      // same snapshot as the lock — `findById` would open a separate
      // tx and could observe stale state.
      const lockedCycle = await deps.cyclesRepo.findByIdInTx(
        tx,
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
            member_id: lockedCycle.memberId as MemberId,
            reason: sanitizedReason,
            previous_status: lockedCycle.status,
          },
        },
        {
          tenantId: input.tenantId,
          actorUserId: input.actorUserId,
          actorRole: input.actorRole,
          correlationId: input.correlationId,
          requestId: input.requestId ?? null,
          summary: `Admin cancelled renewal cycle ${cycleId}: ${sanitizedReason.slice(0, 200)}`,
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
        err: e instanceof Error ? e : new Error(String(e)),
        cycleId,
        tenantId: input.tenantId,
      },
      'cancelCycle: unexpected error',
    );
    // R4-W2 (staff-review-2026-05-09): never surface raw exception
    // messages — they may carry DB column names, query fragments, or
    // connection strings. Route handlers may relay this `message` field
    // to UI toasts; keep the forensic detail in the logger.error call
    // above only.
    return err({
      kind: 'server_error',
      message: 'internal error — see server logs',
    });
  }
}
