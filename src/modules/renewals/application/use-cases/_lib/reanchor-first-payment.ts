/**
 * Renewal rolling-anchor refactor (design 2026-07-08 rev 3, migration 0238)
 * — shared first-payment re-anchor core.
 *
 * Extracted (Task 6) from `resolveUnlinkedMembershipPaymentInTx`'s
 * `firstPayment` branch (Task 5) so BOTH settlement sites that re-anchor a
 * member's un-anchored open cycle to the actual payment month share ONE
 * implementation of: month-start anchor-date derivation, FY-crossing
 * frozen-field re-resolution, the guarded `reanchorPeriodInTx` UPDATE, and
 * the `renewal_cycle_reanchored` audit emit + metric.
 *
 *   1. The unlinked-invoice hook (`resolveUnlinkedMembershipPaymentInTx`'s
 *      `firstPayment` branch) — payment on an invoice F8 never linked.
 *   2. `markCycleCompleteInTx`'s LINKED path (Task 6) — a first-ever
 *      payment on a cycle confirm-renewal already linked to this invoice
 *      (the `linked_invoice_id` is cleared by the guarded UPDATE itself;
 *      see `reanchorPeriodInTx`'s docstring — its WHERE does not condition
 *      on `linked_invoice_id`, so passing the already-linked cycle here
 *      works without any special-casing).
 *
 * Callers own their own race-recovery fallback when this returns `null`
 * (0 rows matched the guard — a concurrent write already moved the cycle
 * out of the un-anchored-open state): the unlinked hook reclassifies +
 * falls through to `renewal`/held-for-admin; the linked path re-reads and
 * falls through to its existing status-guard + autoComplete/holdForAdmin
 * flow. This function itself NEVER retries or loops.
 *
 * Pure Application — orchestrates Domain via port interfaces only. No
 * ORM / HTTP / framework / React imports (Constitution Principle III).
 */
