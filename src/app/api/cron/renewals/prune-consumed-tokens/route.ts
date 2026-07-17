/**
 * F8 Phase 9 retrofit (PR #25) — Weekly prune of consumed link tokens.
 *
 * Deletes rows from `consumed_link_tokens` whose `consumed_at` is older
 * than the 60-day retention window (`data-model.md § 2.8` + migration
 * 0093 header comment). The token-replay-protection table is append-
 * only by design (no UPDATE GRANT); without this cron the table grows
 * unbounded.
 *
 * Triggered WEEKLY at Saturday 04:00 Asia/Bangkok by cron-job.org per
 * `docs/runbooks/cron-jobs.md` F8 token-prune entry.
 *
 * MVP single-tenant: this route does both orchestrator + per-tenant
 * work (no fan-out needed at SweCham scale). When the project moves to
 * multi-tenant, fan out via internal HTTP per the
 * tier-upgrade-evaluate-coordinator pattern.
 *
 * Auth: Bearer via `CRON_SECRET` (through `gateCronBearerOrRespond` —
 * adds rate-limit + `cron_bearer_auth_rejected` audit on 401 path,
 * matching the coordinator-route convention).
 * Kill-switch: `FEATURE_F8_RENEWALS=false` → 200 + skipped (cron-job.org
 * does NOT retry on 200).
 * READ_ONLY_MODE: short-circuits to 200 + skipped + observability
 * counter (mirrors dispatch-coordinator pattern).
 *
 * Concurrency: NO advisory lock. DELETE on `consumed_link_tokens` is
 * idempotent — rows already pruned return 0 affected rows; concurrent
 * fires on disjoint row subsets are serialised by Postgres row-level
 * locks with zero correctness impact. cron-job.org retry-OFF per the
 * F8 retry-policy contract eliminates the trigger-side double-fire
 * source. The Phase 9-original code had an `pg_advisory_xact_lock`
 * acquired in a separate `runInTenant` block from the use-case call,
 * which auto-released at the lock-tx's COMMIT before the work ran —
 * the lock did nothing. Removing it is correctness-preserving and
 * complexity-reducing.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { pruneConsumedTokens, makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Shared Bearer-gate helper — constant-time compare, rate-limit on
  // 401 with Upstash fail-open, `cron_bearer_auth_rejected` audit emit
  // with route discriminator, 429 with Retry-After. Mirrors the
  // coordinator-route adoption pattern (dispatch-coordinator, at-risk
  // -recompute-coordinator, lapse-cycles-coordinator, reconcile-
  // pending-reactivations-coordinator).
  const gateResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/prune-consumed-tokens',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('prune_consumed_tokens'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gateResponse) {
    return gateResponse;
  }

  // Kill-switch — return 200 + skipped so cron-job.org does NOT retry-
  // storm during dark-launch. The F8 proxy gate (`src/proxy.ts:389`)
  // ALSO returns 503 for `/api/cron/renewals/**` when the flag is
  // false; this in-route check is defence-in-depth and the canonical
  // contract once the proxy carve-out for cron routes lands.
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  // READ_ONLY_MODE short-circuit — mirrors dispatch-coordinator
  // pattern. 200 + skipped (NOT 503) so cron-job.org does not retry-
  // storm; the metric counter makes a flag-flap leaving READ_ONLY=
  // true past the maintenance window dashboardable from outside.
  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('prune_consumed_tokens');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const tenantId = env.tenant.slug;
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    const result = await pruneConsumedTokens(deps, {
      tenantId,
      correlationId,
      now: new Date(),
    });
    if (!result.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: result.error.kind,
        },
        'cron.renewals.prune_consumed_tokens.failed',
      );
      // PR #25 review-fix Round 2 — emit ONLY the run-count counter
      // on failure (rows-deleted counter is success-only). Decouples
      // "did the cron run" from "how many rows were pruned" so
      // PromQL `rate(...rows_deleted_total)` produces a clean
      // capacity-planning signal independent of failure rate.
      renewalsMetrics.pruneConsumedTokensRunCompleted(tenantId, 'failure');
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      pruned: result.value.pruned,
      cutoff_iso: result.value.cutoffIso,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...body },
      'cron.renewals.prune_consumed_tokens.complete',
    );
    // PR #25 review-fix Round 2 — emit both run-count (success) +
    // row-count counters. A 0-row pass still increments the run
    // counter so absence-of-tick alarms work even during steady-state
    // weeks where nothing was old enough to prune.
    renewalsMetrics.pruneConsumedTokensRunCompleted(tenantId, 'success');
    renewalsMetrics.pruneConsumedTokensRowsPruned(
      tenantId,
      result.value.pruned,
    );
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.prune_consumed_tokens.unexpected_error',
    );
    renewalsMetrics.pruneConsumedTokensRunCompleted(tenantId, 'failure');
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
