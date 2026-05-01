/**
 * T161 — `reconcile-stuck-sending.ts` Application use-case (F7 US5).
 *
 * Runs at 24h timeout per FR-028 / R2-NEW-3. For broadcasts stuck in
 * `sending` longer than 24h we MUST distinguish two failure modes
 * before consuming the member's quota:
 *
 *   1. **Resend-side completion missed**: Resend dispatched fine but
 *      our webhook ingest dropped events (cron-job.org outage,
 *      signature secret rotation gap, etc.). `retrieveBroadcast`
 *      returns a non-null resource → we transition `sending → sent`
 *      and consume quota.
 *
 *   2. **Resource missing**: admin manually deleted the broadcast in
 *      the Resend dashboard, OR Resend purged it (rare). 404 →
 *      transition to `failed_to_dispatch` + audit
 *      `broadcast_resend_resource_missing` + alert admin. Quota is NOT
 *      consumed because no recipients received the message.
 *
 * The cron handler at `/api/cron/broadcasts/reconcile-stuck-sending`
 * pre-selects rows with `status='sending' AND sending_started_at <
 * now() - interval '24 hours'` then calls this use-case per-row.
 *
 * Pure Application — only Domain types + ports.
 */
import { err, ok, type Result } from '@/lib/result';
import { unsafeIanaTimezone, type TenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';

import type { Broadcast, BroadcastId } from '../../domain/broadcast';
import { transition } from '../../domain/policies/broadcast-status-transitions';

import type { AuditPort, F7AuditEventType } from '../ports/audit-port';
import type { BroadcastDeliveriesRepo } from '../ports/broadcast-deliveries-repo';
import type { BroadcastsGatewayPort } from '../ports/broadcasts-gateway-port';
import type { BroadcastsRepo } from '../ports/broadcasts-repo';
import type { ClockPort } from '../ports/clock-port';
import type { EmailTransactionalPort } from '../ports/email-transactional-port';
import type { MembersBridgePort } from '../ports/members-bridge-port';

import { currentQuotaYear } from './compute-quota-counter';
import { enqueueDeliverySummaryEmail } from './process-webhook-event';

const STUCK_SENDING_THRESHOLD_MS = 24 * 60 * 60 * 1000;

export type ReconcileStuckSendingOutcome =
  | { readonly kind: 'broadcast_not_found'; readonly broadcastId: BroadcastId }
  | {
      readonly kind: 'not_stuck_yet';
      readonly broadcastId: BroadcastId;
      readonly observedStatus: string;
    }
  | {
      readonly kind: 'reconciled_sent';
      readonly broadcastId: BroadcastId;
      readonly sentAt: Date;
      readonly quotaYear: number;
    }
  | {
      readonly kind: 'reconciled_failed_resource_missing';
      readonly broadcastId: BroadcastId;
    };

export type ReconcileStuckSendingError =
  | {
      readonly kind: 'reconcile.gateway_error';
      readonly cause: string;
    }
  | {
      readonly kind: 'reconcile.server_error';
      readonly message: string;
    };

/**
 * FR-028 / AS3 summary-email notification deps. Grouped together
 * (review TYPES-1 + ERR-H3) because the three fields are
 * mutually-implied — sending a summary email requires looking up the
 * member's primary contact (`membersBridge`), reading delivered/bounced
 * counts (`deliveriesRepo`), and a transport (`emailTransactional`).
 *
 * Group-presence contract (review ERR-H3 + PR #19 doc tighten): the
 * entire `notification` group is opt-in (parent type marks it
 * `notification?`). When the group IS supplied, `deliveriesRepo` MUST
 * be supplied alongside `membersBridge` — both are required fields of
 * `ReconcileNotificationDeps`. The previous shape allowed a partial
 * group with `deliveriesRepo` optional, which silently fell back to
 * {0,0,0} aggregates and shipped a factually wrong "0% delivered"
 * summary email. If a caller cannot supply `deliveriesRepo`, OMIT THE
 * ENTIRE GROUP (`notification: undefined`) so the email step skips
 * cleanly — do NOT supply `notification` with only `membersBridge`.
 *
 * `emailTransactional` remains optional — the reconcile path may want
 * the aggregate read for audit/observability without enqueueing an
 * email (tests, dry-runs).
 */
export interface ReconcileNotificationDeps {
  readonly membersBridge: MembersBridgePort;
  readonly deliveriesRepo: BroadcastDeliveriesRepo;
  readonly emailTransactional?: EmailTransactionalPort;
}

export interface ReconcileStuckSendingDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: BroadcastsRepo;
  readonly broadcastsGateway: BroadcastsGatewayPort;
  readonly audit: AuditPort;
  readonly clock: ClockPort;
  /**
   * Optional grouped notification deps — when present, the
   * reconciliation `markSent` path enqueues the FR-028 / AS3 summary
   * email. Best-effort: failures are logged and swallowed (mirrors the
   * webhook path). When omitted (legacy callers, tests), the email
   * step is skipped entirely.
   */
  readonly notification?: ReconcileNotificationDeps;
}