import type { TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { deriveFiscalYear, type FiscalYearStartMonth } from '@/lib/fiscal-year';
import { addMonthsUtc } from '@/lib/dates';
import type { F4InvoicePaidEvent, InvoiceId } from '@/modules/invoicing';
import type { MemberId } from '@/modules/members';
import { asCycleId, type RenewalCycle } from '../../../domain/renewal-cycle';
import type { RenewalCycleRepo } from '../../ports/renewal-cycle-repo';
import type { PlanLookupForRenewalPort } from '../../ports/plan-lookup-for-renewal';
import type { RenewalAuditEmitter } from '../../ports/renewal-audit-emitter';
import type { FiscalYearStartMonthPort } from '../../ports/fiscal-year-settings-port';
import { paymentAnchorMonthStartUtc } from './payment-anchor-date';

export type ReanchorFirstPaymentDeps = {
  readonly cyclesRepo: Pick<RenewalCycleRepo, 'reanchorPeriodInTx'>;
  readonly planLookup: Pick<PlanLookupForRenewalPort, 'loadPlanFrozenFields'>;
  readonly auditEmitter: Pick<RenewalAuditEmitter, 'emitInTx'>;
  /**
   * FIX-3 (PR #173 review, 2026-07-09) — the tenant's configured
   * `fiscal_year_start_month`, threaded into the FY-crossing boundary
   * check below instead of silently defaulting to January.
   */
  readonly fiscalYearSettings: Pick<
    FiscalYearStartMonthPort,
    'getFiscalYearStartMonth'
  >;
};

export type ReanchorFirstPaymentResult = {
  readonly cycle: RenewalCycle;
  readonly refrozePlanFields: boolean;
  readonly reminderEventsReset: number;
};

const AUDIT_ACTOR = { actorUserId: null, actorRole: 'system' as const };

/**
 * Re-anchor `cycle` (the member's un-anchored open cycle, `status IN
 * ('upcoming','awaiting_payment')` + `anchored_at IS NULL`) to the actual
 * payment month. Re-freezes the plan's frozen fields when the re-anchor
 * crosses a fiscal-year boundary (an unresolvable plan keeps the old
 * frozen fields + a loud log rather than failing the payment). Emits
 * `renewal_cycle_reanchored` + the `unlinkedPaymentResolved('reanchored')`
 * metric in the SAME tx as the write.
 *
 * Returns `null` when the guarded UPDATE matched 0 rows (lost a race
 * against a concurrent write) — the caller re-reads and decides its own
 * fallback; this function never retries.
 */
export async function reanchorFirstPaymentCycleInTx(
  deps: ReanchorFirstPaymentDeps,
  evt: F4InvoicePaidEvent,
  tx: TenantTx,
  cycle: RenewalCycle,
): Promise<ReanchorFirstPaymentResult | null> {
  // F2 (final-review, 2026-07-09) — a first-payment cycle can still carry
  // a `linkedInvoiceId` that is NOT the invoice actually being paid: e.g.
  // confirm-renewal (or an F8-dispatched reminder) parked a DIFFERENT
  // invoice on this cycle, and the member instead settled an unrelated
  // ad-hoc invoice out of band. Re-anchoring proceeds regardless (the
  // guarded UPDATE below clears `linked_invoice_id`, matching
  // `reanchorPeriodInTx`'s documented WHERE clause), but the now-orphaned
  // parked invoice needs a human to void it — mirrors the SAME loud-log
  // pattern `resolve-unlinked-membership-payment.ts`'s `renewalComplete`
  // branch already applies for the `renewal` classification; this closes
  // the gap for the `first_payment` classification (both call sites of
  // this shared core — the unlinked hook's `firstPayment` branch and
  // `markCycleCompleteInTx`'s linked path).
  if (cycle.linkedInvoiceId !== null && cycle.linkedInvoiceId !== evt.invoiceId) {
    logger.error(
      {
        cycleId: cycle.cycleId,
        orphanedInvoiceId: cycle.linkedInvoiceId,
        payingInvoiceId: evt.invoiceId,
        tenantId: evt.tenantId,
        memberId: evt.memberId,
      },
      '[reanchor-first-payment] orphaned invoice — staff must void',
    );
  }

  const anchorDate = paymentAnchorMonthStartUtc(evt);

  // FIX-3 (PR #173 review, 2026-07-09) — thread the tenant's REAL
  // fiscal-year-start-month into the boundary check. Without this, a
  // non-January-start tenant's re-anchor could silently skip re-freezing
  // the plan's price/term for the new fiscal year (the previous
  // `deriveFiscalYear` calls below took no `startMonth` arg, defaulting
  // to January for every tenant).
  const startMonth = (await deps.fiscalYearSettings.getFiscalYearStartMonth(
    evt.tenantId,
  )) as FiscalYearStartMonth;
  const oldFiscalYear = deriveFiscalYear(cycle.periodFrom, startMonth);
  const newFiscalYear = deriveFiscalYear(anchorDate, startMonth);

  let frozenPlanPriceThb = cycle.frozenPlanPriceThb;
  let frozenPlanTermMonths = cycle.frozenPlanTermMonths;
  let refrozePlanFields = false;

  if (newFiscalYear !== oldFiscalYear) {
    const resolved = await deps.planLookup.loadPlanFrozenFields({
      tenantId: evt.tenantId,
      planId: cycle.planIdAtCycleStart,
      fiscalYear: newFiscalYear,
      mode: 'freeze',
    });
    if (resolved.status === 'found') {
      frozenPlanPriceThb = resolved.plan.priceTHB;
      frozenPlanTermMonths = resolved.plan.termMonths;
      refrozePlanFields = true;
    } else {
      logger.error(
        {
          cycleId: cycle.cycleId,
          planId: cycle.planIdAtCycleStart,
          newFiscalYear,
          status: resolved.status,
        },
        '[reanchor-first-payment] re-anchor crossed a fiscal-year boundary but the plan is unresolvable for the new year — keeping old frozen fields',
      );
    }
  }

  const newPeriodTo = addMonthsUtc(anchorDate, frozenPlanTermMonths);

  const reanchored = await deps.cyclesRepo.reanchorPeriodInTx(
    tx,
    evt.tenantId,
    cycle.cycleId,
    {
      periodFrom: anchorDate,
      periodTo: newPeriodTo,
      anchoredAt: anchorDate,
      anchorInvoiceId: evt.invoiceId,
      frozenPlanPriceThb,
      frozenPlanTermMonths,
    },
  );
  if (!reanchored) {
    return null;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_reanchored',
      payload: {
        cycle_id: asCycleId(cycle.cycleId),
        member_id: cycle.memberId as MemberId,
        invoice_id: evt.invoiceId as InvoiceId,
        old_period_from: cycle.periodFrom,
        old_period_to: cycle.periodTo,
        new_period_from: reanchored.cycle.periodFrom,
        new_period_to: reanchored.cycle.periodTo,
        old_status: cycle.status,
        refroze_plan_fields: refrozePlanFields,
        reminder_events_reset: reanchored.reminderEventsReset,
      },
    },
    {
      tenantId: evt.tenantId,
      ...AUDIT_ACTOR,
      correlationId: `f4-paid:${evt.invoiceId}`,
    },
  );

  renewalsMetrics.unlinkedPaymentResolved('reanchored');
  return {
    cycle: reanchored.cycle,
    refrozePlanFields,
    reminderEventsReset: reanchored.reminderEventsReset,
  };
}
