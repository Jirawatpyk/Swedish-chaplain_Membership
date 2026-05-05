/**
 * F8 Phase 4 Wave I5 / T103 — Daily reminder dispatch coordinator.
 *
 * Triggered DAILY at 06:00 Asia/Bangkok by cron-job.org per
 * `docs/runbooks/cron-jobs.md` F8 entry. Resolves the set of active
 * tenants, fans out to per-tenant `/api/cron/renewals/dispatch/[tenantId]`
 * routes via internal HTTP, aggregates results, emits
 * `cron_dispatch_orchestrated` audit, returns a summary.
 *
 * Architecture (per `contracts/cron-renewals-api.md` + research.md R14):
 *   - coordinator + per-tenant fan-out keeps each per-tenant
 *     invocation in its OWN Vercel function instance with its own
 *     300s budget. Per-tenant SLO < 60s @ 5k members per FR-017
 *     fits comfortably under one function timeout.
 *   - Promise.allSettled isolates per-tenant failures — a single
 *     tenant's error doesn't block others.
 *   - FR-011 idempotency on the dispatch use-case means retries on
 *     the next cron pass are safe (no duplicate sends).
 *
 * MVP single-tenant: "active tenants" = `[env.tenant.slug]`. Post-F10
 * SaaS multi-tenant would query a real tenants table.
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check via
 * shared `verifyCronBearer` helper). Mismatched/missing → 401.
 *
 * Kill-switch: `FEATURE_F8_RENEWALS=false` returns 200 +
 * `{skipped: true, reason: 'feature_flag_disabled'}` so cron-job.org
 * does NOT retry-storm a dark-launch period.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { requestIdFromHeaders } from '@/lib/request-id';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface PerTenantResultOk {
  readonly tenant_id: string;
  readonly skipped: boolean;
  readonly reminders_dispatched?: number;
  readonly tasks_created?: number;
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
  readonly duration_ms: number;
}

/**
 * Emit the `cron_dispatch_orchestrated` audit on the bookkeeping
 * tenant (env.tenant.slug). Wrapped in try/catch + WARN log — audit
 * emit failure must NOT break the coordinator response.
 */
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
          tenants_enqueued: summary.tenants_enqueued,
          tenants_succeeded: summary.tenants_succeeded,
          tenants_failed: summary.tenants_failed,
          duration_ms: summary.duration_ms,
          // bounded-cardinality summary — no PII in the per-tenant payload.
          per_tenant_summaries: perTenantResults.map((r) =>
            'error' in r
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped,
                  reminders_dispatched: r.reminders_dispatched ?? 0,
                  tasks_created: r.tasks_created ?? 0,
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
    logger.warn(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
      },
      'cron.renewals.coordinator.audit_emit_failed',
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Constant-time Bearer check (matches F4/F5/F7 cron pattern).
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // Kill-switch — returns 200 + skipped (no audit emit). cron-job.org
  // does NOT retry-storm on 200.
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const correlationId = requestIdFromHeaders(request.headers);

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_dispatch_coordinator',
    {
      'cron.endpoint': 'dispatch-coordinator',
    },
    async (span) => {
      const startedAt = Date.now();

      // Resolve active tenants. MVP single-tenant = [env.tenant.slug].
      // Post-F10 SaaS would query a tenants table here.
      const activeTenants: ReadonlyArray<string> = [env.tenant.slug];
      span.setAttribute('renewals.tenants_enqueued', activeTenants.length);

      // Edge case: zero-tenant cron pass (Edge Cases CHK032 in spec.md
      // — "when a coordinator iterates and finds zero active tenants…
      // return 200 with tenants_enqueued: 0 and emit a single
      // cron_dispatch_orchestrated audit with tenants_enqueued: 0").
      if (activeTenants.length === 0) {
        const summary: OrchestratedSummary = {
          tenants_enqueued: 0,
          tenants_succeeded: 0,
          tenants_failed: 0,
          duration_ms: Date.now() - startedAt,
        };
        await emitOrchestratedAudit(
          env.tenant.slug,
          summary,
          [],
          correlationId,
        );
        return NextResponse.json({
          skipped: false,
          ...summary,
          per_tenant_results: [],
        });
      }

      // Fan-out via internal fetch with Promise.allSettled. The
      // `env.app.baseUrl` is the same Vercel deployment URL — Vercel
      // routes the request to a fresh function instance per fetch, so
      // each tenant's work runs in its own 300s budget.
      const baseUrl = env.app.baseUrl;
      const cronSecret = env.cron.secret;

      const settled = await Promise.allSettled(
        activeTenants.map((tenantId) =>
          (async () => {
            const r = await fetch(
              `${baseUrl}/api/cron/renewals/dispatch/${encodeURIComponent(tenantId)}`,
              {
                method: 'POST',
                headers: {
                  Authorization: `Bearer ${cronSecret}`,
                  'x-request-id': correlationId,
                },
              },
            );
            const json = (await r.json().catch(() => ({}))) as Record<
              string,
              unknown
            >;
            return { tenantId, ok: r.ok, status: r.status, json };
          })(),
        ),
      );

      const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
        const tenantId = activeTenants[i]!;
        if (r.status === 'fulfilled' && r.value.ok) {
          return {
            tenant_id: tenantId,
            skipped: Boolean(r.value.json.skipped),
            reminders_dispatched:
              typeof r.value.json.reminders_dispatched === 'number'
                ? r.value.json.reminders_dispatched
                : 0,
            tasks_created:
              typeof r.value.json.tasks_created === 'number'
                ? r.value.json.tasks_created
                : 0,
            duration_ms:
              typeof r.value.json.duration_ms === 'number'
                ? r.value.json.duration_ms
                : 0,
          };
        }
        if (r.status === 'rejected') {
          return { tenant_id: tenantId, error: String(r.reason) };
        }
        return {
          tenant_id: tenantId,
          error: `http_${r.value.status}`,
        };
      });

      const tenantsSucceeded = perTenantResults.filter(
        (r): r is PerTenantResultOk => !('error' in r),
      ).length;
      const tenantsFailed = perTenantResults.length - tenantsSucceeded;

      const summary: OrchestratedSummary = {
        tenants_enqueued: activeTenants.length,
        tenants_succeeded: tenantsSucceeded,
        tenants_failed: tenantsFailed,
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

      logger.info(
        {
          correlationId,
          ...summary,
        },
        'cron.renewals.coordinator.complete',
      );

      return NextResponse.json({
        skipped: false,
        ...summary,
        per_tenant_results: perTenantResults,
      });
    },
  );
}
