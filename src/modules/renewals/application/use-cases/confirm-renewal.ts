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
 *   5. Link the issued invoice to the cycle AND reconcile the cycle's
 *      frozen_plan_* fields to what the §86/4 actually billed, in one
 *      guarded statement (`cyclesRepo.linkInvoiceAndReconcileFrozenPlanInTx`).
 *      This closes Finding #20 (Phase 2 #238): Step-1's frozen-price capture
 *      + Step-3's §86/4 issue run OUTSIDE the per-cycle advisory lock, so a
 *      concurrent admin change-plan immediate-refreeze can refreeze this open,
 *      unlinked cycle to a DIFFERENT price in the gap. The §86/4 is immutable
 *      and bills the price the member confirmed, so the cycle is reconciled
 *      back to that billed snapshot (the plan change defers to the next cycle);
 *      a corrective `renewal_cycle_price_frozen` audit is emitted iff a real
 *      divergence was healed.
 *   6. Emit `renewal_invoice_created` audit.
 *   7. Return `{ invoiceId, payUrl }` for the route handler to redirect
 *      to `/portal/invoices/<invoiceId>?pay=1` — the invoice detail page,
 *      where `?pay=1` auto-opens the in-page F5 PaySheet (`<PayNowButton>`,
 *      FR-025c). NOTE: there is no `/pay` sub-route page — a trailing
 *      `/pay` 404s (fixed 2026-06-22).
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
import { deriveFiscalYear } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import { omitUndefined } from '@/lib/object-helpers';
// WP4 — the downgrade gate compares the cycle's frozen price to the target
// plan's price as THB satang. `cycleFrozenPriceSatang` + `parseThbDecimalToSatang`
// are the audited THB-decimal→satang parsers; `satangToProcessorAmount` is the
// single auditable bigint→number narrowing (C-1..C-4). No bare `Number()`.
import { satangToProcessorAmount, parseThbDecimalToSatang } from '@/lib/money';
import { asMemberId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
  RenewalInvoiceErrorCode,
} from '../ports/f4-invoicing-bridge';
import type {
  PlanFrozenFields,
  PlanLookupForRenewalPort,
} from '../ports/plan-lookup-for-renewal';
import { classifyMembershipPayment } from '../../domain/classify-membership-payment';
import {
  classifyPlanPriceChange,
  requiresDowngradeAck,
} from '../../domain/plan-price-change';
import { loadClassificationCounts } from './_lib/classification-input';
import {
  parseCycleId,
  cycleFrozenPriceSatang,
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
  // WP4 — the member's explicit two-step acknowledgement that they are
  // switching to a LOWER-priced plan (loses benefits + pays less). Tolerant
  // `z.boolean().optional()` here (the wire schema keeps `z.literal(true)`);
  // the gate treats any non-`true` value as "not acknowledged", so an honest
  // `false` is never a validation error.
  acknowledgeDowngrade: z.boolean().optional(),
  // 070 (FR-022 / L2 security) — `planYear` REMOVED from the input. The
  // §86/4 fiscal year (the "Membership {year}" label + the §87 numbering
  // bucket) is a tax-document field and MUST be SERVER-derived, never
  // client-supplied. It is now derived from the authoritative re-read
  // cycle's `period_from` via `deriveFiscalYear` (see Step-3 below),
  // mirroring `admin-renew-lapsed-member`. The route no longer trusts a
  // posted `planYear`; the portal page may still pass it as a display
  // prop, but the server ignores it. (Previously the client could POST a
  // different fiscal year than the page rendered → wrong year on a tax
  // document; the page also derived from `expiresAt` (period END), an
  // off-by-one vs the catalogue plan_year for cycles crossing a year
  // boundary.)
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
      // WP4 — the member chose a lower-priced plan without the explicit
      // acknowledgement flag. Carries both prices (THB satang / minor units)
      // + currency so the route echoes them and the client renders the
      // before/after in the downgrade dialog. Server-derived — the client
      // never posts a price.
      readonly kind: 'downgrade_not_acknowledged';
      readonly currentPriceMinorUnits: number;
      readonly newPriceMinorUnits: number;
      readonly currency: PlanFrozenFields['currency'];
    }
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
    | 'tenant'
    | 'cyclesRepo'
    | 'auditEmitter'
    | 'clock'
    | 'memberRenewalFlagsRepo'
    // Package B1 — persist the member's plan pick to members.plan_id.
    | 'memberPlanWriter'
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
    // WP4 (a) — HOISTED terminal-status guard. A cycle that is neither
    // payable now (`awaiting_payment`) nor lazily-payable (`upcoming|reminded`)
    // is terminal / pending_admin_reactivation and not self-renewable. Hoisted
    // ABOVE both the downgrade pre-flight and the first write (the lazy
    // transition) so:
    //   • status precedence beats plan precedence — a terminal cycle + a bogus
    //     newPlanId returns `cycle_not_payable`, never `plan_not_found` (the
    //     plan lookup below never runs); and
    //   • a downgrade refusal can never commit a state flip (`err()` inside
    //     `runInTenant` COMMITS earlier writes — this file uses throw-to-abort,
    //     but the guards must still sit above the first write).
    // This subsumes the former `else if (status !== 'awaiting_payment')` arm at
    // the tail of the lazy transition, which is now dead.
    if (
      cycle.status !== 'upcoming' &&
      cycle.status !== 'reminded' &&
      cycle.status !== 'awaiting_payment'
    ) {
      return err({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }

    // WP4 (b) + (c) — DOWNGRADE PRE-FLIGHT (read-only), BEFORE any state write.
    // Resolve the target plan for THIS cycle's fiscal year (`mode:'offer'` —
    // same lookup the plan-change branch performs), classify the price move,
    // and refuse a lower-priced switch that lacks the member's explicit
    // acknowledgement. Both the `(newPlanId, deriveFiscalYear(periodFrom))`
    // lookup key and the frozen current price are IMMUTABLE across the lazy
    // CAS re-read below, so the branch reuses `preflightPlan` — no double
    // round-trip in the common case (C-8). The comparison is two THB satang
    // numbers only (currency axis dropped, C-5).
    let preflightPlan: PlanFrozenFields | null = null;
    if (input.newPlanId && input.newPlanId !== cycle.planIdAtCycleStart) {
      const preflightResult = await deps.planLookupForRenewal.loadPlanFrozenFields({
        tenantId: input.tenantId,
        planId: input.newPlanId,
        fiscalYear: deriveFiscalYear(cycle.periodFrom),
        mode: 'offer',
      });
      if (preflightResult.status === 'not_found') {
        return err({ kind: 'plan_not_found' as const });
      }
      if (preflightResult.status === 'plan_inactive') {
        return err({ kind: 'plan_inactive' as const });
      }
      preflightPlan = preflightResult.plan;
      const currentPriceMinorUnits = satangToProcessorAmount(
        cycleFrozenPriceSatang(cycle),
      );
      const newPriceMinorUnits = satangToProcessorAmount(
        parseThbDecimalToSatang(preflightPlan.priceTHB),
      );
      const priceChange = classifyPlanPriceChange({
        currentMinorUnits: currentPriceMinorUnits,
        targetMinorUnits: newPriceMinorUnits,
      });
      if (requiresDowngradeAck(priceChange) && input.acknowledgeDowngrade !== true) {
        return err({
          kind: 'downgrade_not_acknowledged' as const,
          currentPriceMinorUnits,
          newPriceMinorUnits,
          currency: preflightPlan.currency,
        });
      }
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
    }
    // (cycle.status === 'awaiting_payment' falls through unchanged — already
    // payable, proceed. The terminal / pending_admin_reactivation reject is
    // handled by the hoisted WP4 guard above, before any write.)

    // Plan-change branch (FR-021b atomic)
    let planChanged = false;
    let resolvedCycle: RenewalCycle = cycle;
    if (input.newPlanId && input.newPlanId !== cycle.planIdAtCycleStart) {
      // WP4 — reuse the read-only pre-flight lookup (same `(planId,
      // fiscalYear)` key — both immutable across the lazy CAS re-read, so
      // the price/tier are identical). The pre-flight runs on the IDENTICAL
      // condition as this branch, so `preflightPlan` is always populated here;
      // the null guard is belt-and-suspenders against a future reorder (fails
      // loud rather than silently skipping the §86/4 re-freeze).
      if (preflightPlan === null) {
        return err({
          kind: 'server_error' as const,
          message: 'plan-change pre-flight missing before frozen-plan re-freeze',
        });
      }
      const planFields: PlanFrozenFields = preflightPlan;
      try {
        resolvedCycle = await deps.cyclesRepo.updateFrozenPlan(
          tx,
          input.tenantId,
          cycleId,
          {
            planIdAtCycleStart: input.newPlanId,
            tierAtCycleStart: planFields.tierBucket,
            frozenPlanPriceThb: planFields.priceTHB,
            frozenPlanTermMonths: planFields.termMonths,
            frozenPlanCurrency: planFields.currency,
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
            frozen_price_thb: planFields.priceTHB,
            frozen_term_months: planFields.termMonths,
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

      // Package B1 — persist the member's own plan pick to members.plan_id
      // (+ plan_year) in the SAME tx, so it does NOT revert one cycle later
      // when Package A's next-cycle seed reads members.plan_id. FK-safe: the
      // `mode:'offer'` lookup above already resolved `(newPlanId,
      // deriveFiscalYear(periodFrom))` to an ACTIVE catalogue row (a
      // not_found / plan_inactive result returned err BEFORE any write), so
      // the members composite FK cannot violate. plan_year is the SAME fiscal
      // year the §86/4 buckets into (derived at line ~500). Placed after the
      // cycle re-freeze so a throw here rolls the whole Step-1 tx back via the
      // file's throw-to-rollback mechanism — `err()` would COMMIT the partial
      // change (the runInTenant gotcha).
      await deps.memberPlanWriter.writePlanIdInTx(
        tx,
        input.tenantId,
        cycle.memberId,
        input.newPlanId,
        deriveFiscalYear(cycle.periodFrom),
      );
    }

    // F1 (final-review, 2026-07-09) — classify the payment for the SAME
    // shared classifier every settlement site consumes (mark-paid-offline,
    // mark-cycle-complete-from-invoice-paid, resolve-unlinked-membership-
    // payment), so the §86/4 issued below OMITS the exact-window text for
    // a `first_payment` shape (the member's one-and-only cycle, never
    // anchored to a real payment). Without this gate, a NEVER-PAID member
    // reaching confirm-renewal got the "next period" window printed on
    // their FIRST invoice — but `onPaid` at the F4-paid callback site
    // (`mark-cycle-complete-from-invoice-paid.ts`) RE-ANCHORS a
    // first-payment cycle to the actual payment month instead of
    // completing it, so the printed window described a period that would
    // never exist (tax-document text is stored at issue and never
    // mutated). `resolvedCycle.status` is guaranteed `'awaiting_payment'`
    // here (every other status returned `cycle_not_payable` above) — the
    // ternary mirrors `mark-paid-offline.ts`'s existing shape rather than
    // asserting, so a defensive `null`-style fallback isn't needed.
    // FIX-7(d) (PR #173 review, 2026-07-09) — was a hardcoded
    // `memberErased: false` on the reasoning "an erased member's session
    // is invalidated at erasure time (COMP-1), so this route is
    // unreachable for them". `mark-cycle-complete-from-invoice-paid.ts`'s
    // own history shows that exact reasoning was WRONG once already (a
    // hardcoded `false` there silently let an erased member's
    // first-payment cycle re-anchor) — read the REAL flag here too,
    // defensively, in the SAME round-trip pattern every other settlement
    // site uses.
    const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
      tx,
      input.tenantId,
      resolvedCycle.memberId,
    );
    // FIX-8(a) (PR #173 review, 2026-07-09) — shared loader (was inline
    // duplicated at every settlement site).
    const { cycleCountForMember, settledCycleCountForMember } =
      await loadClassificationCounts(
        deps,
        tx,
        input.tenantId,
        resolvedCycle.memberId,
        resolvedCycle.cycleId,
      );
    const classification = classifyMembershipPayment({
      cycleCountForMember,
      settledCycleCountForMember,
      openCycle:
        resolvedCycle.status === 'awaiting_payment'
          ? { status: 'awaiting_payment', anchoredAt: resolvedCycle.anchoredAt }
          : { status: 'upcoming', anchoredAt: resolvedCycle.anchoredAt },
      memberErased: guards?.erased === true,
    });
    // FIX-7(d) — widened from `=== 'first_payment'`: an erased member's
    // classification resolves `not_applicable(erased)`, not `first_payment`
    // or `renewal`; printing the exact next-period window on a §86/4 for a
    // GDPR-erased member is just as wrong as printing it for a genuine
    // first-payment member (the window describes a period this classifier
    // call says should not be trusted) — omit it for ANY non-`renewal`
    // result, not only the literal `first_payment` shape.
    const omitMembershipCoverage = classification.kind !== 'renewal';

    return ok({ cycle: resolvedCycle, planChanged, omitMembershipCoverage });
  });
  if (!stateResult.ok) return err(stateResult.error);
  const {
    cycle: cycleAfterPlanChange,
    planChanged,
    omitMembershipCoverage,
  } = stateResult.value;

  // ---- Step 3: F4 invoice creation OUTSIDE F8 tx
  // FR-022 — bill the cycle's FROZEN price on the §86/4, not the live
  // F2 catalogue price. `cycleAfterPlanChange` is the Step-1 tx's
  // server-side cycle row (already re-snapshotted by `updateFrozenPlan`
  // when the member changed plan), so its `frozenPlanPriceThb` is the
  // authoritative VAT-exclusive amount — never derived from request body.
  //
  // 070 (FR-022 / L2 security) — derive `planYear` SERVER-SIDE too. Like
  // the frozen price, the §86/4's fiscal year is a tax-document field and
  // must NOT be client-influenceable. We derive it from the authoritative
  // re-read cycle's `period_from` using the SAME `deriveFiscalYear` the F4
  // §87 sequential-number allocator + `admin-renew-lapsed-member` use, so a
  // renewal invoice buckets into the identical fiscal year regardless of
  // which path (portal confirm vs admin renew vs the F4 invoices surface)
  // issued it. `period_from` is the period START — the membership the F2
  // catalogue prices (and keys by `plan_year`) — so this also matches the
  // `(plan_id, plan_year)` row `createInvoiceDraft.getAnnualFeeSatang`
  // requires. (The prior `input.planYear`, sourced from the page's
  // `expiresAt`/period-END `getUTCFullYear()`, was both client-tamperable
  // AND off-by-one for cycles whose period crosses a calendar-year edge.)
  //
  // SAFE-PIN (rolling-anchor axis) — `planYear` is the FROZEN-CATALOGUE key
  // (the `(plan_id, plan_year)` FK + `getAnnualFeeSatang` lookup in
  // `create-invoice-draft.ts`), keyed to `period_from`'s fiscal year. On an
  // ANCHORED renewal it DELIBERATELY lags the PRINTED coverage by one period:
  // the §86/4 face prints the NEXT term (`period_to → period_to + term`;
  // `feeYearCe` = that window's start year — see the `membershipCoverage`
  // below) while `planYear` stays on the CURRENT term. The three years are
  // INDEPENDENT axes: printed coverage year ← the coverage window; §87
  // sequential numbering ← the issue-date `fiscal_year` (`issue-invoice.ts`,
  // NEVER planYear); catalogue FK key ← this `planYear`.
  //
  // DO NOT change to `deriveFiscalYear(cycleAfterPlanChange.periodTo)`: the
  // next-year catalogue row is not cloned until that year, so
  // `getAnnualFeeSatang(planId, nextYear)` is null → `plan_not_found` → the
  // first anchored renewal cannot issue. That naive "fix" is a regression,
  // not a correction. Pinned by
  // tests/integration/renewals/confirm-renewal-anchored-plan-year-pin.test.ts.
  const planYear = deriveFiscalYear(cycleAfterPlanChange.periodFrom);

  // Rolling-anchor refactor (design 2026-07-08 rev 3 §3, Task 8) — a
  // RENEWAL-classified confirm-renewal cycle always has a defined period,
  // so the §86/4 prints the EXACT NEXT-period window (`periodTo →
  // periodTo + frozenPlanTermMonths`) instead of the generic "from
  // payment" default. CAREFUL: this bills the period STARTING at the
  // open cycle's `periodTo` (the current cycle completes on payment; the
  // invoice covers the cycle that gets created next), NOT `periodFrom →
  // periodTo` (the cycle's OWN, already-elapsing period).
  //
  // F1 (final-review, 2026-07-09) — classification-gated (was
  // unconditional). A `first_payment` shape OMITS `membershipCoverage`
  // entirely: `createInvoiceDraft` falls back to its own `{ kind:
  // 'from_payment' }` default, matching `mark-paid-offline.ts`'s
  // first-payment branch — the re-anchored period doesn't exist yet at
  // invoice-issue time (re-anchor happens later, at the F4-paid callback
  // site, when the member actually pays). FIX-7(d) — ALSO omitted for the
  // (previously unreachable-in-theory, now defensively handled)
  // GDPR-erased `not_applicable` shape; see `omitMembershipCoverage`'s
  // Step-1 computation above.
  const membershipCoverage = omitMembershipCoverage
    ? undefined
    : ({
        kind: 'window' as const,
        fromIso: cycleAfterPlanChange.periodTo,
        toIso: addMonthsUtc(
          cycleAfterPlanChange.periodTo,
          cycleAfterPlanChange.frozenPlanTermMonths,
        ),
      });
  const invoiceResult = await deps.f4InvoicingBridge.issueInvoiceForRenewal({
    tenantId: input.tenantId,
    memberId: input.memberId,
    planId: cycleAfterPlanChange.planIdAtCycleStart,
    planYear,
    frozenPlanPriceThb: cycleAfterPlanChange.frozenPlanPriceThb,
    // FIX-8(c) (PR #173 review, 2026-07-09) — `omitUndefined` replaces the
    // conditional-spread idiom; exactOptionalPropertyTypes still omits the
    // key entirely on the first-payment branch rather than assigning an
    // explicit `undefined`.
    ...omitUndefined({ membershipCoverage }),
    autoEmailOnIssue: true,
    actorUserId: input.actorUserId,
    correlationId: input.correlationId,
    requestId: input.requestId ?? null,
  });
  if (invoiceResult.status !== 'issued') {
    return mapInvoiceError(invoiceResult);
  }

  // ---- Step 4 + 5: link invoice + reconcile frozen price + emit audit atomically
  return runInTenant(deps.tenant, async (tx) => {
    // I1 review-fix: acquire per-cycle advisory lock first so two
    // concurrent confirms serialise on the link step. Combined with the
    // adapter's `WHERE (linked_invoice_id IS NULL OR = $1)` guard, this
    // closes the orphan-invoice race for all but pathological clock-
    // skew scenarios (covered by the conflict-error branch below).
    await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

    // Finding #20 (Phase 2 #238 adversarial money-path review) — Step-1's
    // frozen-price CAPTURE and Step-3's §86/4 ISSUE run OUTSIDE this advisory
    // lock (it was released at Step-1's commit). A concurrent admin `change-plan`
    // immediate-refreeze can land in that gap and CAS-refreeze this still-open,
    // still-unlinked cycle to a DIFFERENT plan/price (recording
    // applied_to_open_cycle). The §86/4 we issued in Step-3 bills the price the
    // MEMBER CONFIRMED (`cycleAfterPlanChange`, an immutable tax document), so we
    // LINK and simultaneously RECONCILE the cycle's frozen fields back to that
    // billed snapshot in one guarded statement (under the re-acquired lock, so no
    // concurrent refreeze can slip between the two). The plan change defers to the
    // next cycle — the member is never rebilled a price they did not confirm.
    // `previous` carries the cycle's pre-link frozen fields so we emit a truthful
    // corrective audit ONLY when a real divergence was healed.
    let linkResult: {
      readonly cycle: RenewalCycle;
      readonly previous: RenewalCycle;
    };
    try {
      linkResult = await deps.cyclesRepo.linkInvoiceAndReconcileFrozenPlanInTx(
        tx,
        input.tenantId,
        cycleId,
        invoiceResult.invoiceId,
        {
          planIdAtCycleStart: cycleAfterPlanChange.planIdAtCycleStart,
          tierAtCycleStart: cycleAfterPlanChange.tierAtCycleStart,
          frozenPlanPriceThb: cycleAfterPlanChange.frozenPlanPriceThb,
          frozenPlanTermMonths: cycleAfterPlanChange.frozenPlanTermMonths,
          frozenPlanCurrency: cycleAfterPlanChange.frozenPlanCurrency,
        },
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

    // Finding #20 — a concurrent change-plan refroze this cycle mid-issue iff the
    // pre-link PRICE differs from what the §86/4 billed. Price (VAT-exclusive
    // satang) is BOTH the money invariant this fix guarantees (cycle.frozen ==
    // linked line unit_price) AND the exact axis the standing divergence scan
    // (`checkPlanChangeDivergence`) compares, so gating the corrective audit on
    // it keeps the two in lock-step. The link above already reconciled the DATA
    // for ALL five frozen fields (the repo UPDATE overwrites plan/tier/term/
    // currency too, so a degenerate same-price plan-swap is still made
    // consistent); here we make the AUDIT trail truthful only when a real,
    // scan-visible divergence was healed — emit a corrective
    // `renewal_cycle_price_frozen` recording that the cycle's final frozen price
    // is the billed one (superseding the concurrent change-plan's
    // applied_to_open_cycle). Same tx as the link, so an emit failure rolls the
    // reconcile+link back (Principle VIII).
    const frozenReconciled =
      cycleFrozenPriceSatang(linkResult.previous) !==
      cycleFrozenPriceSatang(cycleAfterPlanChange);
    if (frozenReconciled) {
      await deps.auditEmitter.emitInTx(
        tx,
        {
          type: 'renewal_cycle_price_frozen' as const,
          payload: {
            cycle_id: cycleAfterPlanChange.cycleId,
            plan_id: cycleAfterPlanChange.planIdAtCycleStart,
            frozen_price_thb: cycleAfterPlanChange.frozenPlanPriceThb,
            frozen_term_months: cycleAfterPlanChange.frozenPlanTermMonths,
            // Reconciliation forensics (permissive payload; keys extend the
            // plan-change emit's shape). `reverted_*` records the price/plan the
            // concurrent change-plan had refrozen the cycle to, which this
            // reconcile undid — the plan change defers to the next cycle.
            reconciled_from_concurrent_plan_change: true,
            reverted_frozen_price_thb: linkResult.previous.frozenPlanPriceThb,
            reverted_plan_id: linkResult.previous.planIdAtCycleStart,
            invoice_id: invoiceResult.invoiceId,
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
      logger.warn(
        {
          cycleId,
          invoiceId: invoiceResult.invoiceId,
          billedFrozenPriceThb: cycleAfterPlanChange.frozenPlanPriceThb,
          revertedFrozenPriceThb: linkResult.previous.frozenPlanPriceThb,
        },
        '[confirm-renewal] reconciled cycle frozen price back to the billed §86/4 — a concurrent plan-change refroze this open cycle mid-issue; the plan change defers to the next cycle',
      );
      renewalsMetrics.planChangeDivergenceReconciled(input.tenantId);
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
      // Member PAY surface is the invoice detail PAGE (hosts the in-page F5
      // PaySheet via <PayNowButton>). `?pay=1` auto-opens the PaySheet on
      // load (FR-025c) — the SAME deep-link the F4/F5 invoice emails use
      // (`buildPayOnlineUrl`) — so confirm lands the member directly in the
      // pay flow. There is NO `/portal/invoices/[id]/pay` PAGE route — a
      // trailing `/pay` 404'd the member right after a successful confirm
      // (found 2026-06-22 /verify; only the `/api/invoices/[id]/pay`
      // PaymentIntent API exists, not a page).
      payUrl: `/portal/invoices/${invoiceResult.invoiceId}?pay=1`,
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
  | 'downgrade_unacknowledged'
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
    case 'downgrade_not_acknowledged':
      return 'downgrade_unacknowledged';
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
