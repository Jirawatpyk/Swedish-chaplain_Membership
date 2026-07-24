/**
 * Plan-change → billing remediation (Phase 2) — renewals adapter implementing
 * the MEMBERS-owned `PlanChangeBillingRemediationPort`.
 *
 * `change-plan` (F3 members) flips `members.plan_id`; this adapter reconciles
 * the member's OPEN (not-yet-invoiced) renewal cycle to the new plan, ON the
 * caller's tx (threaded from change-plan's `runInTenant`, never a nested one),
 * so the re-freeze + its `member_plan_change_billing_effect` audit commit
 * ATOMICALLY with the plan flip (Constitution Principle VIII).
 *
 * Order (ALL on the passed `tx` — Finding #21 closed the one exception: the F2
 * plan-frozen-fields lookup now uses `loadPlanFrozenFieldsInTx(tx, …)`, reading
 * `membership_plans` on the SAME connection rather than opening a nested
 * `runInTenant` under change-plan's held member FOR UPDATE + cycle advisory lock.
 * `membership_plans` is never row-locked by these paths, so the old nested read
 * could not deadlock TODAY, but it violated the repo's "never nest runInTenant
 * while holding a row lock" guardrail — a latent footgun the pooler's dropped
 * statement_timeout would turn into a hang-forever if a future path locked that
 * table):
 *   1. findOpenCycleForMemberInTx        -> null ⇒ `no_open_cycle`
 *   2. acquireCycleLockInTx              (serialise with mark-paid-offline etc.)
 *   3. hasIssuedMembershipInvoiceForMemberInTx -> issued ⇒
 *      `deferred_invoice_already_issued` (+blockingInvoiceId, member_scoped)
 *   4. resolve the new plan's frozen fields for the cycle's fiscal year (on `tx`);
 *      if the new term differs from the cycle's frozen term ⇒ `deferred_term_length_change`
 *   5. flag OFF ⇒ `deferred_immediate_not_enabled`
 *   6. else refreezeOpenCycleForPlanChangeInTx -> non-null ⇒ `applied_to_open_cycle`;
 *      null (raced into linked/terminal) ⇒ `deferred_invoice_already_issued` (linked)
 *   7. emit `member_plan_change_billing_effect` (ALWAYS, same tx, atomic)
 *
 * The FEATURE_PLAN_CHANGE_IMMEDIATE_REFREEZE flag is baked in at construction
 * (`immediateRefreezeEnabled`) — mirrors FEATURE_VOID_ON_REISSUE's
 * flag-as-boolean-in-deps precedent. THROWS on any infra failure so change-
 * plan's tx rolls back (never fire-and-forget).
 *
 * Pure Infrastructure — reaches the F8 cycle repo + F4 invoice-due bridge + F2
 * plan-lookup + the audit port via `makeRenewalsDeps`; imports the members
 * contract TYPE-only (renewals -> members, erased at runtime; Principle III).
 */
import { deriveFiscalYear } from '@/lib/fiscal-year';
import type {
  PlanChangeBillingEffect,
  PlanChangeBillingEffectKind,
  PlanChangeBillingRemediationContext,
  PlanChangeBillingRemediationPort,
} from '@/modules/members';
import type { TenantTx } from '@/lib/db';
import { makeRenewalsDeps } from '../renewals-deps';

/**
 * Internal working outcome — the returned `BillingEffect` plus the extra audit-
 * payload fields the `member_plan_change_billing_effect` row records.
 */
interface RemediationOutcome {
  readonly effect: PlanChangeBillingEffectKind;
  readonly cycleId: string | null;
  readonly oldPriceThb: string | null;
  readonly newPriceThb: string | null;
  readonly effectiveFrom: string | null;
  readonly blockingInvoiceId: string | null;
  readonly blockingSource: 'linked' | 'member_scoped' | null;
}

export function makePlanChangeBillingRemediation(
  tenantId: string,
  opts: { readonly immediateRefreezeEnabled: boolean },
): PlanChangeBillingRemediationPort {
  return {
    async applyPlanChangeToBillingInTx(
      tx: TenantTx,
      ctx: PlanChangeBillingRemediationContext,
    ): Promise<PlanChangeBillingEffect> {
      const deps = makeRenewalsDeps(tenantId);
      const outcome = await computeOutcome(deps, tx, ctx, opts.immediateRefreezeEnabled);

      // Step 7 — ALWAYS emit the forensic audit row, in THIS tx (atomic with
      // the re-freeze + the plan flip). THROWS on failure so change-plan rolls
      // back.
      await deps.planChangeBillingEffectAudit.emitInTx(
        tx,
        {
          tenantId: ctx.tenantId,
          actorUserId: ctx.actorUserId,
          correlationId: ctx.correlationId,
        },
        {
          memberId: ctx.memberId,
          oldPlanId: ctx.oldPlanId,
          newPlanId: ctx.newPlanId,
          cycleId: outcome.cycleId,
          effect: outcome.effect,
          oldPriceThb: outcome.oldPriceThb,
          newPriceThb: outcome.newPriceThb,
          effectiveFrom: outcome.effectiveFrom,
          blockingInvoiceId: outcome.blockingInvoiceId,
          blockingSource: outcome.blockingSource,
        },
      );

      return {
        effect: outcome.effect,
        cycleId: outcome.cycleId,
        blockingInvoiceId: outcome.blockingInvoiceId,
      };
    },
  };
}

