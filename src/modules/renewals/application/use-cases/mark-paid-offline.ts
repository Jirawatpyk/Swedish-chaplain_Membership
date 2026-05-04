/**
 * F8 Phase 3 Wave H2 · T059 — `mark-paid-offline` use-case.
 *
 * Admin records an out-of-band payment for a renewal cycle. F4 invoice
 * is created, issued, and immediately marked paid in **one outer
 * runInTenant tx** — the F4 `recordPayment` reuses our outer tx via
 * `externalTx` threading + `onPaidCallback` flips the cycle to
 * `completed` inside the same atomic boundary (Constitution Principle
 * VIII / research.md R12 Option A).
 *
 * Concurrency guard:
 *   `pg_advisory_xact_lock(hashtextextended('renewals:'||tenantId||':'||cycleId, 0))`
 *   per (tenant, cycle) — namespace `renewals:` is disjoint from F4
 *   `invoicing:` and F5 `payments:`. Auto-released at tx end. Prevents
 *   double-mark-paid races between two concurrent admin clicks.
 *
 * State precondition: cycle must be in `awaiting_payment | upcoming |
 * grace`. Other states yield `cycle_not_payable`.
 *
 * Audit emits inside tx (atomic state+audit):
 *   - `renewal_cycle_completed_offline` (in pgEnum — H1 real adapter
 *     persists to audit_log).
 *   - `renewal_invoice_created` + `renewal_completed` are NOT yet in
 *     pgEnum; the H1 emitter logs to pino via stub fallback in dev,
 *     loud-fails in production. Their pgEnum migration ships in
 *     Phase 4 alongside the dispatcher cron emit sites.
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
import type { F4InvoicePaidEvent } from '@/modules/invoicing';

export const markPaidOfflineInputSchema = z.object({
  tenantId: z.string().min(1),
  cycleId: z.string().uuid(),
  paymentMethod: z.enum(['bank_transfer', 'cash', 'cheque']),
  paymentReference: z.string().min(1).max(100),
  paymentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  actorUserId: z.string().min(1),
  actorRole: z.enum(['admin']),
  requestId: z.string().nullable().optional(),
  correlationId: z.string().min(1),
});

export type MarkPaidOfflineInput = z.infer<typeof markPaidOfflineInputSchema>;

export interface MarkPaidOfflineOutput {
  readonly cycleStatus: 'completed';
  readonly invoiceId: string;
  readonly newExpiresAt: string;
}

export type MarkPaidOfflineError =
  | { readonly kind: 'invalid_input'; readonly message: string }
  | { readonly kind: 'cycle_not_found' }
  | { readonly kind: 'cycle_not_payable'; readonly currentStatus: string }
  | { readonly kind: 'f4_failure'; readonly stage: string; readonly reason: string };

const PAYABLE_STATUSES = new Set([
  'awaiting_payment',
  'upcoming',
  // grace cycles are post-T-0 but pre-lapse — admin can still mark paid
  // to bring the member back without admin reactivation flow.
]);

/**
 * Compute the next cycle's expires_at by adding `frozenPlanTermMonths`
 * to the current `period_to`. Bangkok-local arithmetic — F8 stores all
 * timestamps in UTC but the calendar boundary is Bangkok. For the
 * MVP we add months naively in UTC; the dispatcher-cron in Phase 4
 * will refine with js-joda Asia/Bangkok if needed.
 */
function deriveNewExpiresAt(currentPeriodToIso: string, termMonths: number): string {
  const d = new Date(currentPeriodToIso);
  d.setUTCMonth(d.getUTCMonth() + termMonths);
  return d.toISOString();
}

