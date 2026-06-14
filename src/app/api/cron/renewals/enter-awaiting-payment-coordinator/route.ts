/**
 * F8-completion slice 2 · Task 2.4 — Daily enter-awaiting-payment (T-0)
 * coordinator.
 *
 * Triggered DAILY (at/after T-0, before the lapse coordinator) by
 * cron-job.org. Walks every active tenant's cycles in
 * `upcoming`/`reminded` whose `expires_at <= now` and flips them to
 * `awaiting_payment` so the member self-service confirm + paid-completion
 * paths become reachable.
 *
 * Sequenced BEFORE `lapse-cycles-on-grace-expiry-coordinator`: a cycle
 * must become `awaiting_payment` HERE at T-0 before the lapse cron can
 * (later, after grace) consider it. The two crons compose: enter →
 * awaiting_payment, later lapse → lapsed.
 *
 * Architecture mirrors `lapse-cycles-on-grace-expiry-coordinator` — fans
 * out via internal HTTP to per-tenant routes for own-budget isolation.
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check).
 *
 * Kill-switch: `FEATURE_F8_RENEWALS=false` returns 200 + skipped.
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

interface PerTenantResult {
  readonly tenant_id: string;
  readonly skipped?: boolean;
  readonly cycles_processed?: number;
  readonly flipped?: number;
  readonly race_skipped?: number;
  readonly errors?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Shared bearer-auth gate emits the `cron_bearer_auth_rejected` audit
  // + IP rate-limit on rejection (uniform across all F8 cron coords).
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/enter-awaiting-payment-coordinator',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('enter_awaiting'),
    // Upstash fail-open counter — parity with the other coordinators.
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (authResponse) return authResponse;

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  // READ_ONLY_MODE short-circuit (200 + skipped, no audit) so
  // cron-job.org does not retry-storm during maintenance. See
  // lapse-coordinator for the full rationale.
  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('enter_awaiting');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_enter_awaiting_coordinator',
    { 'cron.endpoint': 'enter-awaiting-payment-coordinator' },
    async (span) => {
  const startedAt = Date.now();

  // Resolve active tenants (MVP single-tenant = [env.tenant.slug]).
  const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
  span.setAttribute('renewals.tenants_enqueued', activeTenants.length);

  if (activeTenants.length === 0) {
    const summary = {
      tenants_enqueued: 0,
      tenants_succeeded: 0,
      tenants_failed: 0,
      duration_ms: Date.now() - startedAt,
    };
    try {
      const deps = makeRenewalsDeps(env.tenant.slug);
      await deps.auditEmitter.emit(
        {
          type: 'cron_dispatch_orchestrated',
          payload: {
            cron_kind: 'enter_awaiting',
            ...summary,
            tenants_skipped_kill_switch: 0,
            per_tenant_summaries: [],
          },
        },
        {
          tenantId: env.tenant.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          requestId: correlationId,
        },
      );
    } catch (e) {
      logger.error(
        { err: e instanceof Error ? e : new Error(String(e)), correlationId },
        'cron.renewals.enter-awaiting.coordinator.audit_emit_failed',
      );
      renewalsMetrics.coordinatorAuditEmitFailed('enter_awaiting');
    }
    renewalsMetrics.coordinatorTenantsEnqueued('enter_awaiting', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('enter_awaiting', 0);
    renewalsMetrics.coordinatorDurationMs('enter_awaiting', summary.duration_ms);
    return NextResponse.json({ ...summary, per_tenant_results: [] });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const numFromJson = (
    json: Record<string, unknown>,
    key: string,
  ): number => (typeof json[key] === 'number' ? (json[key] as number) : 0);

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async (): Promise<PerTenantResult> => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/enter-awaiting-payment/${encodeURIComponent(tenantId)}`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${cronSecret}`,
              'x-request-id': correlationId,
            },
          },
        );
        let json: Record<string, unknown> = {};
        try {
          json = (await r.json()) as Record<string, unknown>;
        } catch {
          return {
            tenant_id: tenantId,
            error: `http_${r.status}_json_parse_failed`,
          };
        }
        if (!r.ok) {
          return { tenant_id: tenantId, error: `http_${r.status}` };
        }
        return {
          tenant_id: tenantId,
          skipped: Boolean(json.skipped),
          cycles_processed: numFromJson(json, 'cycles_processed'),
          flipped: numFromJson(json, 'flipped'),
          race_skipped: numFromJson(json, 'race_skipped'),
          errors: numFromJson(json, 'errors'),
          duration_ms: numFromJson(json, 'duration_ms'),
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'rejected') {
      // Do NOT persist `String(r.reason)` into audit_log — it leaks DB
      // connection strings, column names, internal stack frames into
      // immutable audit rows. Use a fixed taxonomy.
      logger.error(
        {
          err: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
          tenant_id: tenantId,
          correlationId,
        },
        'cron.renewals.enter-awaiting.coordinator.per_tenant_fetch_rejected',
      );
      return { tenant_id: tenantId, error: 'fetch_rejected' };
    }
    return r.value;
  });

  const tenantsSucceeded = perTenantResults.filter(
    (r) => r.error === undefined,
  ).length;
  const tenantsFailed = perTenantResults.length - tenantsSucceeded;
  // Surface tenants that returned 200-OK but had per-cycle errors so a
  // tenant whose transition consistently throws does not appear "100%
  // healthy" while no cycles actually flipped.
  const tenantsWithErrors = perTenantResults.filter(
    (r) => r.error === undefined && (r.errors ?? 0) > 0,
  ).length;

  const summary = {
    tenants_enqueued: activeTenants.length,
    tenants_succeeded: tenantsSucceeded,
    tenants_failed: tenantsFailed,
    tenants_skipped_kill_switch: 0,
    duration_ms: Date.now() - startedAt,
  };

  span.setAttribute('renewals.tenants_succeeded', tenantsSucceeded);
  span.setAttribute('renewals.tenants_failed', tenantsFailed);
  span.setAttribute('renewals.duration_ms', summary.duration_ms);

  try {
    const deps = makeRenewalsDeps(env.tenant.slug);
    await deps.auditEmitter.emit(
      {
        type: 'cron_dispatch_orchestrated',
        payload: {
          cron_kind: 'enter_awaiting',
          ...summary,
          per_tenant_summaries: perTenantResults.map((r) =>
            r.error !== undefined
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped ?? false,
                  reminders_dispatched: r.cycles_processed ?? 0,
                  // This cron creates no tasks — set the legacy slot to 0
                  // and surface the real counters in `kind_specific`.
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'enter_awaiting',
                    errors: r.errors ?? 0,
                    flipped: r.flipped ?? 0,
                    race_skipped: r.race_skipped ?? 0,
                  },
                },
          ),
        },
      },
      {
        tenantId: env.tenant.slug,
        actorUserId: null,
        actorRole: 'cron',
        correlationId,
        requestId: correlationId,
      },
    );
  } catch (e) {
    logger.error(
      { err: e instanceof Error ? e : new Error(String(e)), correlationId },
      'cron.renewals.enter-awaiting.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('enter_awaiting');
  }

  renewalsMetrics.coordinatorTenantsEnqueued('enter_awaiting', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('enter_awaiting', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('enter_awaiting', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('enter_awaiting', summary.duration_ms);

  logger.info(
    {
      correlationId,
      ...summary,
      tenants_with_errors: tenantsWithErrors,
    },
    'cron.renewals.enter-awaiting.coordinator.complete',
  );

  return NextResponse.json({
    ...summary,
    tenants_with_errors: tenantsWithErrors,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