async function computeOutcome(
  deps: ReturnType<typeof makeRenewalsDeps>,
  tx: TenantTx,
  ctx: PlanChangeBillingRemediationContext,
  immediateRefreezeEnabled: boolean,
): Promise<RemediationOutcome> {
  // 1. The member's OPEN cycle (upcoming|reminded|awaiting_payment), or null.
  const openCycle = await deps.cyclesRepo.findOpenCycleForMemberInTx(
    tx,
    ctx.tenantId,
    ctx.memberId,
  );
  if (openCycle === null) {
    return {
      effect: 'no_open_cycle',
      cycleId: null,
      oldPriceThb: null,
      newPriceThb: null,
      effectiveFrom: null,
      blockingInvoiceId: null,
      blockingSource: null,
    };
  }
  const cycleId = openCycle.cycleId as string;
  const oldPriceThb = openCycle.frozenPlanPriceThb as string;

  // 2. Serialise with the membership-invoice issue paths (mark-paid-offline
  //    holds this same lock while issuing; confirm-renewal / admin-renew-lapsed
  //    link under it) + concurrent re-freezes.
  await deps.cyclesRepo.acquireCycleLockInTx(tx, ctx.tenantId, openCycle.cycleId);

  // 3. An issued membership §86/4 for this member blocks the re-freeze — a tax
  //    invoice is immutable, so the change must defer (never rewrite it).
  const issued = await deps.invoiceDueBridge.hasIssuedMembershipInvoiceForMemberInTx(
    tx,
    ctx.tenantId,
    ctx.memberId,
  );
  if (issued !== null) {
    return {
      effect: 'deferred_invoice_already_issued',
      cycleId,
      oldPriceThb,
      newPriceThb: null,
      effectiveFrom: null,
      blockingInvoiceId: issued.invoiceId,
      blockingSource: 'member_scoped',
    };
  }

  // 4. Resolve the NEW plan's frozen fields for the CYCLE's fiscal year (the
  //    period the eventual invoice covers), mirroring confirm-renewal's
  //    `deriveFiscalYear(cycle.periodFrom)`. `mode:'freeze'` — re-freezing an
  //    open cycle is a freeze, and change-plan pre-validated the plan exists,
  //    so this resolves the exact-year row (or the freeze fallback). A term
  //    change would require re-deriving the cycle period (out of scope) — defer.
  const fiscalYear = deriveFiscalYear(openCycle.periodFrom);
  // Finding #21 — thread the caller's `tx` (change-plan holds the member FOR
  // UPDATE + cycle advisory lock) instead of the port's connection-fresh
  // `loadPlanFrozenFields`, which opened a nested `runInTenant` = a 2nd pooled
  // connection under a held row lock. Same rows, same resolution, one connection.
  const lookup = await deps.planLookupForRenewal.loadPlanFrozenFieldsInTx(tx, {
    tenantId: ctx.tenantId,
    planId: ctx.newPlanId,
    fiscalYear,
    mode: 'freeze',
  });
  if (lookup.status !== 'found') {
    // Defensive: change-plan already validated the new plan exists + is active
    // for `newPlanYear`, so a non-`found` result here means the plan vanished
    // mid-tx or has no row for the cycle's fiscal year. Throw so the whole
    // plan flip rolls back rather than silently freezing a wrong price.
    throw new Error(
      `[plan-change-billing-remediation] new plan ${ctx.newPlanId} unresolvable ` +
        `for cycle ${cycleId} fiscal year ${fiscalYear} (status=${lookup.status})`,
    );
  }
  const newFrozen = lookup.plan;
  const newPriceThb = newFrozen.priceTHB as string;

  if (newFrozen.termMonths !== openCycle.frozenPlanTermMonths) {
    return {
      effect: 'deferred_term_length_change',
      cycleId,
      oldPriceThb,
      newPriceThb,
      effectiveFrom: null,
      blockingInvoiceId: null,
      blockingSource: null,
    };
  }

  // 5. Flag off — defer to the next cycle (Phase-1 behaviour).
  if (!immediateRefreezeEnabled) {
    return {
      effect: 'deferred_immediate_not_enabled',
      cycleId,
      oldPriceThb,
      newPriceThb,
      effectiveFrom: openCycle.periodFrom,
      blockingInvoiceId: null,
      blockingSource: null,
    };
  }

  // 6. Re-freeze the open, unlinked cycle to the new plan/price/tier.
  const refrozen = await deps.cyclesRepo.refreezeOpenCycleForPlanChangeInTx(
    tx,
    ctx.tenantId,
    openCycle.cycleId,
    {
      planIdAtCycleStart: ctx.newPlanId,
      tierAtCycleStart: newFrozen.tierBucket,
      frozenPlanPriceThb: newFrozen.priceTHB,
      frozenPlanTermMonths: newFrozen.termMonths,
      frozenPlanCurrency: newFrozen.currency,
    },
  );
  if (refrozen === null) {
    // The cycle raced into a linked/terminal state between the probe and here
    // (its §86/4 was just issued+linked). Defer — never rewrite it.
    return {
      effect: 'deferred_invoice_already_issued',
      cycleId,
      oldPriceThb,
      newPriceThb,
      effectiveFrom: null,
      blockingInvoiceId: null,
      blockingSource: 'linked',
    };
  }

  return {
    effect: 'applied_to_open_cycle',
    cycleId,
    oldPriceThb,
    newPriceThb,
    effectiveFrom: openCycle.periodFrom,
    blockingInvoiceId: null,
    blockingSource: null,
  };
}