export interface ReconcileStuckSendingInput {
  readonly broadcastId: BroadcastId;
  readonly requestId: string | null;
}

export async function reconcileStuckSending(
  deps: ReconcileStuckSendingDeps,
  input: ReconcileStuckSendingInput,
): Promise<Result<ReconcileStuckSendingOutcome, ReconcileStuckSendingError>> {
  const tenantId = deps.tenant.slug;
  const now = deps.clock.now();

  try {
    const broadcast = await deps.broadcastsRepo.findById(
      tenantId,
      input.broadcastId,
    );
    if (broadcast === null) {
      return ok({
        kind: 'broadcast_not_found' as const,
        broadcastId: input.broadcastId,
      });
    }
    if (broadcast.status !== 'sending') {
      return ok({
        kind: 'not_stuck_yet' as const,
        broadcastId: input.broadcastId,
        observedStatus: broadcast.status,
      });
    }
    if (
      broadcast.sendingStartedAt === null ||
      now.getTime() - broadcast.sendingStartedAt.getTime() <
        STUCK_SENDING_THRESHOLD_MS
    ) {
      return ok({
        kind: 'not_stuck_yet' as const,
        broadcastId: input.broadcastId,
        observedStatus: broadcast.status,
      });
    }
    if (broadcast.resendBroadcastId === null) {
      // No Resend resource ever attached — dispatch failed before
      // gateway acknowledgement. Treat as failed_to_dispatch.
      return await markFailedToDispatch(
        deps,
        broadcast,
        'no_resend_resource_attached',
        input.requestId,
      );
    }

    let outcome;
    try {
      outcome = await deps.broadcastsGateway.retrieveBroadcast(
        broadcast.resendBroadcastId,
      );
    } catch (e) {
      return err({
        kind: 'reconcile.gateway_error',
        cause: e instanceof Error ? e.message : 'unknown gateway error',
      });
    }

    if (outcome.kind === 'not_found') {
      // Admin deleted in Resend dashboard, OR Resend purged the
      // resource. No recipients received → no quota consumption.
      return await markFailedToDispatch(
        deps,
        broadcast,
        'resend_resource_404',
        input.requestId,
      );
    }

    return await markSent(deps, broadcast, now, input.requestId);
  } catch (e) {
    return err({
      kind: 'reconcile.server_error',
      message: e instanceof Error ? e.message : 'unknown error',
    });
  }
}

