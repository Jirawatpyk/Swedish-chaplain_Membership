/**
 * `endMembershipCoverageNow` + `reconcileMembershipCoverageEnds` — the ONE
 * "end this member's coverage now" operation, shared by the full manual
 * credit-note path (`POST /api/credit-notes`) and the full refund path
 * (`POST /api/refunds/initiate`). Both ROUTES orchestrate it after their own
 * money work commits; F4/F5 Application never import F8 (Principle III).
 *
 * WHY a new operation (migration 0305): the member's access is derived from
 * their LATEST cycle (`deriveMembershipAccess`). Paying a renewal bill moves
 * its cycle `awaiting_payment → completed` — terminal, so `cancel-cycle`
 * refuses it — and opens the NEXT cycle at the old period end. A plain
 * `cancelled` close honours paid-through access until `expires_at`, so
 * cancelling that next cycle (the old F-2 `cancelInFlightCyclesForMember`
 * cascade, or "cancel it in Renewals") left a refunded member Active for the
 * whole refunded period. This operation closes the member's OPEN cycle as
 * `cancelled` / `coverage_ended`, which the access rule treats as ended NOW.
 *
 * WHEN (async refunds): coverage ends at SETTLEMENT, never at submit. A
 * refund-backed call whose refund is still settling (`awaitRefund`) only
 * stamps a durable request on the open cycle; the nightly
 * `reconcileMembershipCoverageEnds` ends coverage once the F5 refund settles
 * `succeeded`, and CLEARS the request when it settles `failed` (no money came
 * back, so the member keeps what they paid for). Mirrors the F8-RP async
 * reject-with-refund precedent, which also converges only on settlement.
 *
 * DURABILITY: if the inline end fails after the credit note / refund has
 * committed, a plain request is stamped instead (`deferred`) and the nightly
 * pass retries it — staff never have to redo it by hand.
 *
 * Concurrency: per-(tenant, cycle) advisory lock (same namespace as
 * cancel-cycle / mark-paid-offline) + re-read inside the lock + the repo's
 * `WHERE status = from` CAS. A cycle that closed in the race is `no_open_cycle`.
 *
 * Audit: the existing `renewal_cycle_cancelled` event (no new enum value),
 * `payload.reason = 'coverage_ended:<trigger>'`, atomic with the transition.
 *
 * Pure Application — port interfaces only.
 */
import { err, ok, type Result } from '@/lib/result';
import { runInTenant, type TenantTx } from '@/lib/db';
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import type { TenantId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';
import type { CycleId } from '../../domain/renewal-cycle';
import { isTerminalCycleStatus } from '../../domain/value-objects/cycle-status';
import type { RenewalActorRole } from '../ports/renewal-audit-emitter';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export type EndMembershipCoverageDeps = Pick<
  RenewalsDeps,
  'cyclesRepo' | 'auditEmitter' | 'clock' | 'coverageEndRequests' | 'f5RefundBridge'
>;

/** What returned (or will return) the period's money. */
export type CoverageEndTrigger = 'credit_note' | 'refund';

export interface EndMembershipCoverageNowInput {
  readonly tenant: TenantContext;
  readonly memberId: MemberId;
  readonly trigger: CoverageEndTrigger;
  /**
   * Set when the refund is still settling: coverage must NOT end until it
   * settles `succeeded`. Only a request is stamped now.
   */
  readonly awaitRefund?: { readonly refundId: string; readonly invoiceId: string };
  /** The staff member who chose to end the membership. */
  readonly initiatedByUserId: string | null;
  /** Their LITERAL role for the audit row; null when unknown (never guessed). */
  readonly initiatedByRole?: 'admin' | 'super_admin';
  readonly requestId: string | null;
  /** `credit-note:{id}` / `refund:{id}` — the forensic chain. */
  readonly correlationId: string;
}

export type EndMembershipCoverageNowOutput =
  /** Access ended now (`cancelled` / `coverage_ended`). */
  | { readonly outcome: 'ended'; readonly cycleId: CycleId }
  /** Refund still settling — ends when it settles `succeeded`. */
  | { readonly outcome: 'scheduled'; readonly cycleId: CycleId }
  /** The inline end failed; the nightly pass retries it. */
  | { readonly outcome: 'deferred'; readonly cycleId: CycleId }
  /** The member has no open cycle to end (or it closed in the race). */
  | { readonly outcome: 'no_open_cycle' };

export type EndMembershipCoverageError = {
  readonly kind: 'coverage_end.server_error';
  readonly errName: string;
};

function errName(e: unknown): string {
  return e instanceof Error ? e.name : 'UnknownError';
}

/**
 * The shared in-tx core. Locks + re-reads the cycle; `false` when it is no
 * longer open. Closes it `cancelled` / `coverage_ended` + audits atomically.
 */
async function endOpenCycleInTx(
  deps: EndMembershipCoverageDeps,
  tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly cycleId: CycleId;
    readonly memberId: string;
    /** `retry` = a plain request re-run by the nightly pass. */
    readonly trigger: CoverageEndTrigger | 'retry';
    readonly actorUserId: string | null;
    readonly actorRole: RenewalActorRole;
    readonly requestId: string | null;
    readonly correlationId: string;
  },
): Promise<boolean> {
  await deps.cyclesRepo.acquireCycleLockInTx(tx, args.tenantId, args.cycleId);
  const locked = await deps.cyclesRepo.findByIdInTx(tx, args.tenantId, args.cycleId);
  if (!locked || isTerminalCycleStatus(locked.status)) return false;

  await deps.cyclesRepo.transitionStatus(tx, args.tenantId, args.cycleId, {
    from: locked.status,
    to: 'cancelled',
    closedAt: deps.clock.now().toISOString(),
    closedReason: 'coverage_ended',
  });
  await deps.auditEmitter.emitInTx(
    tx,
    {
      type: 'renewal_cycle_cancelled',
      payload: {
        cycle_id: args.cycleId,
        member_id: args.memberId as MemberId,
        reason: `coverage_ended:${args.trigger}`,
        previous_status: locked.status,
      },
    },
    {
      tenantId: args.tenantId,
      actorUserId: args.actorUserId,
      actorRole: args.actorRole,
      correlationId: args.correlationId,
      requestId: args.requestId,
      summary: `Renewal cycle ${args.cycleId} cancelled — membership coverage ended (${args.trigger})`,
    },
  );
  return true;
}

