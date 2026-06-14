/**
 * F8 Phase 5 Wave B · T122 — `confirmRenewal`.
 *
 * Member confirms their renewal via the public portal page. Flow:
 *
 *   1. Acquire the per-cycle advisory lock, then read the cycle + validate
 *      it matches the URL [memberId] (cross-member guard).
 *   2. Lazy enter-awaiting self-transition (slice 2.5) — if the cycle is
 *      `upcoming|reminded`, self-transition it `→ awaiting_payment` under
 *      the lock and emit a `renewal_entered_awaiting_payment` audit
 *      (`source:'confirm'`) in the SAME tx, so a member can renew EARLY
 *      before the T-0 enter-awaiting cron runs. A concurrent writer (the
 *      cron, or another confirm) that wins the CAS surfaces a
 *      `CycleTransitionConflictError`: we re-read under the lock and, if
 *      the cycle is now `awaiting_payment`, converge silently (the winner
 *      emitted its own audit — we do NOT double-emit). Any other current
 *      status falls through as `cycle_not_payable`.
 *   3. (Optional plan-change branch FR-025) — if `newPlanId` provided AND
 *      differs from `cycle.planIdAtCycleStart`:
 *        a. Lookup new plan via `planLookupForRenewal` port.
 *        b. Atomically update cycle's `frozen_plan_*` columns
 *           (`cyclesRepo.updateFrozenPlan` — single UPDATE per FR-021b).
 *        c. Emit `renewal_with_plan_change` + `renewal_cycle_price_frozen`
 *           audits inside the same tx.
 *   4. Compose F4 createInvoiceDraft → issueInvoice via the
 *      `f4InvoicingForRenewalBridge` port.
 *   5. Link the issued invoice to the cycle (`cyclesRepo.linkInvoice`).
 *   6. Emit `renewal_invoice_created` audit.
 *   7. Return `{ invoiceId, payUrl }` for the route handler to redirect
 *      to F5 `/portal/invoices/<invoiceId>/pay`.
 *
 * Coverage policy: Constitution Principle II — 100% branch coverage
 * required (security-critical mutating path; collects member payment
 * intent). The branches are:
 *   - happy path no plan-change (already `awaiting_payment`)
 *   - happy path with plan-change
 *   - lazy `upcoming|reminded → awaiting_payment` self-transition
 *     (emits `renewal_entered_awaiting_payment`, source:'confirm')
 *   - lazy-transition CAS conflict → re-read converges (already
 *     `awaiting_payment`, no duplicate audit) vs surfaces
 *     `cycle_not_payable` (winner moved it to a terminal state)
 *   - cycle_not_found
 *   - cross_member_probe
 *   - cycle_not_payable (terminal/pending_admin_reactivation status)
 *   - plan_not_found / plan_inactive (during plan-change)
 *   - F4 invoice creation failure (create_failed / issue_failed)
 *   - audit emit failure (Principle VIII reverse-direction)
 *
 * Atomicity: state mutations + audits run inside a single
 * `runInTenant` tx for atomicity. The F4 invoice creation runs
 * OUTSIDE the F8 tx (F4 owns its own internal tx for §87 sequence
 * allocation + PDF render). If F8 fails to link the invoice after F4
 * issued it, an orphaned `issued` invoice exists — admin recovers via
 * the F4 invoice list (mark-paid-offline or void). Same trade-off as
 * mark-paid-offline use-case.
 *
 * RBAC: member or admin. Member must match cycle.memberId (cross-
 * member guard). Admin can confirm on behalf of a member (rare; used
 * for support-assisted renewals).
 */
import { z } from 'zod';
import { ok, err, type Result } from '@/lib/result';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { asMemberId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
  RenewalInvoiceErrorCode,
} from '../ports/f4-invoicing-bridge';
import type { PlanLookupForRenewalPort } from '../ports/plan-lookup-for-renewal';
import {
  parseCycleId,
  type CycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
  InvoiceLinkConflictError,
} from '../ports/renewal-cycle-repo';

