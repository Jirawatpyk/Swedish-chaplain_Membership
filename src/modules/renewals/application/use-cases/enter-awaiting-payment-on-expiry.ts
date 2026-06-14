/**
 * F8-completion slice 2 · Task 2.3 — `enterAwaitingPaymentOnExpiry`.
 *
 * The T-0 expiry cron. Walks cycles in `upcoming`/`reminded` whose
 * `expires_at <= now` and flips them to `awaiting_payment` so the
 * member self-service confirm + paid-completion paths become reachable
 * (until this cron runs, no cycle is payable for most members).
 *
 * This is a 1:1 clone of `lapseCyclesOnGraceExpiry`'s concurrency +
 * fault-isolation scaffold, with four deltas:
 *   1. eligibility via `listCyclesEligibleForAwaitingPayment`
 *      (`status IN ('upcoming','reminded') AND expires_at <= now`);
 *   2. the transition is `from: reread.status ∈ {upcoming,reminded}`,
 *      `to: 'awaiting_payment'` (NOT awaiting_payment → lapsed);
 *   3. the audit event is `renewal_entered_awaiting_payment` with the
 *      `source: 'cron'` discriminator (Resolved #3) + `entered_at`;
 *   4. NO tenant-settings / grace-period lookup — eligibility is
 *      `expires_at <= now` with zero grace offset, so the grace block
 *      from the lapse clone is dropped entirely.
 *
 * The `<= now` eligibility boundary (vs the lapse cron's
 * `< now - grace`) keeps the two crons disjoint in one pass: a cycle
 * becomes `awaiting_payment` HERE at T-0, and only LATER (after the
 * grace window) does `lapseCyclesOnGraceExpiry` consider it. The two
 * crons therefore compose: enter → awaiting_payment, later lapse →
 * lapsed.
 *
 * Concurrency: per-cycle advisory lock + tx-bound re-read (TOCTOU)
 * mirrors the lapse cron. A concurrent member confirm-renewal Step-1
 * flip (slice 2.5) + this cron cannot both win the transition — the
 * loser sees a `CycleTransitionConflictError` (or a re-read status
 * drift) and skips silently.
 *
 * Outcome taxonomy: `flipped | race_skipped | error` with the count
 * invariant `flipped + race_skipped + errors === cyclesProcessed`.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null`). Route
 * handler validates Bearer `CRON_SECRET` before invoking.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asMemberId } from '@/modules/members';
import { parseInput } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  CycleId,
  RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';

export const enterAwaitingPaymentOnExpiryInputSchema = z.object({
  tenantId: z.string().min(1),
  /** Injected clock for deterministic tests. */
  now: z.date(),
  /**
   * Optional cap on how many cycles to process per cron run. Defaults
   * to 1000 — typical chambers have <100 cycles reaching T-0 per day,
   * so a single run handles everything.
   */
  pageSize: z.number().int().min(1).max(5000).optional(),
  correlationId: z.string().min(1),
});

export type EnterAwaitingPaymentOnExpiryInput = z.infer<
  typeof enterAwaitingPaymentOnExpiryInputSchema
>;

export interface EnterAwaitingPaymentOnExpiryOutput {
  readonly cyclesProcessed: number;
  /** Cycles flipped `upcoming|reminded` → `awaiting_payment`. */
  readonly flipped: number;
  /** Cycles that lost the TOCTOU race (status drifted) + skipped silently. */
  readonly raceSkipped: number;
  /** Audit emit / DB transition that threw — for SRE alert. */
  readonly errors: number;
}

export type EnterAwaitingPaymentOnExpiryError = {
  readonly kind: 'invalid_input';
  readonly message: string;
};

export type EnterAwaitingPaymentOnExpiryDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo' | 'auditEmitter'
>;

export async function enterAwaitingPaymentOnExpiry(
  deps: EnterAwaitingPaymentOnExpiryDeps,
  rawInput: EnterAwaitingPaymentOnExpiryInput,
): Promise<
  Result<
    EnterAwaitingPaymentOnExpiryOutput,
    EnterAwaitingPaymentOnExpiryError
  >
