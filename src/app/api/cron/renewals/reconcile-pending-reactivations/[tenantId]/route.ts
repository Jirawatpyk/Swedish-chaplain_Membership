/**
 * F8 Phase 5 Wave C · T140 — Per-tenant reconcile-pending-reactivations.
 *
 * Invoked by the coordinator (T139) for each active tenant. Runs the
 * `reconcilePendingReactivations` use-case (T138) which walks pending
 * cycles + emits reminder ladder audits + auto-times-out at >= 30 days.
 *
 * Auth: Bearer `CRON_SECRET` via `gateCronBearerOrRespond` — gives this
 * route the same defence as the dispatch + at-risk + lapse per-tenant
 * routes (rate-limit on 401 + `cron_bearer_auth_rejected` audit emit).
 * Kill-switch mirrors coordinator semantics — 200 + skipped.
 *
 * Per-tenant advisory lock: `renewals:reconcile:<tenantId>`. Auto-
 * released at tx end. Concurrent cron-job.org retries serialise so the
 * "list pending cycles" query is not double-issued.
 *
 * MVP single-tenant guard: only `env.tenant.slug` accepted. Mirrors the
 * dispatch + at-risk + lapse per-tenant convention; closes the
 * deep-review gap.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import {
  reconcilePendingReactivations,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_LABEL =
  '/api/cron/renewals/reconcile-pending-reactivations/[tenantId]';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // Bearer + rate-limit + 401 audit (matches dispatch/at-risk/lapse).
  const gate = await gateCronBearerOrRespond(request, {
    route: ROUTE_LABEL,
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('reconcile'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gate !== null) return gate;

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const { tenantId } = await context.params;

  // MVP single-tenant guard.
  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.reconcile-pending.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  // Generate fresh correlationId — never trust inbound `x-request-id`.
  const correlationId = uuidv7();
  const tenantCtx = asTenantContext(tenantId);
  const startedAt = Date.now();

  try {
    return await runInTenant(tenantCtx, async (tx) => {
      // Per-tenant advisory lock — `renewals:reconcile:<tenantId>` is
      // distinct from `renewals:dispatch:` + `renewals:at-risk:` +
      // `renewals:lapse:` + `renewals:tierupgrade:` so all five cron
      // passes can run concurrently on the same tenant. Auto-released
      // at tx-end.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:reconcile:'||${tenantId}, 0))`,
      );

      const deps = makeRenewalsDeps(tenantId);
      const result = await reconcilePendingReactivations(deps, {
        tenantId,
        now: new Date(),
        correlationId,
      });
      if (!result.ok) {
        return NextResponse.json(
          {
            error: {
              code: result.error.kind,
              message: result.error.message,
            },
          },
          { status: 400 },
        );
      }
      return NextResponse.json({
        skipped: false,
        cycles_processed: result.value.cyclesProcessed,
        reminders_t7: result.value.remindersT7,
        reminders_t3: result.value.remindersT3,
        reminders_t1: result.value.remindersT1,
        // Round 2 review-fix (I-6): SRE-visible reminder-emit failures.
        reminders_failed: result.value.remindersFailed,
        timed_out: result.value.timedOut,
        timeout_refund_failures: result.value.timeoutRefundFailures,
        // F8-RP: refund submitted but settling asynchronously (Stripe
        // pending/requires_action or a prior refund already in-flight). Cycle
        // stays pending + self-heals next run. NOT a failure — split out from
        // `timeout_refund_failures` so an in-flight refund is not mislabelled.
        timeout_refund_pending: result.value.timeoutRefundPending,
        // MONEY-SAFETY (063): cycles skipped because an admin approve/
        // reject won the per-cycle lock race BEFORE the refund (Step-1;
        // no money moved).
        timeout_admin_race_skipped: result.value.timeoutAdminRaceSkipped,
        // MONEY-SAFETY (063 xhigh): refund WAS issued, then admin/conflict
        // won the tx2 window (Step-3; member terminal but refunded — the
        // accepted residual per #6). Previously hidden inside `timed_out`.
        timeout_refund_orphaned: result.value.timeoutRefundOrphaned,
        // MONEY-SAFETY (063 xhigh): refund succeeded but tx2 transition
        // threw (non-conflict); money durable, next cron run self-heals.
        // Previously mislabelled as a refund failure. PAGES on-call.
        timeout_transition_failed_post_refund:
          result.value.timeoutTransitionFailedPostRefund,
        // 063 follow-up: tx2 transition threw (non-conflict) but NO refund
        // moved (no invoice OR no_payment_found); no money at stake, cycle
        // self-heals next run. INFORMATIONAL — split from the paging
        // post-refund counter so a no-money DB blip does not falsely page.
        timeout_transition_failed_no_refund:
          result.value.timeoutTransitionFailedNoRefund,
        // F8-RP follow-up: async reject-with-refund SETTLEMENT reconciliation.
        // A cycle an admin REJECTED with a refund that F5 settled
        // asynchronously converges → `cancelled` (parity with the sync reject),
        // NOT the timeout → `lapsed`. `async_reject_refund_failed` is the
        // ALERTING outcome (the async refund never returned the money).
        async_reject_settled_cancelled:
          result.value.asyncRejectSettledCancelled,
        async_reject_refund_still_pending:
          result.value.asyncRejectRefundStillPending,
        async_reject_refund_failed: result.value.asyncRejectRefundFailed,
        async_reject_lookup_failed: result.value.asyncRejectLookupFailed,
        async_reject_admin_race_skipped:
          result.value.asyncRejectAdminRaceSkipped,
        // F8-RP-2 review fix: the settle tx threw a non-conflict error (DB
        // blip); the tx rolled back, the cycle stays marked+pending and
        // self-heals next pass. INFORMATIONAL — never pages on its own.
        async_reject_settle_failed: result.value.asyncRejectSettleFailed,
        duration_ms: Date.now() - startedAt,
      });
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId,
      },
      'cron.renewals.reconcile-pending.per-tenant.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
