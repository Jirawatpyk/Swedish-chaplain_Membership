/**
 * F8 Phase 7 T189 — Weekly tier-upgrade-evaluate coordinator.
 *
 * Triggered WEEKLY at Sunday 03:00 Asia/Bangkok by cron-job.org (per
 * `docs/runbooks/cron-jobs.md`). Resolves the set of active tenants,
 * fans out to per-tenant `/api/cron/renewals/tier-upgrade-evaluate/[tenantId]`
 * routes via internal HTTP, aggregates results, emits
 * `cron_dispatch_orchestrated` audit, returns a summary.
 *
 * Architecture mirrors the at-risk-recompute-coordinator pattern.
 *
 * Auth: Bearer via `CRON_SECRET` (constant-time check).
 *
 * Kill-switches:
 *   - `FEATURE_F8_RENEWALS=false` → 200 + `{skipped: true, reason:
 *     'feature_flag_disabled'}` (whole-F8 dark launch)
 *
 * Returns 200 (NOT 503 / 5xx) so cron-job.org does not retry-storm
 * during a dark-launch period.
 *
 * Round 6 S-010 — multi-tenant timeout policy (post-MVP planning):
 * `Promise.allSettled` fan-out has NO per-tenant request timeout
 * today. MVP+STD limits to `env.tenant.slug` (length 1) so wall-clock
 * ≈ single per-tenant duration ≪ Vercel 300s function budget. When
 * the platform moves to multi-tenant SaaS:
 *   - Add `AbortController` per per-tenant `fetch(...)` with timeout
 *     proportional to FR-057 budget (30s evaluate × 1.5 safety = 45s).
 *   - Add hard ceiling at coordinator wall-clock 270s (300s budget
 *     minus 30s for audit emit + JSON serialise). When exceeded,
 *     remaining tenants get `{ tenant_id, error: 'coordinator_timed_out' }`.
 *   - Add `tenants_timed_out` field to `OrchestratedSummary`.
 * Tracked as F10+ post-MVP because today the runtime invariant
 * (length=1) makes the gap unobservable.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerTenantResultOk {
  readonly tenant_id: string;
  readonly skipped: boolean;
  readonly tenant_skipped_reason?: string;
  readonly members_scanned?: number;
  readonly suggestions_created?: number;
  readonly already_at_target?: number;
  readonly suppressed_skipped?: number;
  readonly conflict_skipped?: number;
  readonly duration_ms?: number;
}

interface PerTenantResultErr {
  readonly tenant_id: string;
  readonly error: string;
}

type PerTenantResult = PerTenantResultOk | PerTenantResultErr;

interface OrchestratedSummary {
  readonly tenants_enqueued: number;
  readonly tenants_succeeded: number;
  readonly tenants_failed: number;
  readonly tenants_skipped_kill_switch: number;
  readonly duration_ms: number;
}

async function emitOrchestratedAudit(
  bookkeepingTenantSlug: string,
  summary: OrchestratedSummary,
  perTenantResults: ReadonlyArray<PerTenantResult>,
  correlationId: string,
): Promise<void> {
  try {
    const deps = makeRenewalsDeps(bookkeepingTenantSlug);
    await deps.auditEmitter.emit(
      {
        type: 'cron_dispatch_orchestrated',
        payload: {
          cron_kind: 'tier_upgrade_evaluate',
          tenants_enqueued: summary.tenants_enqueued,
          tenants_succeeded: summary.tenants_succeeded,
          tenants_failed: summary.tenants_failed,
          tenants_skipped_kill_switch: summary.tenants_skipped_kill_switch,
          duration_ms: summary.duration_ms,
          per_tenant_summaries: perTenantResults.map((r) =>
            'error' in r
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped,
                  reminders_dispatched: r.suggestions_created ?? 0,
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                },
          ),
        },
      },
      {
        tenantId: bookkeepingTenantSlug,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
        requestId: correlationId,
      },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
      },
      'cron.renewals.tier_upgrade.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('tier_upgrade_evaluate');
  }
}

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/tier-upgrade-evaluate-coordinator',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('tier_upgrade_evaluate'),
    // Upstash fail-open counter — parity with dispatch-coordinator (see
    // at-risk-recompute-coordinator for rationale).
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (authResponse) return authResponse;

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const startedAt = Date.now();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_tier_upgrade_evaluate_coordinator',
    { 'cron.endpoint': 'tier-upgrade-evaluate-coordinator' },
    async (span) => {
  const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
  span.setAttribute('renewals.tenants_enqueued', activeTenants.length);

  if (activeTenants.length === 0) {
    const summary: OrchestratedSummary = {
      tenants_enqueued: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      tenants_skipped_kill_switch: 0,
      duration_ms: Date.now() - startedAt,
    };
    await emitOrchestratedAudit(env.tenant.slug, summary, [], correlationId);
    renewalsMetrics.coordinatorTenantsEnqueued('tier_upgrade_evaluate', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('tier_upgrade_evaluate', 0);
    renewalsMetrics.coordinatorDurationMs('tier_upgrade_evaluate', summary.duration_ms);
    return NextResponse.json({
      skipped: false,
      ...summary,
      per_tenant_results: [],
    });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async () => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/tier-upgrade-evaluate/${encodeURIComponent(tenantId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              'x-request-id': correlationId,
            },
          },
        );
        let json: Record<string, unknown> = {};
        let jsonParseFailed = false;
        try {
          json = (await r.json()) as Record<string, unknown>;
        } catch (e) {
          jsonParseFailed = true;
          logger.error(
            {
              err: e instanceof Error ? e : new Error(String(e)),
              tenantId,
              status: r.status,
              correlationId,
            },
            'cron.renewals.tier_upgrade.coordinator.json_parse_failed',
          );
        }
        return {
          tenantId,
          ok: r.ok,
          status: r.status,
          json,
          jsonParseFailed,
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'fulfilled' && r.value.ok && !r.value.jsonParseFailed) {
      return {
        tenant_id: tenantId,
        skipped: Boolean(r.value.json.skipped),
        members_scanned:
          typeof r.value.json.members_scanned === 'number'
            ? r.value.json.members_scanned
            : 0,
        suggestions_created:
          typeof r.value.json.suggestions_created === 'number'
            ? r.value.json.suggestions_created
            : 0,
        already_at_target:
          typeof r.value.json.already_at_target === 'number'
            ? r.value.json.already_at_target
            : 0,
        suppressed_skipped:
          typeof r.value.json.suppressed_skipped === 'number'
            ? r.value.json.suppressed_skipped
            : 0,
        conflict_skipped:
          typeof r.value.json.conflict_skipped === 'number'
            ? r.value.json.conflict_skipped
            : 0,
        duration_ms:
          typeof r.value.json.duration_ms === 'number'
            ? r.value.json.duration_ms
            : 0,
      };
    }
    if (r.status === 'rejected') {
      const reasonStr = String(r.reason);
      logger.error(
        { tenantId, correlationId, reason: reasonStr.slice(0, 400) },
        'cron.renewals.tier_upgrade.coordinator.tenant_fetch_rejected',
      );
      // Round 6 W-007 — cap the response-body `error` field to 200
      // chars to prevent stack-trace / internal-hostname leakage to
      // cron-job.org. Log slice (line above) keeps 400 chars for ops
      // diagnostics; HTTP response body MUST stay tighter because
      // cron-job.org persists it on their dashboard for ≤30 days.
      return { tenant_id: tenantId, error: reasonStr.slice(0, 200) };
    }
    if (r.value.jsonParseFailed) {
      return {
        tenant_id: tenantId,
        error: `http_${r.value.status}_json_parse_failed`,
      };
    }
    logger.error(
      {
        tenantId,
        correlationId,
        status: r.value.status,
        errorBody: r.value.json,
      },
      'cron.renewals.tier_upgrade.coordinator.tenant_http_error',
    );
    return { tenant_id: tenantId, error: `http_${r.value.status}` };
  });

  const tenantsSucceededOrSkipped = perTenantResults.filter(
    (r): r is PerTenantResultOk => !('error' in r),
  );
  const tenantsSkippedKillSwitch = tenantsSucceededOrSkipped.filter(
    (r) => r.skipped,
  ).length;
  const tenantsSucceeded =
    tenantsSucceededOrSkipped.length - tenantsSkippedKillSwitch;
  const tenantsFailed =
    perTenantResults.length - tenantsSucceededOrSkipped.length;

  const summary: OrchestratedSummary = {
    tenants_enqueued: activeTenants.length,
    tenants_succeeded: tenantsSucceeded,
    tenants_failed: tenantsFailed,
    tenants_skipped_kill_switch: tenantsSkippedKillSwitch,
    duration_ms: Date.now() - startedAt,
  };

  span.setAttribute('renewals.tenants_succeeded', tenantsSucceeded);
  span.setAttribute('renewals.tenants_failed', tenantsFailed);
  span.setAttribute('renewals.duration_ms', summary.duration_ms);

  await emitOrchestratedAudit(
    env.tenant.slug,
    summary,
    perTenantResults,
    correlationId,
  );

  // W0-09: § 23.1.3 coordinator-level metrics.
  renewalsMetrics.coordinatorTenantsEnqueued('tier_upgrade_evaluate', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('tier_upgrade_evaluate', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('tier_upgrade_evaluate', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('tier_upgrade_evaluate', summary.duration_ms);

  logger.info(
    { correlationId, ...summary },
    'cron.renewals.tier_upgrade.coordinator.complete',
  );

  return NextResponse.json({
    skipped: false,
    ...summary,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