async function markSent(
  deps: ReconcileStuckSendingDeps,
  broadcast: Broadcast,
  now: Date,
  requestId: string | null,
): Promise<Result<ReconcileStuckSendingOutcome, ReconcileStuckSendingError>> {
  const tenantId = deps.tenant.slug;
  const transitionResult = transition('sending', 'sent');
  if (!transitionResult.ok) {
    return err({
      kind: 'reconcile.server_error',
      message: `transition guard rejected sending→sent: ${transitionResult.error.code}`,
    });
  }
  const tenantTz = unsafeIanaTimezone(env.tenant.timezone);
  const quotaYear = currentQuotaYear(now, tenantTz);

  return await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.applyTransition(
      tx,
      tenantId,
      broadcast.broadcastId,
      'sent',
      {
        sentAt: now,
        quotaYearConsumed: quotaYear,
        quotaConsumedAt: now,
      },
    );

    await deps.audit.emit(tx, {
      eventType: 'broadcast_send_timeout_completed',
      tenantId,
      actorUserId: 'system:reconcile-cron',
      summary: `Broadcast ${broadcast.broadcastId} reconciled at 24h: Resend resource present, completing sent transition`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        resendBroadcastId: broadcast.resendBroadcastId,
        reconciledAt: now.toISOString(),
      },
      requestId,
    });
    await deps.audit.emit(tx, buildAudit('broadcast_sent', {
      tenantId,
      actorUserId: 'system:reconcile-cron',
      summary: `Broadcast ${broadcast.broadcastId} transitioned to sent via 24h reconciliation`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        sentAt: now.toISOString(),
        viaReconciliation: true,
      },
      requestId,
    }));
    await deps.audit.emit(tx, buildAudit('broadcast_quota_consumed', {
      tenantId,
      actorUserId: 'system:reconcile-cron',
      summary: `Quota slot consumed for broadcast ${broadcast.broadcastId} (year ${quotaYear})`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        quotaYear,
        quotaConsumedAt: now.toISOString(),
        viaReconciliation: true,
      },
      requestId,
    }));

    // FR-028 / AS3 — enqueue the summary email at the reconciliation
    // sent-transition path. Best-effort. Aggregate count is read AFTER
    // the audits are emitted so even a transient deliveriesRepo failure
    // doesn't block the audit trail. Uses the SHARED helper from
    // process-webhook-event.ts (single source of truth — review SIMPLIFY
    // consolidation, 2026-05-01).
    if (deps.notification !== undefined) {
      const { membersBridge, emailTransactional, deliveriesRepo } =
        deps.notification;
      // deliveriesRepo is now required inside the notification group
      // (review ERR-H3) so the summary email always carries truthful
      // delivered/bounced/complained counts. The aggregate read is
      // intentionally inside the same tx so RLS is enforced and the
      // counts reflect the events committed in this same transaction.
      const aggregate = await deliveriesRepo.aggregateByBroadcast(
        tenantId,
        broadcast.broadcastId,
        tx,
      );
      await enqueueDeliverySummaryEmail({
        tenant: deps.tenant,
        ...(emailTransactional !== undefined && { emailTransactional }),
        membersBridge,
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        broadcastSubject: broadcast.subject,
        aggregate: {
          delivered: aggregate.delivered,
          bounced: aggregate.bounced,
          complained: aggregate.complained,
        },
        estimatedRecipientCount: broadcast.estimatedRecipientCount,
        source: 'reconciliation',
        tx,
      });
    }

    return ok({
      kind: 'reconciled_sent' as const,
      broadcastId: broadcast.broadcastId,
      sentAt: now,
      quotaYear,
    });
  });
}

async function markFailedToDispatch(
  deps: ReconcileStuckSendingDeps,
  broadcast: Broadcast,
  reason: 'resend_resource_404' | 'no_resend_resource_attached',
  requestId: string | null,
): Promise<Result<ReconcileStuckSendingOutcome, ReconcileStuckSendingError>> {
  const tenantId = deps.tenant.slug;
  const now = deps.clock.now();
  const transitionResult = transition('sending', 'failed_to_dispatch');
  if (!transitionResult.ok) {
    return err({
      kind: 'reconcile.server_error',
      message: `transition guard rejected sending→failed_to_dispatch: ${transitionResult.error.code}`,
    });
  }

  return await deps.broadcastsRepo.withTx(async (tx) => {
    await deps.broadcastsRepo.applyTransition(
      tx,
      tenantId,
      broadcast.broadcastId,
      'failed_to_dispatch',
      {
        failedToDispatchAt: now,
        failureReason: reason,
      },
    );
    await deps.audit.emit(tx, buildAudit('broadcast_resend_resource_missing', {
      tenantId,
      actorUserId: 'system:reconcile-cron',
      summary: `Resend resource missing for broadcast ${broadcast.broadcastId} at 24h reconciliation — marking failed_to_dispatch`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        resendBroadcastId: broadcast.resendBroadcastId,
        reason,
        reconciledAt: now.toISOString(),
      },
      requestId,
    }));
    await deps.audit.emit(tx, buildAudit('broadcast_failed_to_dispatch', {
      tenantId,
      actorUserId: 'system:reconcile-cron',
      summary: `Broadcast ${broadcast.broadcastId} failed_to_dispatch via 24h reconciliation (${reason})`,
      payload: {
        broadcastId: broadcast.broadcastId,
        memberId: broadcast.requestedByMemberId,
        reason,
        viaReconciliation: true,
      },
      requestId,
    }));

    return ok({
      kind: 'reconciled_failed_resource_missing' as const,
      broadcastId: broadcast.broadcastId,
    });
  });
}

// Review ERR-M2: renamed from `audit` to `buildAudit` so it does not
// shadow `deps.audit` — a future contributor calling `audit.emit`
// without `deps.` would otherwise get a runtime TypeError caught by
// the outer try/catch and surfaced as `reconcile.server_error`.
function buildAudit(
  eventType: F7AuditEventType,
  rest: {
    readonly tenantId: string;
    readonly actorUserId: string;
    readonly summary: string;
    readonly payload: Record<string, unknown>;
    readonly requestId: string | null;
  },
) {
  return { eventType, ...rest };
}

