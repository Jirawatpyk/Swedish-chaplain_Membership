/**
 * `endMembershipCoverageNow` + `reconcileMembershipCoverageEnds` — the ONE
 * "end this member's coverage now" operation, shared by the full manual
 * credit-note path (`POST /api/credit-notes`) and the full refund path
 * (`POST /api/refunds/initiate`). Both ROUTES orchestrate it after their own
 * money work commits; F4/F5 Application never import F8 (Principle III).
 *
 * WHY a new operation (migration 0306): the member's access is derived from
 * their LATEST cycle (`deriveMembershipAccess`). Paying a renewal bill moves
 * its cycle `awaiting_payment → completed` — terminal, so `cancel-cycle`
 * refuses it — and opens the NEXT cycle at the old period end. A plain
 * `cancelled` close honours paid-through access until `expires_at`, so
 * cancelling that next cycle (the old F-2 `cancelInFlightCyclesForMember`
 * cascade, or "cancel it in Renewals") left a refunded member Active for the
 * whole refunded period. This operation closes the member's OPEN cycle as
 * `cancelled` / `coverage_ended`, which the access rule treats as ended NOW.
 *
 * WHAT can be ended: an OPEN cycle only (upcoming | reminded |
 * awaiting_payment). Never `pending_admin_reactivation` — its held payment
 * belongs to the reactivation review (approve / reject-with-refund).
 *
 * WHEN (async refunds): coverage ends at SETTLEMENT, never at submit. A
 * refund-backed call whose refund is still settling (`awaitRefund`) only
 * stamps a durable request on the open cycle; the reconcile ends coverage
 * once the F5 refund settles `succeeded`, and CLEARS the request when it
 * settles `failed` (no money came back, so the member keeps what they paid
 * for). Mirrors the F8-RP async reject-with-refund precedent.
 *
 * DURABILITY:
 *   - the inline end failing after the money committed → a plain request is
 *     stamped (`deferred`) and the next reconcile pass retries it;
 *   - the route's call never happening at all (function killed, or the refund
 *     returned `f4_bridge_deferred` after Stripe refunded) → the reconcile's
 *     BACKSTOP re-reads the staff decision from where it was written
 *     atomically with the money (`MembershipEndRequestSource`).
 *
 * Concurrency: per-(tenant, cycle) advisory lock (same namespace as
 * cancel-cycle / mark-paid-offline / cancel-in-flight) + re-read inside the
 * lock + the repo's `WHERE status = from` CAS.
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
import type { MemberId, TenantId } from '@/modules/members';
import type { InvoiceId } from '@/modules/invoicing';
import type { CycleId } from '../../domain/renewal-cycle';
import {
  OPEN_CYCLE_STATUSES,
  type CycleStatus,
} from '../../domain/value-objects/cycle-status';
import type { RenewalActorRole } from '../ports/renewal-audit-emitter';
import type { RenewalsDeps } from '../../infrastructure/renewals-deps';

export type EndMembershipCoverageDeps = Pick<
  RenewalsDeps,
  | 'cyclesRepo'
  | 'auditEmitter'
  | 'clock'
  | 'coverageEndRequests'
  | 'f5RefundBridge'
  | 'membershipEndRequestSource'
>;

/** What returned (or will return) the period's money. */
export type CoverageEndTrigger = 'credit_note' | 'refund';

/** A refund-backed request still unsettled after this long is dropped. */
export const COVERAGE_END_REQUEST_EXPIRY_DAYS = 14;
/**
 * The backstop re-reads staff decisions recorded in the last N days. Kept
 * SHORTER than the expiry so an expired (cleared) request is never
 * re-stamped from its source row.
 */
export const COVERAGE_END_BACKSTOP_WINDOW_DAYS = 7;

const DAY_MS = 24 * 3600 * 1000;

function isOpen(status: CycleStatus): boolean {
  return (OPEN_CYCLE_STATUSES as readonly string[]).includes(status);
}

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
  /** Their LITERAL role for the audit row; `system` when unknown (never guessed). */
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
  /** The inline end failed; the next reconcile pass retries it. */
  | { readonly outcome: 'deferred'; readonly cycleId: CycleId }
  /** The member has no OPEN cycle to end. */
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
 * longer OPEN. Closes it `cancelled` / `coverage_ended` + audits atomically.
 */