> {
  const inputResult = parseInput(
    enterAwaitingPaymentOnExpiryInputSchema,
    rawInput,
  );
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;
  const pageSize = input.pageSize ?? 1000;

  // Eligible = `upcoming|reminded` cycles whose `expires_at <= now`
  // (reached T-0). No grace offset — that is what keeps this cron
  // disjoint from the lapse cron in a single pass.
  const page = await deps.cyclesRepo.listCyclesEligibleForAwaitingPayment(
    input.tenantId,
    { nowIso: input.now.toISOString(), pageSize },
  );

  let flipped = 0;
  let raceSkipped = 0;
  let errors = 0;

  for (const cycle of page.items) {
    try {
      const outcome = await processOne(
        deps,
        cycle,
        input.tenantId,
        input.correlationId,
        input.now,
      );
      // Exhaustive switch + `_exhaustive: never` pin (F8-canonical, same
      // pattern as `lapseCyclesOnGraceExpiry`). A future 3rd
      // ProcessOneOutcome variant MUST add a counter line here — the pin
      // breaks the build until it does, protecting the SC invariant
      // `flipped + raceSkipped + errors === cyclesProcessed`.
      switch (outcome) {
        case 'flipped':
          flipped += 1;
          break;
        case 'race_skipped':
          raceSkipped += 1;
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    } catch (e) {
      // Per-cycle fault isolation — one bad cycle must not abort the
      // whole cron run. Pass the Error OBJECT (not `e.message`) so
      // pino's err-serialiser captures the stack trace.
      errors += 1;
      logger.error(
        {
          errorId: 'F8.ENTER_AWAITING.CYCLE_TRANSITION_FAILED',
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          err: e instanceof Error ? e : new Error(String(e)),
        },
        '[enter-awaiting-payment-on-expiry] cycle transition threw — counted in errors; cron continues',
      );
      renewalsMetrics.enterAwaitingCyclesErrors.add(1, {
        tenant_id: input.tenantId,
      });
    }
  }

  return ok({
    cyclesProcessed: page.items.length,
    flipped,
    raceSkipped,
    errors,
  });
}

type ProcessOneOutcome = 'flipped' | 'race_skipped';

async function processOne(
  deps: EnterAwaitingPaymentOnExpiryDeps,
  cycle: RenewalCycle,
  tenantId: string,
  correlationId: string,
  now: Date,
): Promise<ProcessOneOutcome> {
  const cycleId = cycle.cycleId as CycleId;
  const enteredAt = now.toISOString();

  // Single tx — advisory lock + tx-bound re-read + transition + audit
  // emit (Constitution Principle VIII state↔audit atomicity).
  return runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
    const reread = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
    // Race-loss: a concurrent member confirm-renewal Step-1 flip
    // (slice 2.5), an admin cancel, or a completed/lapsed transition
    // moved the cycle out of `upcoming|reminded` between our list query
    // and this tx. Skip silently — the other path won.
    if (
      !reread ||
      (reread.status !== 'upcoming' && reread.status !== 'reminded')
    ) {
      return 'race_skipped';
    }

    try {
      await deps.cyclesRepo.transitionStatus(tx, tenantId, cycleId, {
        from: reread.status,
        to: 'awaiting_payment',
      });
    } catch (e) {
      if (
        e instanceof CycleTransitionConflictError ||
        e instanceof CycleNotFoundError
      ) {
        // Another tx won between the re-read and the transitionStatus
        // (small window since we hold the advisory lock, but possible
        // on lock-acquisition timeout).
        return 'race_skipped';
      }
      throw e;
    }

    // Audit emit inside the same tx — Principle VIII reverse-direction:
    // an emit failure throws so the transition rolls back. We never
    // ship a state change without its audit.
    await deps.auditEmitter.emitInTx(
      tx,
      {
        type: 'renewal_entered_awaiting_payment' as const,
        payload: {
          cycle_id: cycleId,
          member_id: asMemberId(reread.memberId),
          source: 'cron' as const,
          entered_at: enteredAt,
        },
      },
      {
        tenantId,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
      },
    );

    return 'flipped';
  });
}
