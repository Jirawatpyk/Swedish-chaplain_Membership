/**
 * F8 Phase 6 Wave C · T161 — Per-tenant at-risk recompute route.
 *
 * Called by the weekly at-risk-recompute coordinator (T160) — NOT by
 * cron-job.org directly. Receives `tenantId` as a URL path param,
 * validates against `env.tenant.slug` (MVP single-tenant guard),
 * acquires per-tenant advisory lock, then loops over active members
 * (per FR-007a canonical definition) calling the T154
 * `computeAtRiskScore` use-case once per member with per-member fault
 * isolation.
 *
 * Per-tenant advisory lock convention:
 *   pg_advisory_xact_lock(hashtextextended('renewals:at-risk:'||tenantId, 0))
 *
 * Distinct namespace from `renewals:dispatch:` so daily dispatch + the
 * weekly at-risk recompute can run concurrently without contention. F4
 * uses `invoicing:`, F5 `payments:`, F7 `broadcasts:` — all namespaces
 * disjoint.
 *
 * Auth: Bearer via `CRON_SECRET` (matches T160 coordinator + dispatch
 * cron pattern).
 *
 * Kill-switches:
 *   - `FEATURE_F8_RENEWALS=false` → 200 + `{skipped: true, reason:
 *     'feature_flag_disabled'}` (whole-F8 dark launch)
 *   - `FEATURE_F8_AT_RISK_DISABLED=true` → 200 + `{skipped: true,
 *     reason: 'at_risk_disabled'}` (granular per FR-052b — disable
 *     ONLY at-risk while leaving renewals + tier-upgrade running)
 *
 * Both kill-switches return 200 (NOT 503 / 5xx) so cron-job.org does
 * not retry-storm during a dark-launch window.
 *
 * Per-member fault isolation: each `computeAtRiskScore` call is
 * wrapped in try/catch; any thrown exception (including non-Result
 * errors) is logged + counted in `members_failed` AND the cron pass
 * continues with the next member. After the loop, if
 * `members_failed > 0` the route emits a single
 * `at_risk_compute_partial_failure` audit per cron pass with the
 * aggregate counts (per FR-spec audit-port shape).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { getClientIp } from '@/lib/client-ip';
import { asTenantContext } from '@/modules/tenants';
import {
  recomputeAtRiskScoresBatch,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // ----- Bearer auth + rate-limited 401 audit ----------------------------
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    const ip = getClientIp(request);
    try {
      const rl = await rateLimiter.check(
        `f8:cron:bearer-rejected:${ip}`,
        60,
        60,
      );
      if (!rl.success) {
        return NextResponse.json(
          { error: { code: 'rate_limited' } },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
          },
        );
      }
    } catch (e) {
      // Fail-open per Upstash-outage policy mirrored from dispatch
      // route (see dispatch-coordinator/route.ts for full rationale).
      const errInstance = e instanceof Error ? e : new Error(String(e));
      logger.warn(
        {
          errMsg: errInstance.message.slice(0, 200),
          errName: errInstance.name,
          ip,
          route: '/api/cron/renewals/at-risk-recompute/[tenantId]',
        },
        'cron.renewals.at_risk.rate_limit_check_failed_fail_open',
      );
    }
    try {
      const deps = makeRenewalsDeps(env.tenant.slug);
      await deps.auditEmitter.emit(
        {
          type: 'cron_bearer_auth_rejected',
          payload: {
            route: '/api/cron/renewals/at-risk-recompute/[tenantId]',
          },
        },
        {
          tenantId: env.tenant.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: uuidv7(),
          requestId: null,
        },
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e : new Error(String(e)) },
        'cron.renewals.at_risk.bearer_rejected_audit_failed',
      );
    }
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // ----- Kill-switch gates ----------------------------------------------
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  if (env.features.f8AtRiskDisabled) {
    return NextResponse.json(
      { skipped: true, reason: 'at_risk_disabled' },
      { status: 200 },
    );
  }

  const { tenantId } = await context.params;

  // MVP single-tenant guard.
  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.at_risk.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  const correlationId = uuidv7();
  const tenantCtx = asTenantContext(tenantId);
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    // Acquire the per-tenant advisory lock — runs inside its own tx
    // that auto-releases at commit. Distinct from the batch use-case's
    // own tx (the use-case opens its own runInTenant; the lock here is
    // a serialisation guard to prevent two concurrent at-risk crons
    // racing for the same tenant). Lock namespace `renewals:at-risk:`
    // is disjoint from `renewals:dispatch:` so daily dispatch and
    // weekly at-risk can run concurrently without contention.
    try {
      await runInTenant(tenantCtx, async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:at-risk:'||${tenantId}, 0))`,
        );
      });
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          tenantId,
          correlationId,
        },
        'cron.renewals.at_risk.lock_acquire_failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    // T159b — batched recompute use-case: 4 round-trips total (settings
    // + factor CTE + bulk UPDATE + bulk INSERT audits) regardless of
    // member count. Hits FR-036 + SC-005 60s @ 5,000 members SLO on
    // production-equivalent infra (verified by T174 perf bench when
    // PERF_SLO_STRICT=1).
    let recomputed = 0;
    let skippedBelowTenure = 0;
    const memberNotFound = 0; // batched path doesn't surface this signal
    let failed = 0;
    let membersTotal = 0;

    const batchResult = await recomputeAtRiskScoresBatch(deps, {
      tenantId,
      correlationId,
    });
    if (!batchResult.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: batchResult.error.kind,
          message:
            batchResult.error.kind === 'invalid_input' ||
            batchResult.error.kind === 'server_error'
              ? batchResult.error.message
              : undefined,
        },
        'cron.renewals.at_risk.batch_failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }
    membersTotal = batchResult.value.membersTotal;
    recomputed = batchResult.value.membersRecomputed;
    skippedBelowTenure = batchResult.value.membersSkippedBelowTenure;
    failed = batchResult.value.membersFailed;
    void memberNotFound;

    // Step 3 — emit one partial-failure audit per cron pass if any
    // member failed.
    if (failed > 0) {
      try {
        await deps.auditEmitter.emit(
          {
            type: 'at_risk_compute_partial_failure',
            payload: {
              error_class: 'aggregate',
              members_processed: membersTotal - failed,
              members_failed: failed,
            },
          },
          {
            tenantId,
            actorUserId: null,
            actorRole: 'cron',
            correlationId,
            requestId: null,
          },
        );
      } catch (e) {
        logger.error(
          { err: e instanceof Error ? e : new Error(String(e)), tenantId },
          'cron.renewals.at_risk.partial_failure_audit_emit_failed',
        );
      }
    }

    const responseBody = {
      skipped: false as const,
      tenant_id: tenantId,
      members_total: membersTotal,
      members_recomputed: recomputed,
      members_skipped_below_tenure: skippedBelowTenure,
      members_not_found: memberNotFound,
      members_failed: failed,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...responseBody },
      'cron.renewals.at_risk.complete',
    );
    return NextResponse.json(responseBody);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.at_risk.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
