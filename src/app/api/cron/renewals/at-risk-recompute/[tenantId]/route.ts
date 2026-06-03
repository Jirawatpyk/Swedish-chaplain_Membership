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
import { renewalsMetrics } from '@/lib/metrics';
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
    // Lock + work atomic (Phase 6 review C1): the advisory_xact_lock,
    // the batched recompute (factor CTE + bulk UPDATE + bulk audit
    // INSERT), and the partial-failure audit all commit in one tx.
    // Two concurrent cron-job.org invocations now serialise correctly
    // — one waits on the lock until the other commits, instead of both
    // racing through the use-case work. Lock namespace
    // `renewals:at-risk:` stays disjoint from `renewals:dispatch:`.
    const memberNotFound = 0; // batched path doesn't surface this signal

    const txResult = await runInTenant(tenantCtx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:at-risk:'||${tenantId}, 0))`,
      );
      // T159b batched recompute — 4 round-trips total (settings +
      // factor CTE + bulk UPDATE + bulk INSERT audits) regardless of
      // member count. Hits FR-036 + SC-005 60s @ 5,000 members SLO on
      // production-equivalent infra (verified by T174 perf when
      // PERF_SLO_STRICT=1).
      const batchResult = await recomputeAtRiskScoresBatch(
        deps,
        { tenantId, correlationId },
        tx,
      );
      if (!batchResult.ok) return batchResult;

      // Partial-failure audit emit inside the same tx — atomic with
      // the recompute writes. Caller-provided tx via emitInTx so the
      // audit row commits + the lock is held until commit.
      const failed = batchResult.value.membersFailed;
      if (failed > 0) {
        await deps.auditEmitter.emitInTx(
          tx,
          {
            type: 'at_risk_compute_partial_failure',
            payload: {
              error_class: 'aggregate',
              members_processed:
                batchResult.value.membersTotal - failed,
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
      }
      return batchResult;
    });

    if (!txResult.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: txResult.error.kind,
          message:
            txResult.error.kind === 'invalid_input' ||
            txResult.error.kind === 'server_error'
              ? txResult.error.message
              : undefined,
        },
        'cron.renewals.at_risk.batch_failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const durationMs = Date.now() - startedAt;
    const responseBody = {
      skipped: false as const,
      tenant_id: tenantId,
      members_total: txResult.value.membersTotal,
      members_recomputed: txResult.value.membersRecomputed,
      members_skipped_below_tenure: txResult.value.membersSkippedBelowTenure,
      members_not_found: memberNotFound,
      members_failed: txResult.value.membersFailed,
      duration_ms: durationMs,
    };

    // W0-09: § 23.1.2 per-member at-risk recompute counters.
    //
    // The batch path (`recomputeAtRiskScoresBatch`) performs a bulk
    // UPDATE so individual per-member new-band values are not surfaced
    // in the aggregate result. We use `band='batch'` as a discriminator
    // sentinel so dashboards can distinguish "batch cron recompute" from
    // a hypothetical future per-member admin-triggered recompute (which
    // would emit with a real band label). `count=membersRecomputed` so
    // the counter accurately reflects the number of members processed,
    // not just 1 per cron invocation.
    //
    // The existing `atRiskScoresRecomputed(tenant)` counter (§ 23.1.1.b)
    // inside compute-at-risk-score.ts handles the per-member single-
    // recompute path; the two counters are complementary, not duplicates.
    if (txResult.value.membersRecomputed > 0) {
      renewalsMetrics.atRiskRecomputeMembersSucceeded(
        tenantId,
        'batch',
        txResult.value.membersRecomputed,
      );
    }
    if (txResult.value.membersFailed > 0) {
      renewalsMetrics.atRiskRecomputeMembersFailed(tenantId, txResult.value.membersFailed);
    }

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
