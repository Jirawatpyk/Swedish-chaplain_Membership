/**
 * F8 Phase 5 Wave C · T139 — Daily reconcile-pending-reactivations
 * coordinator.
 *
 * Triggered DAILY at 07:00 Asia/Bangkok by cron-job.org per
 * `docs/runbooks/cron-jobs.md` F8 entry. Walks every active tenant's
 * cycles in `pending_admin_reactivation` and:
 *   - Emits T-7 / T-3 / T-1 reminder ladder audits at days 23 / 27 / 29
 *   - Auto-times-out at >= 30 days: cancels cycle + refunds via F5
 *
 * Architecture mirrors `dispatch-coordinator/route.ts` (T103) — the
 * coordinator fans out to per-tenant routes via internal HTTP so each
 * tenant's reconcile runs in its own Vercel function instance with
 * its own 300s budget. MVP single-tenant simplifies to one fanout.
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
  readonly reminders_t7?: number;
  readonly reminders_t3?: number;
  readonly reminders_t1?: number;
  readonly timed_out?: number;
  readonly timeout_refund_failures?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Round-4 review-finding C2 — shared bearer-auth gate; see
  // `at-risk-recompute-coordinator/route.ts` for rationale.
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/reconcile-pending-reactivations-coordinator',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('reconcile'),
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
  // Phase 9 / T241 — READ_ONLY_MODE short-circuit (200 + skipped, no
  // audit) so cron-job.org does not retry-storm during maintenance.
  // See dispatch-coordinator for the full rationale.
  if (env.flags.readOnlyMode) {
    // Phase 9 verify-fix — emit observability signal.
    renewalsMetrics.coordinatorSkippedReadOnly('reconcile');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_reconcile_coordinator',
    { 'cron.endpoint': 'reconcile-pending-reactivations-coordinator' },
    async (span) => {
  const startedAt = Date.now();

  // Resolve active tenants (MVP single-tenant = [env.tenant.slug];
  // post-F10 SaaS would query a tenants table here).
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
            cron_kind: 'reconcile',
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
        'cron.renewals.reconcile-pending.coordinator.audit_emit_failed',
      );
      renewalsMetrics.coordinatorAuditEmitFailed('reconcile');
    }
    renewalsMetrics.coordinatorTenantsEnqueued('reconcile', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('reconcile', 0);
    renewalsMetrics.coordinatorDurationMs('reconcile', summary.duration_ms);
    return NextResponse.json({ ...summary, per_tenant_results: [] });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async (): Promise<PerTenantResult> => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/reconcile-pending-reactivations/${encodeURIComponent(tenantId)}`,
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
          cycles_processed:
            typeof json.cycles_processed === 'number'
              ? json.cycles_processed
              : 0,
          reminders_t7:
            typeof json.reminders_t7 === 'number' ? json.reminders_t7 : 0,
          reminders_t3:
            typeof json.reminders_t3 === 'number' ? json.reminders_t3 : 0,
          reminders_t1:
            typeof json.reminders_t1 === 'number' ? json.reminders_t1 : 0,
          timed_out: typeof json.timed_out === 'number' ? json.timed_out : 0,
          timeout_refund_failures:
            typeof json.timeout_refund_failures === 'number'
              ? json.timeout_refund_failures
              : 0,
          duration_ms:
            typeof json.duration_ms === 'number' ? json.duration_ms : 0,
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'rejected') {
      // Round-4 review-finding H1: same pattern as lapse coordinator
      // — log the raw error to pino (server-side only) but persist
      // a fixed-taxonomy literal into audit_log to prevent PII /
      // connection-string leak (mirror of R4-W2 fix in cancel-cycle).
      logger.error(
        {
          err: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
          tenant_id: tenantId,
          correlationId,
        },
        'cron.renewals.reconcile-pending.coordinator.per_tenant_fetch_rejected',
      );
      return { tenant_id: tenantId, error: 'fetch_rejected' };
    }
    return r.value;
  });

  const tenantsSucceeded = perTenantResults.filter(
    (r) => r.error === undefined,
  ).length;
  const tenantsFailed = perTenantResults.length - tenantsSucceeded;

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
          cron_kind: 'reconcile',
          ...summary,
          per_tenant_summaries: perTenantResults.map((r) =>
            r.error !== undefined
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped ?? false,
                  reminders_dispatched: r.cycles_processed ?? 0,
                  // Round-5 review-finding M3: stop overloading
                  // `tasks_created` with refund-failures. Set to 0
                  // (reconcile cron creates no tasks) and surface
                  // the counter in the typed `kind_specific` slot.
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'reconcile',
                    refund_failures: r.timeout_refund_failures ?? 0,
                    timed_out: r.timed_out ?? 0,
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
      'cron.renewals.reconcile-pending.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('reconcile');
  }

  // W0-09: § 23.1.3 coordinator-level metrics.
  renewalsMetrics.coordinatorTenantsEnqueued('reconcile', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('reconcile', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('reconcile', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('reconcile', summary.duration_ms);

  logger.info(
    {
      correlationId,
      ...summary,
    },
    'cron.renewals.reconcile-pending.coordinator.complete',
  );

  return NextResponse.json({
    ...summary,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