export const confirmRenewalInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  memberId: z.string().uuid(),
  /** Optional — when present + differs from cycle.planIdAtCycleStart triggers plan-change branch. */
  newPlanId: z.string().min(1).optional(),
  /** Calendar year (e.g. 2026) the invoice covers. Mirrors F4 createInvoiceDraft input. */
  planYear: z.number().int().min(2000).max(2100),
  actorUserId: z.string().min(1),
  actorRole: z.enum(['member', 'admin']),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type ConfirmRenewalInput = z.infer<typeof confirmRenewalInputSchema>;

export interface ConfirmRenewalOutput {
  readonly invoiceId: string;
  readonly invoiceNumber: string;
  readonly payUrl: string;
  readonly planChanged: boolean;
}

export type ConfirmRenewalError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | {
      readonly kind: 'cross_member_probe';
      readonly attemptedMemberId: string;
    }
  | {
      readonly kind: 'cycle_not_payable';
      readonly currentStatus: string;
    }
  | { readonly kind: 'plan_not_found' }
  | { readonly kind: 'plan_inactive' }
  | {
      readonly kind: 'invoice_creation_failed';
      readonly stage: 'create' | 'issue';
      // I-2 (068 speckit-review) — pinned to the bridge's closed F4 error
      // vocabulary (was bare `string`) so an F4-side code rename surfaces
      // as a compile error rather than a runtime missing-toast. Mirrors
      // admin-renew-lapsed-member's invoice_issue_failed arm.
      readonly errorCode: RenewalInvoiceErrorCode;
      readonly detail: string;
    }
  | { readonly kind: 'server_error'; readonly message: string };

export interface ConfirmRenewalDeps
  extends Pick<
    RenewalsDeps,
    'tenant' | 'cyclesRepo' | 'auditEmitter' | 'clock'
  > {
  readonly f4InvoicingBridge: F4InvoicingForRenewalBridge;
  readonly planLookupForRenewal: PlanLookupForRenewalPort;
}