export async function endMembershipCoverageNow(
  deps: EndMembershipCoverageDeps,
  input: EndMembershipCoverageNowInput,
): Promise<Result<EndMembershipCoverageNowOutput, EndMembershipCoverageError>> {
  const tenantId = input.tenant.slug;
  const memberId = input.memberId as string;
  let cycleId: CycleId;
  try {
    const open = await deps.cyclesRepo.findActiveForMember(tenantId, memberId);
    if (!open || isTerminalCycleStatus(open.status)) {
      return ok({ outcome: 'no_open_cycle' });
    }
    cycleId = open.cycleId;
  } catch (e) {
    logger.error(
      { errName: errName(e), tenantId, memberId },
      'renewals.coverage_end.lookup_failed',
    );
    return err({ kind: 'coverage_end.server_error', errName: errName(e) });
  }

  // Refund still settling → stamp the request only. Coverage ends at
  // settlement (nightly reconcile), never before the money is back.
  if (input.awaitRefund) {
    const awaitRefund = input.awaitRefund;
    try {
      const stamped = await runInTenant(input.tenant, async (tx) => {
        await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, cycleId);
        return deps.coverageEndRequests.stampInTx(tx, tenantId, cycleId, {
          requestedAt: deps.clock.now().toISOString(),
          refundId: awaitRefund.refundId,
          invoiceId: awaitRefund.invoiceId,
          actorUserId: input.initiatedByUserId,
        });
      });
      return ok(stamped ? { outcome: 'scheduled', cycleId } : { outcome: 'no_open_cycle' });
    } catch (e) {
      logger.error(
        { errName: errName(e), tenantId, memberId, cycleId, refundId: awaitRefund.refundId },
        'renewals.coverage_end.schedule_failed',
      );
      return err({ kind: 'coverage_end.server_error', errName: errName(e) });
    }
  }

  try {
    const ended = await runInTenant(input.tenant, (tx) =>
      endOpenCycleInTx(deps, tx, {
        tenantId,
        cycleId,
        memberId,
        trigger: input.trigger,
        actorUserId: input.initiatedByUserId,
        // Audit truth: the literal role, never a guessed 'admin'.
        actorRole: input.initiatedByRole ?? 'system',
        requestId: input.requestId,
        correlationId: input.correlationId,
      }),
    );
    return ok(ended ? { outcome: 'ended', cycleId } : { outcome: 'no_open_cycle' });
  } catch (e) {
    // The money side has already committed. Leave a plain request so the
    // nightly pass retries the end — never silently drop the staff decision.
    logger.error(
      { errName: errName(e), tenantId, memberId, cycleId, trigger: input.trigger },
      'renewals.coverage_end.inline_end_failed',
    );
    try {
      const stamped = await runInTenant(input.tenant, (tx) =>
        deps.coverageEndRequests.stampInTx(tx, tenantId, cycleId, {
          requestedAt: deps.clock.now().toISOString(),
          refundId: null,
          invoiceId: null,
          actorUserId: input.initiatedByUserId,
        }),
      );
      if (stamped) return ok({ outcome: 'deferred', cycleId });
    } catch (stampErr) {
      logger.error(
        { errName: errName(stampErr), tenantId, memberId, cycleId },
        'renewals.coverage_end.retry_stamp_failed',
      );
    }
    return err({ kind: 'coverage_end.server_error', errName: errName(e) });
  }
}

