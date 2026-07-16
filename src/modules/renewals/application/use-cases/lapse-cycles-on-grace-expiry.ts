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
 *   - **Short-circuit** (Round 5 K24-Comments-S1): when
 *     `cycle.linkedInvoiceId === null` (no F4 invoice ever issued —
 *     the common "member never even clicked Confirm" path), the F5
 *     bridge call is skipped entirely and the cycle defaults to
 *     `grace_expired`. Saves a network round-trip per cycle on the
 *     hot path.
 *
 * Concurrency: per-cycle advisory lock + tx-bound re-read (TOCTOU)
 * mirrors `reconcilePendingReactivations` pattern. A concurrent admin
 * mark-paid-offline + cron lapse cannot both win the transition.
 *
 * Forensic-only race window (Round 5 K24-S4): the F5 bridge count
 * runs OUTSIDE the lapse transaction (own `runInTenant`). A new F5
 * `payments` row with `status='failed'` could land between the count
 * read (T1) and the cycle transition (T2), changing the "true"
 * closed_reason from `grace_expired` to `payment_failed`. The
 * recorded `failed_payment_attempts` is the count at T1, not T2 —
 * documented forensic behaviour. Real-world impact is vanishingly
 * rare because the cron runs daily AFTER the grace window has
 * already expired (no member should be initiating payments past
 * grace), so post-grace payment attempts are an operational anomaly,
 * not a routine race.
 *
 * Audit: emits typed `renewal_lapsed` event per K24 audit-emitter
 * payload extension. `failed_payment_attempts` count is forensic so
 * SRE can verify the decision branch was correct.
 *
 * RBAC: cron-only (`actorRole='cron'`, `actorUserId=null`). Route
 * handler validates Bearer `CRON_SECRET` before invoking.
 *
 * 065 §5.2 — the termination clock is driven by the member's oldest-due
 * unpaid membership invoice `due_date`, NOT `expires_at + grace`. BEFORE
 * the F5 decision-branch read above, `processOne` consults
 * `deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate` (member-
 * scoped — see the InvoiceDueBridge port note on why NOT
 * `linked_invoice_id`) and decides per cycle:
 *   - not-yet-due (`due_date >= today`) → DEFER (059 guard preserved;
 *     emits `renewal_lapse_deferred_invoice_not_due`);
 *   - past due but `today <= due_date + 60` → stay suspended (no
 *     transition);
 *   - `today > due_date + 60` → terminate;
 *   - no membership invoice at all (`due_date === null`) → backstop on
 *     `expires_at + grace_period_days` (the only remaining role of the
 *     grace window — F4's 30-day net terms, `default_net_days`, default
 *     30, govern the normal path).
 * A member must not be suspended for non-payment while the invoice they'd
 * pay isn't even due yet.
 * Like the F5 bridge, this guard runs OUTSIDE the advisory-lock tx:
 * calling a cross-module bridge INSIDE the tx would open a second
 * pooled connection while holding the lock — the documented
 * deadlock / pool-starvation class (see CLAUDE.md Gotchas,
 * "Tenant-scoped repos MUST thread `tx`…"). No state transition
 * happens on the deferred branch, so there is no state-change tx to
 * pair the audit emit with (Constitution Principle VIII pairs a
 * STATE CHANGE with its audit — deferring IS the absence of one);
 * the forensic record is written via the fire-and-forget `emit()`
 * path instead of `emitInTx`.
 *
 * Fail-SAFE on guard throw: a bridge failure must never terminate
 * benefit access. `processOne` returns the distinguishable
 * `'deferred_guard_error'` outcome (own tally + dedicated metric +
 * loud structured log) instead of falling through to the lapse
 * transition OR silently folding into the generic per-cycle
 * `errors` tally — an invisible silent skip is exactly the failure
 * mode this guard exists to avoid.
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { addDays, bangkokLocalDate } from '@/lib/fiscal-year';
import { asTenantId, asMemberId } from '@/modules/members';
import { asInvoiceId } from '@/modules/invoicing';
import { parseInput } from './_lib/parse-input';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type { F5PaymentAttemptsBridge } from '../ports/f5-payment-attempts-bridge';
import type { InvoiceDueBridge } from '../ports/invoice-due-bridge';
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
  /**
   * 065 §5.2 — cycles whose lapse was deferred because the member has an
   * unpaid, not-yet-past-due MEMBERSHIP invoice (F4's 30-day net terms —
   * `tenant_invoice_settings.default_net_days`, default 30). No DB
   * transition occurred; the cycle stays `awaiting_payment` and re-enters
   * eligibility on tomorrow's run.
   */
  readonly deferredInvoiceNotDue: number;
  /**
   * 065 §5.2 — cycles PAST their membership invoice `due_date` but still
   * inside the `due_date + 60` termination window. Benefits stay suspended
   * (the `awaiting_payment` cycle is untouched); the member is re-evaluated
   * daily and terminated once `today > due_date + 60`. Same benign "no
   * transition, re-eligible tomorrow" bucket as `deferredInvoiceNotDue`.
   */
  readonly deferredWithinTerminationWindow: number;
  /**
   * 065 §5.2 — cycles with NO unpaid membership invoice whose
   * `expires_at + grace_period_days` backstop has NOT yet elapsed. Only
   * reachable for an `awaiting_payment` cycle that was never invoiced
   * (auto-invoice is a deferred phase). No DB transition; re-evaluated
   * daily. Same benign deferred bucket as `deferredInvoiceNotDue`.
   */
  readonly deferredNoInvoiceBackstop: number;
  /**
   * Task 13 — the `InvoiceDueBridge` guard itself threw. Deliberately
   * NOT folded into `errors`: a guard failure fails the member SAFE
   * (not lapsed), which is a materially different on-call signal from
   * "a cycle transition failed" (`errors`). See `renewalsMetrics.
   * lapseInvoiceDueGuardErrors` for the paired counter.
   */
  readonly deferredGuardErrors: number;
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
  /**
   * Task 13 — F8 → F4 credit-window guard (see file header). Consulted
   * BEFORE the advisory-lock tx, same calling convention as
   * `f5PaymentAttemptsBridge`.
   */
  readonly invoiceDueBridge: InvoiceDueBridge;
}

