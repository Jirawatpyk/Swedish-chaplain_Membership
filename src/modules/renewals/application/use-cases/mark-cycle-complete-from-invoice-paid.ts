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
 * Domain failures (no cycle / non-payable status) are non-throws
 * because F4 has paid the invoice — the cycle is just not F8-managed
 * or already settled. F4 must NOT roll back on those, so we return
 * success-with-explanation rather than err.
 *
 * Genuine infra throws (DB connection lost) propagate up to F4's tx
 * which rolls back the invoice flip — atomic-failure invariant.
 *
 * Round 2 review-fix (S-10): the previous return type
 * `Promise<Result<MarkCycleCompleteOutcome, never>>` advertised "this
 * Result branch never happens" which was misleading: the body throws
 * on infra failures (the err channel is in fact never used). Replaced
 * with `Promise<MarkCycleCompleteOutcome>` so the type tells the
 * truth about which mechanism handles which failure mode.
 *
 * Round 2 review-fix (S-11): the function is now split into two
 * variants with one tx-ownership invariant each:
 *   - `markCycleCompleteInTx(deps, event, tx)` — body; requires
 *     caller to provide the tx. Used by the F4 onPaidCallback path
 *     where F4 threads its own tx for atomic single-tx completion.
 *   - `markCycleCompleteFromInvoicePaid(deps, event)` — wrapper that
 *     opens its own `runInTenant` and delegates to the InTx body.
 *     Used by legacy / standalone callers that don't have a tx.
 *
 * I3 review-fix (Phase 5 backlog close): when the F4 onPaidCallback
 * threads its own tx, F8 reuses it via `markCycleCompleteInTx`. This
 * collapses the two-tx eventual-consistency window — F4 commit + F8
 * commit are now ONE atomic operation.
 */
export async function markCycleCompleteInTx(
  deps: MarkCycleCompleteDeps,
  event: F4InvoicePaidEvent,
  tx: TenantTx,
): Promise<MarkCycleCompleteOutcome> {
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
    return { kind: 'no_cycle_for_invoice' as const };
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
    return {
      kind: 'cycle_not_payable' as const,
      currentStatus: cycle.status,
    };
  }

  // FR-005b + COMP-1 — read BOTH reactivation guards in ONE round-trip
  // (COMP-1 L3 fold): the admin `blocked_from_auto_reactivation` override AND
  // the GDPR-erased state. An erased member must never AUTO-reactivate:
  // erasure keeps `status` + forces `blocked_from_auto_reactivation = FALSE`
  // (the 0094 CHECK forbids the flag staying TRUE once its provenance is
  // scrubbed), so the block flag alone no longer fences an erased member.
  // Routing a payment that lands against a GDPR-anonymised tombstone to the
  // admin-hold path surfaces it to an admin instead of silently reactivating
  // it. `null` (member RLS-hidden / absent) → both guards treated as false →
  // auto-complete (defensive — preserves the prior null-read behaviour).
  const guards = await deps.memberRenewalFlagsRepo.readReactivationGuardsInTx(
    tx,
    event.tenantId,
    cycle.memberId,
  );
  const blocked = guards?.blocked === true;
  const isErased = guards?.erased === true;

  const closedAt = event.paidAt;
  if (blocked || isErased) {
    // Hold for admin review — NOT a terminal state. cycle moves to
    // pending_admin_reactivation; T136 / T137 / T138 govern exit.
    return holdForAdminReview(deps, tx, cycle, event, closedAt);
  }

  // Default auto-complete branch.
  return autoComplete(deps, tx, cycle, event, closedAt);
}

/**
 * Standalone wrapper — opens a fresh `runInTenant` and delegates to
 * `markCycleCompleteInTx`. Use when no caller-provided tx is
 * available (legacy paths, standalone admin replays, integration
 * tests). The F4 onPaidCallback path uses `markCycleCompleteInTx`
 * directly to participate in F4's tx for atomic single-tx completion.
 *
 * **R5-S3 / R6-IMP2c usage guidance** (refined): the F4 onPaidCallback
 * path SHOULD use `markCycleCompleteInTx(deps, event, tx)` with the
 * caller-provided F4 tx for atomic single-tx completion. The
 * composition root at
 * `src/modules/renewals/infrastructure/renewals-deps.ts:472-510`
 * already implements this discipline: when F4 threads a `TenantTx`
 * value, the in-tx variant is invoked; otherwise this wrapper is
 * invoked as a **degraded-mode fallback** with the alert metric
 * `onPaidInvalidTx{tenant_id}` paging on-call so the F4 contract
 * drift surfaces.
 *
 * Direct callers OUTSIDE the composition root MUST use
 * `markCycleCompleteInTx` if they have a caller-provided tx.
 * This wrapper is the right choice ONLY for:
 *   - Admin replay tools (no caller tx by definition)
 *   - Integration tests that exercise the wrapper specifically
 *   - The composition-root degraded-mode fallback above
 *
 * The wrapper's separate-tx semantics mean: if F4 has already
 * committed the invoice flip then this wrapper throws, F4's invoice
 * stays 'paid' but F8's cycle stays in 'awaiting_payment'. That
 * state↔audit drift is what the `onPaidInvalidTx` alert exists to
 * detect — a non-zero rate on the counter means the F4 contract is
 * threading something that isn't a `TenantTx`, which the SRE
 * runbook documents as needing F4-side investigation.
 */
export async function markCycleCompleteFromInvoicePaid(
  deps: MarkCycleCompleteDeps,
  event: F4InvoicePaidEvent,
): Promise<MarkCycleCompleteOutcome> {
  return runInTenant(deps.tenant, (tx) => markCycleCompleteInTx(deps, event, tx));
}

async function autoComplete(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<MarkCycleCompleteOutcome> {
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
      return {
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      };
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

  return {
    kind: 'completed' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  };
}

async function holdForAdminReview(
  deps: MarkCycleCompleteDeps,
  tx: TenantTx,
  cycle: RenewalCycle,
  event: F4InvoicePaidEvent,
  closedAt: string,
): Promise<MarkCycleCompleteOutcome> {
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
      return {
        kind: 'cycle_not_payable' as const,
        currentStatus: cycle.status,
      };
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

  return {
    kind: 'held_pending_admin' as const,
    cycleId: cycle.cycleId,
    memberId: cycle.memberId,
  };
}
