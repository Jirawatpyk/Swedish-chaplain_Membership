/**
 * F8 Phase 5 Wave B · T123 — `markCycleCompleteFromInvoicePaid`.
 *
 * F4 `onPaidCallback` target. Fires once F4 transitions an invoice
 * from `issued → paid`. Resolves the linked F8 renewal cycle and
 * transitions it per FR-023 + FR-005b:
 *
 *   - Default: cycle.awaiting_payment → completed
 *     (emits `renewal_completed`)
 *   - Member has `blocked_from_auto_reactivation = TRUE`:
 *     cycle.awaiting_payment → pending_admin_reactivation
 *     (emits `renewal_completed_post_lapse`; cycle holds for admin
 *     review per T136/T137/T138)
 *
 * Atomicity caveat (research.md R12 / Constitution Principle VIII):
 *   F4's `F4InvoicePaidEvent` carries no `tx` handle, so this
 *   callback opens its own `runInTenant` tx that COMMITS SEPARATELY
 *   from F4's invoice-flip tx. There is a brief eventual-consistency
 *   window between "F4 marks invoice paid" and "F8 cycle updated"
 *   visible to concurrent readers. The window is bounded by:
 *     - This use-case's runtime (~5-50ms typical)
 *     - F4's `recordPayment` not throwing back through
 *       `onPaidCallback` rejections (it does — see F4InvoicePaidEvent
 *       docstring lines 14-18; an F8 throw rolls F4's tx back)
 *
 *   So the actual semantics are: F4 commit observes F8 commit ON
 *   SUCCESS (because F8 throw → F4 rollback), and an F8 success
 *   guarantees both rows commit. The "eventual consistency" risk is
 *   only on the FAILURE path (F8 throws → F4 rolls back → F8 already
 *   committed), which we MUST avoid by NEVER throwing from the
 *   callback after F8 has committed. The use-case implements this
 *   discipline: all F8 work runs inside ONE `runInTenant`; if it
 *   commits, no further code can throw.
 *
 *   A future F4 API change to thread `tx` into the callback would
 *   collapse this into a single tx — tracked as an enhancement.
 *
 * Cycle resolution: `cyclesRepo.findByInvoiceIdInTx` returns null when
 * the invoice is not F8-managed (e.g., ad-hoc admin invoice unrelated
 * to a renewal). Use-case logs + returns `'no_cycle_for_invoice'`
 * (NOT an error — F4 has many invoice types).
 *
 * Idempotency: re-firing the callback with the same event must be a
 * no-op. The cycle status check (`awaiting_payment` only) provides
 * this — a second callback finds the cycle in `completed` and short-
 * circuits.
 *
 * Out of scope (deferred to follow-on):
 *   - Cancelling remaining `renewal_reminder_events` rows (FR-023)
 *   - Dispatching the welcome email (FR-023)
 *   - Advancing `members.expires_at` (R3) + creating next cycle
 *
 * These need additional repo methods + gateway access; tracked via
 * tasks.md T123 follow-up sub-bullets.
 */
import { ok, type Result } from '@/lib/result';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { F4InvoicePaidEvent } from '@/modules/invoicing';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';
import {
  asCycleId,
  type RenewalCycle,
} from '../../domain/renewal-cycle';
import {
  CycleNotFoundError,
  CycleTransitionConflictError,
} from '../ports/renewal-cycle-repo';

export type MarkCycleCompleteOutcome =
  | { readonly kind: 'no_cycle_for_invoice' }
  | { readonly kind: 'cycle_not_payable'; readonly currentStatus: string }
  | {
      readonly kind: 'completed';
      readonly cycleId: string;
      readonly memberId: string;
    }
  | {
      readonly kind: 'held_pending_admin';
      readonly cycleId: string;
      readonly memberId: string;
    };

export type MarkCycleCompleteDeps = Pick<
  RenewalsDeps,
  'tenant' | 'cyclesRepo' | 'auditEmitter' | 'memberRenewalFlagsRepo'
>;

/**
 * Result is always `ok(...)`. Domain failures (no cycle / non-payable
 * status) are non-throws because F4 has paid the invoice — the cycle
 * is just not F8-managed or already settled. F4 must NOT roll back on
 * those, so we return success-with-explanation rather than err.
 *
 * Genuine infra throws (DB connection lost) propagate up to F4's tx
 * which rolls back the invoice flip — atomic-failure invariant.
 *
 * I3 review-fix (Phase 5 backlog close): when the F4 onPaidCallback
 * threads its own tx via the new `(evt, tx?)` callback signature,
 * F8 reuses it instead of opening a separate `runInTenant`. This
 * collapses the two-tx eventual-consistency window — F4 commit + F8
 * commit are now ONE atomic operation. The legacy `existingTx`-omitted
 * path is preserved for callers that don't (yet) thread the tx so the
 * change is fully backward-compatible.
 */