export async function confirmRenewal(
  deps: ConfirmRenewalDeps,
  rawInput: ConfirmRenewalInput,
): Promise<Result<ConfirmRenewalOutput, ConfirmRenewalError>> {
  const parsed = confirmRenewalInputSchema.safeParse(rawInput);
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

  // ---- Step 1 + 2: state validation + (optional) plan-change in own tx
  const stateResult = await runInTenant(deps.tenant, async (tx) => {
    // B4 fix (F8-completion slice 2.5) — acquire the per-cycle advisory
    // lock as the FIRST statement, BEFORE the read + the lazy
    // `upcoming|reminded → awaiting_payment` self-transition below. This
    // serialises the Step-1 flip against the T-0 enter-awaiting cron
    // (`enterAwaitingPaymentOnExpiry`), which holds the same lock around
    // its own flip. Without it the Step-1 lazy flip would race the cron
    // (the old code only locked at Step-4, the link step). Auto-released
    // at tx end; namespace `renewals:` is disjoint from F4/F5 locks.
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

    // `let` (was `const`) — the lazy self-transition below reflects the
    // post-flip status onto the local cycle for the rest of Step-1.
    let cycle = await deps.cyclesRepo.findByIdInTx(
      tx,
      input.tenantId,
      cycleId,
    );
    if (!cycle) {
      return err({ kind: 'cycle_not_found' as const });
    }
    if (cycle.memberId !== input.memberId) {
      try {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_cross_member_probe' as const,
            payload: {
              // I13 review-fix: use branded asMemberId() instead of
              // `as never` cast — preserves the "silent ID swap"
              // compile-time guard documented in renewal-audit-emitter.ts:18.
              actor_member_id: asMemberId(input.memberId),
              attempted_member_id: asMemberId(cycle.memberId),
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
          { err: e instanceof Error ? e.message : String(e) },
          '[confirm-renewal] cross-member probe audit emit failed',
        );
      }
      return err({
        kind: 'cross_member_probe' as const,
        attemptedMemberId: cycle.memberId,
      });
    }
    // B-lazy (F8-completion slice 2.5) — let a member renew EARLY by
    // self-transitioning their cycle `upcoming|reminded → awaiting_payment`
    // here in Step-1 (under the advisory lock acquired above), then
    // proceeding to issue the §86/4. Until the T-0 enter-awaiting cron
    // runs, most cycles are still `upcoming|reminded` when the member
    // lands on the portal, so without this branch early renewal would be
    // impossible (the old code rejected any non-`awaiting_payment` cycle
    // with `cycle_not_payable`).
    if (cycle.status === 'upcoming' || cycle.status === 'reminded') {
      const fromStatus = cycle.status;
      try {
        await deps.cyclesRepo.transitionStatus(tx, input.tenantId, cycleId, {
          from: fromStatus,
          to: 'awaiting_payment',
        });
        // State+audit atomicity (Principle VIII): emit the
        // `renewal_entered_awaiting_payment` audit INSIDE this tx, with
        // the `source:'confirm'` discriminator distinguishing this lazy
        // writer from the cron (`source:'cron'`). A concurrent cron flip
        // that already won emits its OWN audit — the CAS-loss branch
        // below skips the emit so we never double-count.
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_entered_awaiting_payment' as const,
            payload: {
              cycle_id: cycleId,
              member_id: asMemberId(cycle.memberId),
              source: 'confirm' as const,
              entered_at: deps.clock.now().toISOString(),
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
        // Reflect the flip for the rest of Step-1 (plan-change branch +
        // the state result the link step consumes).
        cycle = { ...cycle, status: 'awaiting_payment' };
      } catch (e) {
        if (e instanceof CycleTransitionConflictError) {
          // Idempotent convergence: a concurrent writer (the T-0 cron,
          // or another confirm) won the `→awaiting_payment` CAS between
          // our read and this transition. Re-read under the lock: if the
          // cycle IS now `awaiting_payment`, treat the flip as already
          // done (the winner emitted its own audit — we do NOT emit a
          // duplicate, do NOT surface `cycle_not_payable`) and proceed.
          const reread = await deps.cyclesRepo.findByIdInTx(
            tx,
            input.tenantId,
            cycleId,
          );
          if (!reread) {
            return err({ kind: 'cycle_not_found' as const });
          }
          if (reread.status !== 'awaiting_payment') {
            // The winner moved it somewhere non-payable (cancel/lapse) —
            // honour the real terminal state rather than force a flip.
            return err({
              kind: 'cycle_not_payable' as const,
              currentStatus: reread.status,
            });
          }
          cycle = reread;
        } else {
          throw e;
        }
      }
    } else if (cycle.status !== 'awaiting_payment') {
      // Terminal (completed/lapsed/cancelled) or pending_admin_reactivation
      // — not self-renewable here. The pending_admin_reactivation
      // money-hold path is deferred post-launch (spec §C); it stays a
      // server-side reject until that path is built.
      return err({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }
    // (cycle.status === 'awaiting_payment' falls through unchanged —
    // already payable, proceed.)

    // Plan-change branch (FR-021b atomic)
    let planChanged = false;
    let resolvedCycle: RenewalCycle = cycle;
    if (input.newPlanId && input.newPlanId !== cycle.planIdAtCycleStart) {
      const planResult = await deps.planLookupForRenewal.loadPlanFrozenFields({
        tenantId: input.tenantId,
        planId: input.newPlanId,
      });
      if (planResult.status === 'not_found') {
        return err({ kind: 'plan_not_found' as const });
      }
      if (planResult.status === 'plan_inactive') {
        return err({ kind: 'plan_inactive' as const });
      }
      try {
        resolvedCycle = await deps.cyclesRepo.updateFrozenPlan(
          tx,
          input.tenantId,
          cycleId,
          {
            planIdAtCycleStart: input.newPlanId,
            tierAtCycleStart: planResult.plan.tierBucket,
            frozenPlanPriceThb: planResult.plan.priceTHB,
            frozenPlanTermMonths: planResult.plan.termMonths,
            frozenPlanCurrency: planResult.plan.currency,
          },
        );
      } catch (e) {
        if (e instanceof CycleTransitionConflictError) {
          return err({
            kind: 'cycle_not_payable' as const,
            currentStatus: 'unknown',
          });
        }
        throw e;
      }
      planChanged = true;
      // Atomic state+audit per Principle VIII: emit inside tx.
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_with_plan_change' as const,
          payload: {
            cycle_id: cycle.cycleId,
            member_id: cycle.memberId,
            from_plan_id: cycle.planIdAtCycleStart,
            to_plan_id: input.newPlanId,
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
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_cycle_price_frozen' as const,
          payload: {
            cycle_id: cycle.cycleId,
            plan_id: input.newPlanId,
            frozen_price_thb: planResult.plan.priceTHB,
            frozen_term_months: planResult.plan.termMonths,
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
    }

    return ok({ cycle: resolvedCycle, planChanged });
  });
  if (!stateResult.ok) return err(stateResult.error);
  const { cycle: cycleAfterPlanChange, planChanged } = stateResult.value;

  // ---- Step 3: F4 invoice creation OUTSIDE F8 tx
  // FR-022 — bill the cycle's FROZEN price on the §86/4, not the live
  // F2 catalogue price. `cycleAfterPlanChange` is the Step-1 tx's
  // server-side cycle row (already re-snapshotted by `updateFrozenPlan`
  // when the member changed plan), so its `frozenPlanPriceThb` is the
  // authoritative VAT-exclusive amount — never derived from request body.
  const invoiceResult = await deps.f4InvoicingBridge.issueInvoiceForRenewal({
    tenantId: input.tenantId,
    memberId: input.memberId,
    planId: cycleAfterPlanChange.planIdAtCycleStart,
    planYear: input.planYear,
    frozenPlanPriceThb: cycleAfterPlanChange.frozenPlanPriceThb,
    autoEmailOnIssue: true,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
  });
  if (invoiceResult.status !== 'issued') {
    return mapInvoiceError(invoiceResult);
  }

  // ---- Step 4 + 5: link invoice + emit audit atomically
  return runInTenant(deps.tenant, async (tx) => {
    // I1 review-fix: acquire per-cycle advisory lock first so two
    // concurrent confirms serialise on the link step. Combined with the
    // adapter's `WHERE (linked_invoice_id IS NULL OR = $1)` guard, this
    // closes the orphan-invoice race for all but pathological clock-
    // skew scenarios (covered by the conflict-error branch below).
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);
    try {
      await deps.cyclesRepo.linkInvoice(
        tx,
        input.tenantId,
        cycleId,
        invoiceResult.invoiceId,
      );
    } catch (e) {
      if (e instanceof CycleNotFoundError) {
        // Cycle vanished between step 1 + 4 — extremely rare race.
        // The F4 invoice exists in `issued` state; admin must reconcile.
        logger.error(
          { cycleId, invoiceId: invoiceResult.invoiceId },
          '[confirm-renewal] cycle gone between confirm + linkInvoice — orphan invoice in F4',
        );
        return err({
          kind: 'server_error',
          message: 'cycle vanished after invoice issued — see runbook',
        });
      }
      if (e instanceof InvoiceLinkConflictError) {
        // I1 review-fix: a concurrent confirm won the link race. Our
        // F4-issued invoice is now orphaned; surface this in the log so
        // support can void it via the F4 admin list.
        logger.error(
          {
            cycleId,
            attemptedInvoiceId: e.attemptedInvoiceId,
            existingInvoiceId: e.existingInvoiceId,
          },
          '[confirm-renewal] concurrent confirm linked a different invoice — our invoice orphaned in F4 (void via admin)',
        );
        return err({
          kind: 'server_error',
          message:
            'concurrent confirm won link race — our invoice orphaned, void via F4 admin',
        });
      }
      throw e;
    }

    try {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_invoice_created' as const,
          payload: {
            cycle_id: cycleAfterPlanChange.cycleId,
            member_id: cycleAfterPlanChange.memberId,
            invoice_id: invoiceResult.invoiceId,
            invoice_number: invoiceResult.invoiceNumber,
            total_satang: invoiceResult.totalSatang.toString(),
            plan_changed: planChanged,
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
      logger.error(
        { err: e instanceof Error ? e.message : String(e) },
        '[confirm-renewal] audit emit failed inside tx — rolling back link',
      );
      throw e;
    }

    // Phase 9 / T231 — business-volume counter (US3 conversion funnel).
    // Fires on the success leg of confirm-renewal — the F4 invoice has
    // been created and linked, the audit row is committed inside the
    // same tx. Member's actual payment outcome is tracked separately
    // by F5 metrics; this counter answers "how many members reached
    // the pay-url" which is the F8-side conversion signal.
    renewalsMetrics.selfServiceCompleted(input.tenantId);

    return ok({
      invoiceId: invoiceResult.invoiceId,
      invoiceNumber: invoiceResult.invoiceNumber,
      payUrl: `/portal/invoices/${invoiceResult.invoiceId}/pay`,
      planChanged,
    });
  });
}

function mapInvoiceError(
  result: Exclude<IssueInvoiceForRenewalResult, { status: 'issued' }>,
): Result<never, ConfirmRenewalError> {
  return err({
    kind: 'invoice_creation_failed',
    stage: result.status === 'create_failed' ? 'create' : 'issue',
    errorCode: result.errorCode,
    detail: result.detail,
  });
}

/**
 * Phase 9 / T231 — caller helper for the per-tenant failure counter.
 * Confirm-renewal route handlers translate `ConfirmRenewalError.kind`
 * to a bounded `reason` label before calling
 * `renewalsMetrics.selfServiceFailed`. Exported here so the route
 * + its tests share one canonical mapping (catches dashboard
 * cardinality drift if a new error variant adds without a label).
 *
 * Phase 9 verify-fix Round-2 close — `SelfServiceFailureReason` is
 * now a closed literal union covering the 7 mapped variants PLUS
 * `'unexpected_error'` (the route's outer-catch path emits this on
 * runtime exceptions outside the typed `ConfirmRenewalError` union).
 * Closes the cardinality-drift loophole where the route emitted a
 * label string outside the mapper's range.
 */
/**
 * Phase 9 Round-3 close — collapsed redundant `'unknown' |
 * 'unexpected_error'` into a single `'unexpected_error'` value.
 * Both meant "we don't know" semantically — splitting them across
 * two labels would fragment a single dashboard cardinality bucket
 * and make triage harder. The mapper's `_exhaustive: never` pin
 * already makes the default arm unreachable when the union is
 * well-formed; round-3 makes the default arm THROW so a future
 * `ConfirmRenewalError` variant added without a mapper case fails
 * loudly at runtime (compile-time will already error at the
 * producer site).
 */
export type SelfServiceFailureReason =
  | 'f4_invoice_create_failed'
  | 'cycle_terminal'
  | 'plan_inactive'
  | 'invalid_input'
  | 'cross_member'
  | 'server_error'
  | 'unexpected_error';

export function selfServiceFailureReason(
  err: ConfirmRenewalError,
): SelfServiceFailureReason {
  switch (err.kind) {
    case 'invoice_creation_failed':
      return 'f4_invoice_create_failed';
    case 'cycle_not_found':
    case 'cycle_not_payable':
      return 'cycle_terminal';
    case 'plan_not_found':
    case 'plan_inactive':
      return 'plan_inactive';
    case 'invalid_input':
      return 'invalid_input';
    case 'cross_member_probe':
      return 'cross_member';
    case 'server_error':
      return 'server_error';
    default: {
      const _exhaustive: never = err;
      // Round-3 close — fail-loud on union drift instead of
      // silently emitting an "unknown" label. The compile-time
      // `_exhaustive: never` already errors at this line if a new
      // `ConfirmRenewalError.kind` lands without a mapper case;
      // the runtime throw is belt-and-suspenders for any post-
      // typecheck divergence (e.g. a runtime polyfill bundle).
      throw new Error(
        `selfServiceFailureReason: unmapped ConfirmRenewalError variant — ${JSON.stringify(_exhaustive)}`,
      );
    }
  }
}