async function endOpenCycleInTx(
  deps: EndMembershipCoverageDeps,
  tx: TenantTx,
  args: {
    readonly tenantId: string;
    readonly cycleId: CycleId;
    readonly memberId: string;
    /** `retry` = a plain request re-run by the reconcile. */
    readonly trigger: CoverageEndTrigger | 'retry';
    readonly actorUserId: string | null;
    readonly actorRole: RenewalActorRole;
    readonly requestId: string | null;
    readonly correlationId: string;
  },
): Promise<boolean> {
  await deps.cyclesRepo.acquireCycleLockInTx(tx, args.tenantId, args.cycleId);
  const locked = await deps.cyclesRepo.findByIdInTx(tx, args.tenantId, args.cycleId);
  if (!locked || !isOpen(locked.status)) return false;

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

  // Two attempts: the open cycle read outside the lock can close (and a new
  // one open) before we hold it; one re-lookup covers that race.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let cycleId: CycleId;
    try {
      const open = await deps.cyclesRepo.findActiveForMember(tenantId, memberId);
      if (!open || !isOpen(open.status)) return ok({ outcome: 'no_open_cycle' });
      cycleId = open.cycleId;
    } catch (e) {
      logger.error(
        { errName: errName(e), tenantId, memberId },
        'renewals.coverage_end.lookup_failed',
      );
      return err({ kind: 'coverage_end.server_error', errName: errName(e) });
    }

    // Refund still settling → stamp the request only. Coverage ends at
    // settlement (reconcile), never before the money is back.
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
        if (stamped) return ok({ outcome: 'scheduled', cycleId });
        continue; // closed in the race window (or a plain request is due) — re-look
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
      if (ended) return ok({ outcome: 'ended', cycleId });
      continue; // closed in the race window — re-look once
    } catch (e) {
      // The money side has already committed. Leave a plain request so the
      // reconcile retries the end — never silently drop the staff decision.
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
  return ok({ outcome: 'no_open_cycle' });
}

export interface ReconcileMembershipCoverageEndsInput {
  readonly tenant: TenantContext;
  /** Max requests per pass (default 500). */
  readonly limit?: number;
}

export interface ReconcileMembershipCoverageEndsOutput {
  readonly ended: number;
  /** Refund settled `failed` — request cleared, member keeps coverage. */
  readonly abandonedRefundFailed: number;
  /** Refund still settling — retried next pass. */
  readonly waiting: number;
  /** The refund could not be found / read — retried next pass (alerting if it persists). */
  readonly lookupUnresolved: number;
  /** Unsettled for over COVERAGE_END_REQUEST_EXPIRY_DAYS — cleared (alerting). */
  readonly expired: number;
  /** Requests left on cycles that closed some other way — cleared (alerting). */
  readonly strandedCleared: number;
  /** Staff decisions re-applied from their source rows (lost route call). */
  readonly backstopApplied: number;
  /** Age in hours of the oldest request still waiting after this pass. */
  readonly oldestWaitingHours: number;
  readonly errored: number;
}

/**
 * Reconcile pass (its own hourly cron). Steps:
 *   1. clear requests stranded on cycles that left the OPEN states;
 *   2. converge each pending request:
 *        - plain (no refund) ........... end now (a retry of a failed inline end)
 *        - refund settled `succeeded` .. end now
 *        - refund settled `failed` ..... clear (CAS on the refund id) — membership kept
 *        - still pending / unresolved .. wait; past the expiry → clear (alerting)
 *   3. BACKSTOP — re-read recent staff "End membership" decisions from their
 *      source rows and stamp / end any the route call dropped.
 * One item's (or step's) failure never stops the pass; failures count as
 * `errored`.
 */