export async function markCycleCompleteFromInvoicePaid(
  deps: MarkCycleCompleteDeps,
  event: F4InvoicePaidEvent,
  existingTx?: TenantTx,
): Promise<Result<MarkCycleCompleteOutcome, never>> {
  const body = async (tx: TenantTx): Promise<Result<MarkCycleCompleteOutcome, never>> => {
    const cycle = await deps.cyclesRepo.findByInvoiceIdInTx(
      tx,
      event.tenantId,
      event.invoiceId,
    );
    if (!cycle) {
      logger.info(
        { invoiceId: event.invoiceId, tenantId: event.tenantId },
        '[mark-cycle-complete] no F8 cycle for invoice — non-renewal payment',
      );
      return ok({ kind: 'no_cycle_for_invoice' as const });
    }

    if (cycle.status !== 'awaiting_payment') {
      logger.warn(
        {
          cycleId: cycle.cycleId,
          currentStatus: cycle.status,
          invoiceId: event.invoiceId,
        },
        '[mark-cycle-complete] cycle not in awaiting_payment — skip (idempotent re-fire or out-of-band transition)',
      );
      return ok({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }

    // FR-005b branch — read admin override flag.
    const blocked =
      await deps.memberRenewalFlagsRepo.readBlockedFromAutoReactivation(
        tx,
        event.tenantId,
        cycle.memberId,
      );

    const closedAt = event.paidAt;
    if (blocked === true) {
      // Hold for admin review — NOT a terminal state. cycle moves to
      // pending_admin_reactivation; T136 / T137 / T138 govern exit.
      return holdForAdminReview(deps, tx, cycle, event, closedAt);
    }

    // Default auto-complete branch.
    return autoComplete(deps, tx, cycle, event, closedAt);
  };
  // I3 review-fix: reuse caller's tx when threaded via the F4
  // onPaidCallback's new `(evt, tx)` signature; otherwise fall back
  // to opening our own runInTenant for legacy callers.
  if (existingTx !== undefined) {
    return body(existingTx);
  }
  return runInTenant(deps.tenant, body);
}

async function autoComplete(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<Result<MarkCycleCompleteOutcome, never>> {
  const cycleId = asCycleId(cycle.cycleId);
  let updated: RenewalCycle;
  try {
    updated = await deps.cyclesRepo.transitionStatus(
      tx,
      event.tenantId,
      cycleId,
      {
        from: 'awaiting_payment',
        to: 'completed',
        closedAt,
        closedReason: 'paid',
        linkedInvoiceId: event.invoiceId,
      },
    );
  } catch (e) {
    if (
      e instanceof CycleTransitionConflictError ||
      e instanceof CycleNotFoundError
    ) {
      // Race against an admin manual transition. Idempotent skip — the
      // cycle is already settled; F4's invoice-paid stands.
      logger.warn(
        { cycleId, err: e.message },
        '[mark-cycle-complete] auto-complete lost race — idempotent skip',
      );
      return ok({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed' as const,
      payload: {
        cycle_id: updated.cycleId,
        member_id: cycle.memberId,
        invoice_id: event.invoiceId,
        paid_at: event.paidAt,
        amount_satang: event.amountSatang.toString(),
        payment_method: event.paymentMethod,
      },
    },
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'system',
      correlationId: `f4-paid:${event.invoiceId}`,
    },
  );

  return ok({
    kind: 'completed' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  });
}

async function holdForAdminReview(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<Result<MarkCycleCompleteOutcome, never>> {
  const cycleId = asCycleId(cycle.cycleId);
  try {
    await deps.cyclesRepo.transitionStatus(
      tx,
      event.tenantId,
      cycleId,
      {
        from: 'awaiting_payment',
        to: 'pending_admin_reactivation',
        enteredPendingAt: closedAt,
        linkedInvoiceId: event.invoiceId,
      },
    );
  } catch (e) {
    if (
      e instanceof CycleTransitionConflictError ||
      e instanceof CycleNotFoundError
    ) {
      logger.warn(
        { cycleId, err: e.message },
        '[mark-cycle-complete] hold-for-admin lost race — idempotent skip',
      );
      return ok({
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      });
    }
    throw e;
  }

  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_completed_post_lapse' as const,
      payload: {
        cycle_id: cycle.cycleId,
        member_id: cycle.memberId,
        invoice_id: event.invoiceId,
        held_for_admin_review: true,
      },
    },
    {
      tenantId: event.tenantId,
      actorUserId: null,
      actorRole: 'system',
      correlationId: `f4-paid:${event.invoiceId}`,
    },
  );

  return ok({
    kind: 'held_pending_admin' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  });
}
