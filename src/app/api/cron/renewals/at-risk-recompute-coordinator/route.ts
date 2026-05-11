/**
 * F8 Phase 6 Wave C · T160 — Weekly at-risk recompute coordinator.
 *
 * Triggered WEEKLY at Sunday 02:00 Asia/Bangkok by cron-job.org (per
 * `docs/runbooks/cron-jobs.md` F8 entry — added by T162). Resolves the
 * set of active tenants, fans out to per-tenant
 * `/api/cron/renewals/at-risk-recompute/[tenantId]` routes via internal
 * HTTP, aggregates results, emits `cron_dispatch_orchestrated` audit
 * (existing typed shape from F4/F5/F7 + dispatch-coordinator pattern),
 * returns a summary.
 *
 * Architecture (mirrors dispatch-coordinator):
 *   - Promise.allSettled isolates per-tenant failures.
 *   - Per-tenant route's own SLO < 60s @ 5,000 members per FR-036 +
 *     SC-005 fits comfortably under one Vercel function timeout.
 *   - Each per-tenant invocation runs in its own function instance
 *     with its own 300s budget.
 *
 * MVP single-tenant: "active tenants" = `[env.tenant.slug]`. Post-F10
 * SaaS multi-tenant would query a tenants table.
 *
 * Auth: Bearer via `CRON_SECRET` (constant-time check).
 *
 * Kill-switches:
 *   - `FEATURE_F8_RENEWALS=false` → 200 + `{skipped: true, reason:
 *     'feature_flag_disabled'}` (whole-F8 dark launch)
 *   - `FEATURE_F8_AT_RISK_DISABLED=true` → 200 + `{skipped: true,
 *     reason: 'at_risk_disabled'}` (granular per FR-052b)
 *
 * Both return 200 (NOT 503 / 5xx) so cron-job.org does not retry-storm
 * during a dark-launch period.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerTenantResultOk {
  readonly tenant_id: string;
  readonly skipped: boolean;
  readonly members_recomputed?: number;
  readonly members_skipped_below_tenure?: number;
  readonly members_failed?: number;
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
          cron_kind: 'at_risk_recompute',
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
                  // Round-5 review-finding M3: `reminders_dispatched`
                  // re-purposed as members_recomputed (legacy slot kept
                  // for backward-compat with existing dashboards).
                  // `tasks_created: 0` because the at-risk run produces
                  // no escalation tasks; the actual `members_failed`
                  // counter lives in the new typed `kind_specific` slot
                  // below so SRE dashboards can read it without
                  // re-purposing the dispatch-named field.
                  reminders_dispatched: r.members_recomputed ?? 0,
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'at_risk_recompute',
                    members_failed: r.members_failed ?? 0,
                    members_skipped_below_tenure:
                      r.members_skipped_below_tenure ?? 0,
                  },
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
    // Mirror dispatch-coordinator pattern (line 157): counter fires the
    // alert pipeline so on-call sees the compliance-trail loss. Log
    // alone is not enough because Vercel alert rules attach to OTel
    // counters not log strings.
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
      },
      'cron.renewals.at_risk.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('at_risk_recompute');
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Round-4 C2 — shared gate covers Bearer verify + 429 rate-limit +
  // 401 with `cron_bearer_auth_rejected` audit emit. Pre-extraction
  // each coordinator inlined this; lapse + reconcile coordinators
  // 401'd silently with no audit (Constitution Principle I clause 4
  // violation). Now uniform across all 3 routes.
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/at-risk-recompute-coordinator',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('at_risk_recompute'),
  });
  if (authResponse) return authResponse;

  // ----- Kill-switch gates -----------------------------------------------
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  // Phase 9 / T241 — READ_ONLY_MODE short-circuit (200 + skipped, no
  // audit) so cron-job.org does not retry-storm during maintenance.
  // See dispatch-coordinator for the full rationale.
  if (env.flags.readOnlyMode) {
    // Phase 9 verify-fix — emit observability signal (see dispatch-
    // coordinator for full rationale).
    renewalsMetrics.coordinatorSkippedReadOnly('at_risk_recompute');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }
  if (env.features.f8AtRiskDisabled) {
    return NextResponse.json(
      { skipped: true, reason: 'at_risk_disabled' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const startedAt = Date.now();

  // Resolve active tenants. MVP single-tenant = [env.tenant.slug].
  const activeTenants: ReadonlyArray<string> = [env.tenant.slug];

  // Edge case: zero-tenant cron pass — emit one audit with
  // tenants_enqueued=0 + return 200 (matches dispatch-coordinator
  // CHK032 behaviour).
  if (activeTenants.length === 0) {
    const summary: OrchestratedSummary = {
      tenants_enqueued: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      tenants_skipped_kill_switch: 0,
      duration_ms: Date.now() - startedAt,
    };
    await emitOrchestratedAudit(env.tenant.slug, summary, [], correlationId);
    return NextResponse.json({
      skipped: false,
      ...summary,
      per_tenant_results: [],
    });
  }

  // Fan-out via internal fetch.
  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async () => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/at-risk-recompute/${encodeURIComponent(tenantId)}`,
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
              contentType: r.headers.get('content-type'),
              correlationId,
            },
            'cron.renewals.at_risk.coordinator.json_parse_failed',
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
        members_recomputed:
          typeof r.value.json.members_recomputed === 'number'
            ? r.value.json.members_recomputed
            : 0,
        members_skipped_below_tenure:
          typeof r.value.json.members_skipped_below_tenure === 'number'
            ? r.value.json.members_skipped_below_tenure
            : 0,
        members_failed:
          typeof r.value.json.members_failed === 'number'
            ? r.value.json.members_failed
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
        'cron.renewals.at_risk.coordinator.tenant_fetch_rejected',
      );
      return { tenant_id: tenantId, error: reasonStr };
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
      'cron.renewals.at_risk.coordinator.tenant_http_error',
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

  await emitOrchestratedAudit(
    env.tenant.slug,
    summary,
    perTenantResults,
    correlationId,
  );

  logger.info(
    { correlationId, ...summary },
    'cron.renewals.at_risk.coordinator.complete',
  );

  return NextResponse.json({
    skipped: false,
    ...summary,
    per_tenant_results: perTenantResults,
  });
}
