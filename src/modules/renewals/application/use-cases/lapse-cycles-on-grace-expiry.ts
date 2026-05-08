/**
 * F8 Phase 5 wave K24 · T115a — `lapseCyclesOnGraceExpiry`.
 *
 * Daily cron walking cycles in `awaiting_payment` whose
 * `expires_at + tenant.grace_period_days < now` — performs the
 * `awaiting_payment` → `lapsed` transition that FR-004 mandates and
 * writes the **specific** `closed_reason` (`grace_expired` vs
 * `payment_failed`) per AS3 + T115a infrastructure already shipped
 * in Phase 4 (Domain CLOSED_REASONS + DB migration 0108 + i18n badges
 * + UI variants). Until K24 the transition didn't happen anywhere —
 * Phase 4 dispatcher only READ `cycle.status === 'lapsed'` to skip,
 * but no code site ever WROTE the lapsed status. K24 closes that
 * functional gap.
 *
 * Decision branch (per spec FR-004 + `renewal-cycle.ts` CLOSED_REASONS
 * docstring lines 53-66):
 *   - `'grace_expired'` — the member never attempted payment (or all
 *     attempts remained `pending`/`processing`); F5 payments table has
 *     0 rows with `status='failed'` for the cycle's linked invoice
 *   - `'payment_failed'` — at least one F5 payment attempt ended in
 *     terminal `status='failed'` before the grace window expired
 *
 * Concurrency: per-cycle advisory lock + tx-bound re-read (TOCTOU)
 * mirrors `reconcilePendingReactivations` pattern. A concurrent admin
 * mark-paid-offline + cron lapse cannot both win the transition.
 *
 * Audit: emits typed `renewal_lapsed` event per K24 audit-emitter
 * payload extension. `failed_payment_attempts` count is forensic so
 * SRE can verify the decision branch was correct.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null`). Route
 * handler validates Bearer `CRON_SECRET` before invoking.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantId, asMemberId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';
import { parseInput } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { F5PaymentAttemptsBridge } from '../ports/f5-payment-attempts-bridge';
import type {
  CycleId,
  RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';

export const lapseCyclesOnGraceExpiryInputSchema = z.object({
  tenantId: z.string().min(1),
  /** Injected clock for deterministic tests. */
  now: z.date(),
  /**
   * Optional cap on how many cycles to process per cron run. Defaults
   * to 1000 — typical chambers have <100 grace-expiring members per
   * day, so a single run handles everything.
   */
  pageSize: z.number().int().min(1).max(5000).optional(),
  correlationId: z.string().min(1),
});

export type LapseCyclesOnGraceExpiryInput = z.infer<
  typeof lapseCyclesOnGraceExpiryInputSchema
>;

export interface LapseCyclesOnGraceExpiryOutput {
  readonly cyclesProcessed: number;
  /** Cycles transitioned with `closed_reason='grace_expired'`. */
  readonly graceExpired: number;
  /** Cycles transitioned with `closed_reason='payment_failed'`. */
  readonly paymentFailed: number;
  /** Cycles where the transition lost the TOCTOU race + skipped silently. */
  readonly transitionRaceSkipped: number;
  /** F5 bridge query / audit emit / DB transition that threw — for SRE alert. */
  readonly errors: number;
}

export type LapseCyclesOnGraceExpiryError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'tenant_settings_not_found' };

export interface LapseCyclesOnGraceExpiryDeps
  extends Pick<
    RenewalsDeps,
    | 'tenant'
    | 'cyclesRepo'
    | 'auditEmitter'
    | 'tenantRenewalSettingsRepo'
  > {
  readonly f5PaymentAttemptsBridge: F5PaymentAttemptsBridge;
}

const MS_PER_DAY = 86_400_000;

export async function lapseCyclesOnGraceExpiry(
  deps: LapseCyclesOnGraceExpiryDeps,
  rawInput: LapseCyclesOnGraceExpiryInput,
): Promise<
  Result<LapseCyclesOnGraceExpiryOutput, LapseCyclesOnGraceExpiryError>
