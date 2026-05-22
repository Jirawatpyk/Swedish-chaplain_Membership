/**
 * T050 (F7.1a US1) — POST `/api/admin/broadcasts/[id]/retry`.
 *
 * Wraps `retryFailedBatches` use case (Phase 3 Cluster 3B.2). Re-queues
 * every `batch_manifest` row in `failed` state on a broadcast in
 * `partially_sent`. Bounded by `MANUAL_RETRY_BUDGET = 3` on
 * `broadcasts.manual_retry_count`.
 *
 * Auth: admin role (RBAC `broadcast`+`write`).
 *
 * Contract spec: specs/014-email-broadcast-advance/contracts/batch-dispatch.md § 1.3.
 *
 * SC-007 concurrent-retry guard (admin double-click protection): the
 * use case wraps its entire body in `broadcasts.withTx(async tx => …)`
 * and acquires `pg_try_advisory_xact_lock(hashtextextended('broadcasts-
 * retry:{tenant}:{bid}', 0))` INSIDE that tx (Phase 3E hardening
 * 2026-05-19 — production `pgAdvisoryLockAdapter` replaces the
 * earlier `noOpAdvisoryLock` stub). The lock auto-releases at tx
 * commit/rollback so the snapshot read + budget increment + batch
 * fan-out + audit emits are one atomic unit. Concurrent calls see
 * `{acquired: false}` and surface ALREADY_RETRYING_IN_PROGRESS
 * without consuming the budget.
 *
 * Empty request body — the broadcast id is in the URL, the actor id
 * comes from the admin session.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  retryFailedBatches,
  makeRetryFailedBatchesDeps,
  parseBroadcastId,
  isF71aUs1Enabled,
  f71aUs1DisabledReason,
  type RetryFailedBatchesError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  // T061 F71A US1 flag gate. When OFF: return 503 feature_disabled so
  // the admin UI's retry button surface (T053 + T049) sees a clear
  // signal that the feature is dark. Triple-flag check (F7 master +
  // F71A master + US1 sub-flag) via `isF71aUs1Enabled`.
  if (!isF71aUs1Enabled()) {
    logger.info(
      { correlationId, reason: f71aUs1DisabledReason() },
      'admin.broadcasts.retry.feature_disabled',
    );
    return errorResponse(503, 'feature_disabled', correlationId);
  }

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRetryFailedBatchesDeps(tenantCtx.slug);

  try {
    const result = await retryFailedBatches(deps, {
      tenantId: tenantCtx,
      broadcastId: parsedId.value,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapRetryError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: parsedId.value as unknown as string,
        retryAttempt: result.value.retryAttempt,
        retriedBatchCount: result.value.retriedBatchCount,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        broadcastId: parsedId.value as unknown as string,
      },
      'admin.broadcasts.retry.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapRetryError(
  error: RetryFailedBatchesError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'retry_failed_batches.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }

  const code = (() => {
    switch (error.kind) {
      case 'BROADCAST_NOT_FOUND':
        return 'broadcast_not_found' as const;
      case 'INVALID_STATE_TRANSITION':
        return 'broadcast_invalid_state_transition' as const;
      case 'MANUAL_RETRY_BUDGET_EXHAUSTED':
        return 'broadcast_manual_retry_budget_exhausted' as const;
      case 'ALREADY_RETRYING_IN_PROGRESS':
        return 'broadcast_already_retrying_in_progress' as const;
    }
  })();

  const { status } = httpStatusForBroadcastError(code);
  const details: Record<string, unknown> = {};
  if (error.kind === 'INVALID_STATE_TRANSITION') {
    details['observedStatus'] = error.currentStatus;
    details['expected'] = error.expected;
  } else if (error.kind === 'MANUAL_RETRY_BUDGET_EXHAUSTED') {
    details['budget'] = error.budget;
  } else if (error.kind === 'BROADCAST_NOT_FOUND') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}
