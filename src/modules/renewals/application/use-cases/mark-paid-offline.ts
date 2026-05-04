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
 * State precondition: cycle status must be `upcoming` or
 * `awaiting_payment`. (Grace is an urgency-bucket overlay on
 * `awaiting_payment`, not a separate status — see PAYABLE_STATUSES
 * note below.) Other statuses yield `cycle_not_payable`.
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
  | { readonly kind: 'f4_failure'; readonly stage: string; readonly reason: string }
  /**
   * F4 step 3 (recordPayment) failed AFTER an invoice was issued with
   * a consumed §87 sequence number. The orphan invoice exists in F4 in
   * 'issued' state. Admin MUST resume from the F4 invoice list and mark
   * paid there — DO NOT retry mark-paid-offline (it will issue a
   * duplicate §87 invoice).
   */
  | {
      readonly kind: 'f4_orphan_invoice';
      readonly orphanInvoiceId: string;
      readonly reason: string;
    };

// Cycles in these statuses can be marked paid offline. Lapsed cycles
// require the explicit reactivation flow (US3+); cancelled and completed
// cycles are terminal. `pending_admin_reactivation` is in the admin's
// review queue — not the offline-mark path.
//
// Note: there is no separate `grace` status in the 7-state machine —
// grace is an URGENCY bucket (post-expiry, pre-lapse) that overlays
// `awaiting_payment` cycles whose expires_at is in the past but within
// the tenant's grace_period_days. Admins marking those paid use the
// same `awaiting_payment` codepath; the urgency derivation is read-only.
const PAYABLE_STATUSES = new Set(['awaiting_payment', 'upcoming']);

/**
 * Compute the next cycle's expires_at by adding `frozenPlanTermMonths`
 * to the current `period_to`. Direct UTC arithmetic is correct here
 * because Asia/Bangkok is UTC+7 with no DST transitions: a
 * `setUTCMonth(+N)` produces a UTC instant that lands at the same
 * Bangkok calendar date for every supported plan term (1–60 months).
 * No js-joda needed.
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
    // Probe audit defence-in-depth — never block the 404 (see EH4).
    try {
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
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e.message : String(e),
          cycleId,
          correlationId: input.correlationId,
        },
        'markPaidOffline: probe audit emit failed (swallowed — never blocks 404)',
      );
    }
    return err({ kind: 'cycle_not_found' });
  }
  if (!PAYABLE_STATUSES.has(preLoad.status)) {
    return err({
      kind: 'cycle_not_payable',
      currentStatus: preLoad.status,
    });
  }

  // FR-021a frozen-price invariant: F4 `createInvoiceDraft` fetches
  // the plan-year fee from F2 (NOT from `cycle.frozen_plan_price_thb`).
  // This relies on F2's plan-year immutability rule — once any issued
  // invoice references a plan-year, F2's `editable_until` guard freezes
  // the fee. The cycle-vs-invoice price drift assertion lives in the
  // integration test for offline mark-paid; a runtime mismatch would
  // surface there before reaching production.
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
      let onPaidFired = false;
      const onPaid = async (evt: F4InvoicePaidEvent): Promise<void> => {
        onPaidFired = true;
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
        // Distinct error code on the orphan-invoice path so the route
        // handler can surface "DO NOT retry — resume from F4 list".
        if (bridgeResult.error.kind === 'record_payment_failed') {
          return err({
            kind: 'f4_orphan_invoice' as const,
            orphanInvoiceId: bridgeResult.error.orphanInvoiceId,
            reason: bridgeResult.error.reason,
          });
        }
        return err({
          kind: 'f4_failure' as const,
          stage: bridgeResult.error.kind,
          reason: bridgeResult.error.reason,
        });
      }

      // Cross-module invariant guard: the F4 bridge MUST fire onPaid
      // inside recordPayment's tx (which IS our outer tx). If a future
      // F4 refactor decouples bridge.ok from onPaid invocation (e.g.
      // a "skip if already paid" optimisation), the cycle would NOT be
      // flipped while the response says completed — silent member-
      // state desync. Throw so the outer runInTenant rolls back +
      // surfaces the inconsistency loudly with cycle context.
      if (!onPaidFired) {
        throw new Error(
          `mark-paid-offline: F4 bridge returned ok but onPaid never fired — ` +
            `cycle ${cycleId} not flipped. F4 contract regression?`,
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