> {
  const inputResult = parseInput(lapseCyclesOnGraceExpiryInputSchema, rawInput);
  if (!inputResult.ok) return err(inputResult.error);
  const input = inputResult.value;
  const pageSize = input.pageSize ?? 1000;

  // Resolve tenant grace_period_days. Settings row is seeded in migration
  // 0089; missing row is a configuration error worth surfacing.
  const settings = await deps.tenantRenewalSettingsRepo.findByTenant(
    input.tenantId,
  );
  if (!settings) {
    return err({ kind: 'tenant_settings_not_found' });
  }
  const gracePeriodDays = settings.gracePeriodDays;

  // cutoffDate = now - grace_period_days. Any awaiting_payment cycle
  // with `expires_at < cutoffDate` has crossed the grace boundary and
  // is eligible for the lapse transition.
  const cutoffMs = input.now.getTime() - gracePeriodDays * MS_PER_DAY;
  const cutoffDate = new Date(cutoffMs).toISOString();

  const page = await deps.cyclesRepo.listCyclesEligibleForLapse(
    input.tenantId,
    { cutoffDate, pageSize },
  );

  let graceExpired = 0;
  let paymentFailed = 0;
  let transitionRaceSkipped = 0;
  let errors = 0;

  for (const cycle of page.items) {
    try {
      const outcome = await processOne(
        deps,
        cycle,
        input.tenantId,
        gracePeriodDays,
        input.correlationId,
      );
      if (outcome === 'grace_expired') graceExpired += 1;
      else if (outcome === 'payment_failed') paymentFailed += 1;
      else if (outcome === 'race_skipped') transitionRaceSkipped += 1;
    } catch (e) {
      // Per-cycle fault isolation — one bad cycle must not abort the
      // whole cron run. Log + count + continue.
      errors += 1;
      logger.error(
        {
          errorId: 'F8.LAPSE.CYCLE_TRANSITION_FAILED',
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          err: e instanceof Error ? e.message : String(e),
        },
        '[lapse-cycles-on-grace-expiry] cycle transition threw — counted in errors; cron continues',
      );
      renewalsMetrics.lapseCyclesErrors.add(1, { tenant_id: input.tenantId });
    }
  }

  return ok({
    cyclesProcessed: page.items.length,
    graceExpired,
    paymentFailed,
    transitionRaceSkipped,
    errors,
  });
}

type ProcessOneOutcome =
  | 'grace_expired'
  | 'payment_failed'
  | 'race_skipped';

async function processOne(
  deps: LapseCyclesOnGraceExpiryDeps,
  cycle: RenewalCycle,
  tenantId: string,
  gracePeriodDays: number,
  correlationId: string,
): Promise<ProcessOneOutcome> {
  // Decision branch — count F5 failed-attempt rows for the cycle's
  // linked invoice. When `linked_invoice_id` is null (no F4 invoice
  // ever issued against this cycle), the count is 0 by definition →
  // grace_expired. This handles the common "member never even clicked
  // Confirm" path without an F5 bridge call.
  const failedAttempts =
    cycle.linkedInvoiceId === null
      ? 0
      : await deps.f5PaymentAttemptsBridge.countFailedAttemptsForInvoice({
          tenantId: asTenantId(tenantId),
          invoiceId: asInvoiceId(cycle.linkedInvoiceId),
        });
  const closedReason = failedAttempts >= 1 ? 'payment_failed' : 'grace_expired';
  const closedAt = new Date().toISOString();
  const cycleId = cycle.cycleId as CycleId;

  // Single tx — advisory lock + tx-bound re-read + transition + audit
  // emit (Constitution Principle VIII state↔audit atomicity).
  return runInTenant(deps.tenant, async (tx) => {
    await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
    const reread = await deps.cyclesRepo.findByIdInTx(tx, tenantId, cycleId);
    // Race-loss: a concurrent admin mark-paid-offline (T059) or a
    // concurrent F5 payment_succeeded → F8 mark-cycle-complete (T123)
    // moved the cycle out of awaiting_payment between our list query
    // and this tx. Skip silently — the other path won.
    if (!reread || reread.status !== 'awaiting_payment') {
      return 'race_skipped';
    }

    try {
      await deps.cyclesRepo.transitionStatus(tx, tenantId, cycleId, {
        from: 'awaiting_payment',
        to: 'lapsed',
        closedAt,
        closedReason,
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
        type: 'renewal_lapsed' as const,
        payload: {
          cycle_id: cycleId,
          member_id: asMemberId(cycle.memberId),
          closed_reason: closedReason,
          expires_at: cycle.expiresAt,
          grace_period_days: gracePeriodDays,
          failed_payment_attempts: failedAttempts,
        },
      },
      {
        tenantId,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
      },
    );

    return closedReason;
  });
}