export async function markPaidOffline(
  deps: RenewalsDeps,
  rawInput: MarkPaidOfflineInput,
): Promise<Result<MarkPaidOfflineOutput, MarkPaidOfflineError>> {
  const parsed = markPaidOfflineInputSchema.safeParse(rawInput);
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

  // Pre-load cycle to surface clean errors before opening the F4 chain.
  const preLoad = await deps.cyclesRepo.findById(input.tenantId, cycleId);
  if (!preLoad) {
    await deps.auditEmitter.emit(
      {
        type: 'renewal_cross_tenant_probe',
        payload: {
          attempted_cycle_id: cycleId,
          route: 'mark-paid-offline',
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
    return err({ kind: 'cycle_not_found' });
  }
  if (!PAYABLE_STATUSES.has(preLoad.status)) {
    return err({
      kind: 'cycle_not_payable',
      currentStatus: preLoad.status,
    });
  }

  // Derive plan_year from cycle.periodFrom (the year the cycle was priced
  // against). Bangkok-local year boundary — UTC year is good enough for
  // SweCham (no plan-year boundary spans midnight Bangkok-time).
  //
  // FR-021a frozen-price assumption (verify-run C1):
  //   F4 createInvoiceDraft fetches the plan's annual fee for `planYear`
  //   from F2 — NOT from `cycle.frozen_plan_price_thb`. We rely on the
  //   project invariant "F2 plan-year fees are immutable once issued
  //   invoices reference them" (enforced by F2 plans `editable_until`
  //   guard). If a tenant ever reprices a plan-year mid-cycle, the
  //   issued offline-mark invoice would carry the new price + drift
  //   from `cycle.frozen_plan_price_thb`. Acceptable for MVP because
  //   (a) SweCham operates with stable annual fees and (b) the
  //   integration test at T077 will cross-check `invoice.total ===
  //   cycle.frozen_plan_price_thb` to fail loud on drift. A stricter
  //   "frozen price override" surface on F4 createInvoiceDraft is
  //   tracked for Phase 4+ if the assumption ever breaks in production.
  const planYear = new Date(preLoad.periodFrom).getUTCFullYear();
  const planId = preLoad.planIdAtCycleStart;
  const memberId = preLoad.memberId;
  const newExpiresAt = deriveNewExpiresAt(
    preLoad.periodTo,
    preLoad.frozenPlanTermMonths,
  );

  // Outer atomic boundary — F4 chain step 3 (recordPayment) reuses
  // this tx; cycle flip + audit emit ride along.
  try {
    return await runInTenant(deps.tenant, async (tx) => {
      // Per-(tenant, cycle) advisory lock — race-protects two admins.
      // Lock acquisition delegated to Infrastructure (Constitution
      // Principle III — Application has no SQL/ORM dependency).
      await deps.cyclesRepo.acquireCycleLockInTx(tx, input.tenantId, cycleId);

      // Re-load inside lock to defeat TOCTOU.
      const lockedCycle = await deps.cyclesRepo.findById(
        input.tenantId,
        cycleId,
      );
      if (!lockedCycle) {
        return err({ kind: 'cycle_not_found' as const });
      }
      if (!PAYABLE_STATUSES.has(lockedCycle.status)) {
        return err({
          kind: 'cycle_not_payable' as const,
          currentStatus: lockedCycle.status,
        });
      }

      // F4 chain — bridge composes createInvoiceDraft + issueInvoice +
      // recordPayment(externalTx=tx). The `onPaid` callback fires inside
      // F4's recordPayment tx (which IS our outer tx via externalTx),
      // flipping the cycle atomically.
      let invoiceIdCaptured: string | null = null;
      let paidAtCaptured: string | null = null;
      const onPaid = async (evt: F4InvoicePaidEvent): Promise<void> => {
        invoiceIdCaptured = evt.invoiceId;
        paidAtCaptured = evt.paidAt;
        // Flip cycle inside same tx — closedReason='completed_offline'.
        await deps.cyclesRepo.transitionStatus(
          tx,
          input.tenantId,
          cycleId,
          {
            from: lockedCycle.status,
            to: 'completed',
            closedAt: evt.paidAt,
            closedReason: 'completed_offline',
            linkedInvoiceId: evt.invoiceId,
          },
        );
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'renewal_cycle_completed_offline',
            payload: {
              cycle_id: cycleId,
              member_id: memberId,
              invoice_id: evt.invoiceId,
              payment_method: input.paymentMethod,
              payment_reference: input.paymentReference,
              payment_date: input.paymentDate,
              new_expires_at: newExpiresAt,
            },
          },
          {
            tenantId: input.tenantId,
            actorUserId: input.actorUserId,
            actorRole: input.actorRole,
            correlationId: input.correlationId,
            requestId: input.requestId ?? null,
            summary: `Admin marked cycle ${cycleId} paid offline (${input.paymentMethod} ref=${input.paymentReference})`,
          },
        );
      };

      const bridgeResult = await deps.f4InvoiceBridge.issueAndMarkPaid({
        tenantId: input.tenantId,
        memberId,
        planId,
        planYear,
        paymentMethod: input.paymentMethod,
        paymentReference: input.paymentReference,
        paymentDate: input.paymentDate,
        actorUserId: input.actorUserId,
        externalTx: tx,
        onPaid,
        requestId: input.requestId ?? null,
      });

      if (!bridgeResult.ok) {
        return err({
          kind: 'f4_failure' as const,
          stage: bridgeResult.error.kind,
          reason: bridgeResult.error.reason,
        });
      }

      // Sanity check — onPaid must have run if the bridge returned ok.
      if (!invoiceIdCaptured || !paidAtCaptured) {
        // Should be unreachable — bridge ok implies recordPayment ok
        // implies onPaid fired. If it doesn't, the cycle wasn't
        // flipped + the audit didn't emit — fail loud.
        throw new Error(
          'mark-paid-offline: bridge reported ok but onPaid did not capture invoiceId/paidAt',
        );
      }

      return ok({
        cycleStatus: 'completed' as const,
        invoiceId: bridgeResult.value.invoiceId,
        newExpiresAt,
      });
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        cycleId,
        tenantId: input.tenantId,
      },
      'markPaidOffline: unexpected error',
    );
    throw e;
  }
}