const MS_PER_DAY = 86_400_000;

/**
 * 065 §5.2 — a member is terminated once today is strictly PAST
 * `due_date + 60` (Bangkok calendar days) of their oldest-due unpaid
 * membership invoice. Matches the SweCham member-fees spec: SweCham is
 * regulatory-bound to terminate members with unpaid fees within 60 days
 * of the invoice due date. Domain constant (may become a
 * `tenant_renewal_settings` column if a second tenant needs a different
 * value — Open Question §10).
 */
const TERMINATION_DAYS_AFTER_DUE = 60;

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
  // 065 §5.2 — `grace_period_days` is now ONLY the no-invoice backstop
  // (an `awaiting_payment` cycle with no membership invoice). The normal
  // termination clock is the member's oldest-due unpaid membership
  // invoice `due_date + 60`, computed per cycle in `processOne`.
  const gracePeriodDays = settings.gracePeriodDays;

  // 065 §5.2 — candidate selection is now ALL `awaiting_payment` cycles
  // (no `expires_at` pre-filter): a §5.3 born-`awaiting_payment` new
  // member has a far-future `expires_at` and must not be hidden. The
  // per-cycle decision is made in `processOne`.
  const page = await deps.cyclesRepo.listCyclesEligibleForLapse(
    input.tenantId,
    { pageSize },
  );

  let graceExpired = 0;
  let paymentFailed = 0;
  let transitionRaceSkipped = 0;
  let deferredInvoiceNotDue = 0;
  let deferredWithinTerminationWindow = 0;
  let deferredNoInvoiceBackstop = 0;
  let deferredGuardErrors = 0;
  let errors = 0;

  for (const cycle of page.items) {
    try {
      const outcome = await processOne(
        deps,
        cycle,
        input.tenantId,
        gracePeriodDays,
        input.correlationId,
        input.now,
      );
      // Round 5 staff-review (K24-T2): exhaustive switch + `_exhaustive:
      // never` pin matches the F8-canonical pattern at
      // `renewals-deps.ts:380-407` (R3-CR2 / R4-S1). A future
      // ProcessOneOutcome variant added MUST add a counter line here —
      // the pin breaks the build until it does. Without this guard, a
      // new outcome would silently fall through and break the SC
      // invariant `graceExpired + paymentFailed + transitionRaceSkipped
      // + deferredInvoiceNotDue + deferredWithinTerminationWindow +
      // deferredNoInvoiceBackstop + deferredGuardErrors + errors ===
      // cyclesProcessed`.
      switch (outcome) {
        case 'grace_expired':
          graceExpired += 1;
          break;
        case 'payment_failed':
          paymentFailed += 1;
          break;
        case 'race_skipped':
          transitionRaceSkipped += 1;
          break;
        case 'deferred_invoice_not_due':
          deferredInvoiceNotDue += 1;
          break;
        case 'deferred_within_termination_window':
          deferredWithinTerminationWindow += 1;
          break;
        case 'deferred_no_invoice_backstop':
          deferredNoInvoiceBackstop += 1;
          break;
        case 'deferred_guard_error':
          deferredGuardErrors += 1;
          break;
        default: {
          const _exhaustive: never = outcome;
          void _exhaustive;
        }
      }
    } catch (e) {
      // Per-cycle fault isolation — one bad cycle must not abort the
      // whole cron run. Log + count + continue.
      // Round 5 staff-review (K24-Errors-S2): pass the Error OBJECT
      // (not `e.message`) so pino's err-serialiser captures the stack
      // trace — programming bugs (TypeError / ReferenceError) would
      // otherwise lose their call site, making the SRE log less
      // actionable.
      errors += 1;
      logger.error(
        {
          errorId: 'F8.LAPSE.CYCLE_TRANSITION_FAILED',
          tenantId: input.tenantId,
          cycleId: cycle.cycleId,
          err: e instanceof Error ? e : new Error(String(e)),
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
    deferredInvoiceNotDue,
    deferredWithinTerminationWindow,
    deferredNoInvoiceBackstop,
    deferredGuardErrors,
    errors,
  });
}

type ProcessOneOutcome =
  | 'grace_expired'
  | 'payment_failed'
  | 'race_skipped'
  | 'deferred_invoice_not_due'
  | 'deferred_within_termination_window'
  | 'deferred_no_invoice_backstop'
  | 'deferred_guard_error';

async function processOne(
  deps: LapseCyclesOnGraceExpiryDeps,
  cycle: RenewalCycle,
  tenantId: string,
  gracePeriodDays: number,
  correlationId: string,
  now: Date,
): Promise<ProcessOneOutcome> {
  // 065 §5.2 — the termination decision. Runs FIRST (and OUTSIDE the
  // advisory-lock tx below): the clock is the member's OLDEST-DUE unpaid
  // membership invoice `due_date + 60`, NOT `expires_at + grace`.
  // Fail-SAFE: a bridge throw must never terminate benefit access — see
  // file header + output-type docs for the full rationale. `todayBkk` and
  // `dueDate` are both Bangkok calendar dates (`YYYY-MM-DD`), so
  // lexicographic string comparison is a correct date comparison.
  const todayBkk = bangkokLocalDate(now.toISOString());
  let dueDate: string | null;
  try {
    dueDate = await deps.invoiceDueBridge.oldestUnpaidMembershipInvoiceDueDate({
      tenantId,
      memberId: cycle.memberId,
    });
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.LAPSE.INVOICE_DUE_GUARD_FAILED',
        tenantId,
        cycleId: cycle.cycleId,
        err: e instanceof Error ? e : new Error(String(e)),
      },
      '[lapse-cycles-on-grace-expiry] invoiceDueBridge threw — failing SAFE (member NOT lapsed); counted as deferred_guard_error, NOT folded into the generic errors tally',
    );
    renewalsMetrics.lapseInvoiceDueGuardErrors.add(1, { tenant_id: tenantId });
    return 'deferred_guard_error';
  }

  if (dueDate !== null) {
    if (dueDate >= todayBkk) {
      // Not yet due → DEFER (059 not-yet-due guard preserved). No state
      // transition on this branch — nothing to pair the audit with in a
      // tx (Constitution Principle VIII pairs a STATE CHANGE with its
      // audit; deferring is the absence of a state change). `emit()` is
      // the port's fire-and-forget path — it never throws to the caller,
      // matching every other read-only forensic record in this module.
      await deps.auditEmitter.emit(
        {
          type: 'renewal_lapse_deferred_invoice_not_due' as const,
          payload: {
            cycle_id: cycle.cycleId as CycleId,
            member_id: asMemberId(cycle.memberId),
            invoice_subject: 'membership' as const,
            due_date_frontier: todayBkk,
          },
        },
        {
          tenantId,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
        },
      );
      return 'deferred_invoice_not_due';
    }
    // Past due. Terminate only once today is STRICTLY past `due_date + 60`.
    // Pure Bangkok-calendar-day arithmetic (both are YYYY-MM-DD; no TZ/DST).
    const terminateAfter = addDays(dueDate, TERMINATION_DAYS_AFTER_DUE);
    if (todayBkk <= terminateAfter) {
      // Past due but still inside the 60-day termination window → stay
      // suspended (no transition; re-evaluated on tomorrow's run).
      return 'deferred_within_termination_window';
    }
    // else today > due_date + 60 → fall through to terminate.
  } else {
    // No unpaid membership invoice at all → backstop on
    // `expires_at + grace_period_days`. `cycle.expiresAt` and
    // `backstopCutoffIso` are both canonical `Date#toISOString()` strings
    // (rowToDomain emits `.toISOString()`), so string `>=` is a correct
    // instant comparison. `>=` defers (mirrors the OLD selection's
    // `expires_at < cutoff` terminate boundary: equal → not yet eligible).
    const backstopCutoffIso = new Date(
      now.getTime() - gracePeriodDays * MS_PER_DAY,
    ).toISOString();
    if (cycle.expiresAt >= backstopCutoffIso) {
      return 'deferred_no_invoice_backstop';
    }
    // else expires_at + grace passed → fall through to terminate.
  }

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
  // Staff-Review-2026-05-09 WRN-12 fix: use the injected `now` (the same
  // clock the due+60 / backstop decision above reads) instead of
  // wall-clock `new Date()` so the `closedAt` timestamp aligns with the
  // decision cohort. Under heavy cron load wall-clock could drift from
  // the decision instant, making forensic audit traces harder to
  // correlate. Also enables deterministic vi.setSystemTime testing
  // without monkey-patching the use-case internals.
  const closedAt = now.toISOString();
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