export interface ReconcileMembershipCoverageEndsInput {
  readonly tenant: TenantContext;
  /** Max requests per pass (default 200). */
  readonly limit?: number;
}

export interface ReconcileMembershipCoverageEndsOutput {
  readonly ended: number;
  /** Refund settled `failed` — request cleared, member keeps coverage. */
  readonly abandonedRefundFailed: number;
  /** Refund still settling, or its lookup failed — retried next pass. */
  readonly waiting: number;
  readonly errored: number;
}

/**
 * Nightly convergence of pending requests (wired into the per-tenant
 * reconcile-pending-reactivations cron). Per request:
 *   - plain (no refund) ............ end now (a retry of a failed inline end)
 *   - refund settled `succeeded` ... end now
 *   - refund settled `failed` ...... clear the request (CAS on the refund id)
 *   - pending / not_found / lookup_failed ... leave for the next pass
 * One request's failure never stops the pass.
 */
export async function reconcileMembershipCoverageEnds(
  deps: EndMembershipCoverageDeps,
  input: ReconcileMembershipCoverageEndsInput,
): Promise<Result<ReconcileMembershipCoverageEndsOutput, EndMembershipCoverageError>> {
  const tenantId = input.tenant.slug;
  let requests;
  try {
    requests = await deps.coverageEndRequests.listPending(tenantId, input.limit ?? 200);
  } catch (e) {
    logger.error({ errName: errName(e), tenantId }, 'renewals.coverage_end.reconcile_list_failed');
    return err({ kind: 'coverage_end.server_error', errName: errName(e) });
  }

  let ended = 0;
  let abandonedRefundFailed = 0;
  let waiting = 0;
  let errored = 0;

  for (const req of requests) {
    try {
      if (req.refundId !== null && req.invoiceId !== null) {
        const settlement = await deps.f5RefundBridge.getRefundOutcomeForInvoice({
          tenantId: tenantId as TenantId,
          invoiceId: req.invoiceId as InvoiceId,
          refundId: req.refundId,
        });
        if (settlement.status === 'failed') {
          const refundId = req.refundId;
          await runInTenant(input.tenant, (tx) =>
            deps.coverageEndRequests.clearInTx(tx, tenantId, req.cycleId, refundId),
          );
          abandonedRefundFailed += 1;
          logger.warn(
            {
              tenantId,
              cycleId: req.cycleId,
              refundId,
              failureReasonCode: settlement.failureReasonCode,
            },
            'renewals.coverage_end.refund_failed_membership_kept',
          );
          continue;
        }
        if (settlement.status !== 'succeeded') {
          waiting += 1;
          continue;
        }
      }
      const didEnd = await runInTenant(input.tenant, (tx) =>
        endOpenCycleInTx(deps, tx, {
          tenantId,
          cycleId: req.cycleId,
          memberId: req.memberId,
          trigger: req.refundId !== null ? 'refund' : 'retry',
          // The cron performs the transition; the requesting staff member is
          // on the F5 refund / F4 credit-note trail.
          actorUserId: null,
          actorRole: 'cron',
          requestId: null,
          correlationId:
            req.refundId !== null ? `refund:${req.refundId}` : `coverage-end-retry:${req.cycleId}`,
        }),
      );
      if (didEnd) ended += 1;
    } catch (e) {
      errored += 1;
      logger.error(
        { errName: errName(e), tenantId, cycleId: req.cycleId },
        'renewals.coverage_end.reconcile_item_failed',
      );
    }
  }

  return ok({ ended, abandonedRefundFailed, waiting, errored });
}
