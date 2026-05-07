/**
 * F8 Phase 5 Wave B · T122 — `confirmRenewal`.
 *
 * Member confirms their renewal via the public portal page. Flow:
 *
 *   1. Validate cycle is in `awaiting_payment` + matches the URL [memberId].
 *   2. (Optional plan-change branch FR-025) — if `newPlanId` provided AND
 *      differs from `cycle.planIdAtCycleStart`:
 *        a. Lookup new plan via `planLookupForRenewal` port.
 *        b. Atomically update cycle's `frozen_plan_*` columns
 *           (`cyclesRepo.updateFrozenPlan` — single UPDATE per FR-021b).
 *        c. Emit `renewal_with_plan_change` + `renewal_cycle_price_frozen`
 *           audits inside the same tx.
 *   3. Compose F4 createInvoiceDraft → issueInvoice via the
 *      `f4InvoicingForRenewalBridge` port.
 *   4. Link the issued invoice to the cycle (`cyclesRepo.linkInvoice`).
 *   5. Emit `renewal_invoice_created` audit.
 *   6. Return `{ invoiceId, payUrl }` for the route handler to redirect
 *      to F5 `/portal/invoices/<invoiceId>/pay`.
 *
 * Coverage policy: Constitution Principle II — 100% branch coverage
 * required (security-critical mutating path; collects member payment
 * intent). The branches are:
 *   - happy path no plan-change
 *   - happy path with plan-change
 *   - cycle_not_found
 *   - cross_member_probe
 *   - cycle_not_payable (status mismatch)
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
import { asMemberId } from '@/modules/members';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import type {
  F4InvoicingForRenewalBridge,
  IssueInvoiceForRenewalResult,
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
      readonly errorCode: string;
      readonly detail: string;
    }
  | { readonly kind: 'server_error'; readonly message: string };

export interface ConfirmRenewalDeps
  extends Pick<
    RenewalsDeps,
    'tenant' | 'cyclesRepo' | 'auditEmitter'
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
    const cycle = await deps.cyclesRepo.findByIdInTx(
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
    if (cycle.status !== 'awaiting_payment') {
      return err({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }

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
  const invoiceResult = await deps.f4InvoicingBridge.issueInvoiceForRenewal({
    tenantId: input.tenantId,
    memberId: input.memberId,
    planId: cycleAfterPlanChange.planIdAtCycleStart,
    planYear: input.planYear,
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