export async function reconcileMembershipCoverageEnds(
  deps: EndMembershipCoverageDeps,
  input: ReconcileMembershipCoverageEndsInput,
): Promise<Result<ReconcileMembershipCoverageEndsOutput, EndMembershipCoverageError>> {
  const tenantId = input.tenant.slug;
  const now = deps.clock.now();
  let ended = 0;
  let abandonedRefundFailed = 0;
  let waiting = 0;
  let lookupUnresolved = 0;
  let expired = 0;
  let strandedCleared = 0;
  let backstopApplied = 0;
  let oldestWaitingMs = 0;
  let errored = 0;

  // 1. Stranded requests.
  try {
    const stranded = await deps.coverageEndRequests.clearStranded(tenantId);
    strandedCleared = stranded.length;
    if (stranded.length > 0) {
      logger.error(
        { tenantId, cycleIds: stranded },
        'renewals.coverage_end.stranded_requests_cleared',
      );
    }
  } catch (e) {
    errored += 1;
    logger.error({ errName: errName(e), tenantId }, 'renewals.coverage_end.clear_stranded_failed');
  }

  // 2. Converge pending requests.
  let requests: Awaited<ReturnType<typeof deps.coverageEndRequests.listPending>> = [];
  try {
    requests = await deps.coverageEndRequests.listPending(tenantId, input.limit ?? 500);
  } catch (e) {
    errored += 1;
    logger.error({ errName: errName(e), tenantId }, 'renewals.coverage_end.reconcile_list_failed');
  }

  for (const req of requests) {
    try {
      if (req.refundId !== null && req.invoiceId !== null) {
        const refundId = req.refundId;
        const settlement = await deps.f5RefundBridge.getRefundOutcomeForInvoice({
          tenantId: tenantId as TenantId,
          invoiceId: req.invoiceId as InvoiceId,
          refundId,
        });
        if (settlement.status === 'failed') {
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
          const ageMs = now.getTime() - Date.parse(req.requestedAt);
          if (ageMs > COVERAGE_END_REQUEST_EXPIRY_DAYS * DAY_MS) {
            await runInTenant(input.tenant, (tx) =>
              deps.coverageEndRequests.clearInTx(tx, tenantId, req.cycleId, refundId),
            );
            expired += 1;
            logger.error(
              { tenantId, cycleId: req.cycleId, refundId, settlement: settlement.status },
              'renewals.coverage_end.request_expired_membership_kept',
            );
            continue;
          }
          if (settlement.status === 'pending') waiting += 1;
          else lookupUnresolved += 1;
          oldestWaitingMs = Math.max(oldestWaitingMs, ageMs);
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

  // 3. BACKSTOP from the durable source rows — AFTER convergence, so it only
  //    catches decisions the route call genuinely dropped (an alerting signal).
  try {
    const since = new Date(now.getTime() - COVERAGE_END_BACKSTOP_WINDOW_DAYS * DAY_MS);
    const records = await deps.membershipEndRequestSource.listSince(
      tenantId,
      since.toISOString(),
    );
    for (const rec of records) {
      if (rec.kind === 'refund' && rec.refundStatus === 'failed') continue;
      try {
        const open = await deps.cyclesRepo.findActiveForMember(tenantId, rec.memberId);
        // Nothing open, or the open cycle post-dates the decision (a comeback /
        // manual renewal the staff decision was never about) → nothing to do.
        if (!open || !isOpen(open.status)) continue;
        if (Date.parse(open.createdAt) > Date.parse(rec.at)) continue;
        const correlationId =
          rec.kind === 'refund' ? `refund:${rec.refundId}` : `credit-note:${rec.creditNoteId}`;
        const applied = await runInTenant(input.tenant, async (tx) => {
          if (rec.kind === 'refund' && rec.refundStatus === 'pending') {
            await deps.cyclesRepo.acquireCycleLockInTx(tx, tenantId, open.cycleId);
            // Already requested for this refund → the normal path owns it.
            return deps.coverageEndRequests.stampInTx(tx, tenantId, open.cycleId, {
              requestedAt: rec.at,
              refundId: rec.refundId,
              invoiceId: rec.invoiceId,
              actorUserId: null,
              onlyIfAbsent: true,
            });
          }
          return endOpenCycleInTx(deps, tx, {
            tenantId,
            cycleId: open.cycleId,
            memberId: rec.memberId,
            trigger: rec.kind === 'refund' ? 'refund' : 'credit_note',
            actorUserId: null,
            actorRole: 'cron',
            requestId: null,
            correlationId,
          });
        });
        if (applied) {
          backstopApplied += 1;
          logger.warn(
            { tenantId, memberId: rec.memberId, source: rec.kind, correlationId },
            'renewals.coverage_end.backstop_applied',
          );
        }
      } catch (e) {
        errored += 1;
        logger.error(
          { errName: errName(e), tenantId, memberId: rec.memberId, source: rec.kind },
          'renewals.coverage_end.backstop_item_failed',
        );
      }
    }
  } catch (e) {
    errored += 1;
    logger.error({ errName: errName(e), tenantId }, 'renewals.coverage_end.backstop_list_failed');
  }

  return ok({
    ended,
    abandonedRefundFailed,
    waiting,
    lookupUnresolved,
    expired,
    strandedCleared,
    backstopApplied,
    oldestWaitingHours: Math.floor(oldestWaitingMs / 3_600_000),
    errored,
  });
}
