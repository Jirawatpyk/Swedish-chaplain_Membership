/**
 * 107-auto-invoice Task 8 — Daily auto-draft cron coordinator.
 *
 * Triggered DAILY (05:00 ICT, before the 06:00 ICT dispatch chain —
 * see `vercel.json`) by Vercel-native cron. Fans out via internal HTTP
 * to `auto-draft/[tenantId]` for own-budget isolation, mirroring every
 * other F8 coordinator (`enter-awaiting-payment-coordinator` template).
 *
 * Sequenced BEFORE the reminder-dispatch chain: a member's fresh
 * `origin='auto_renewal'` DRAFT invoice should exist before the day's
 * reminder pass runs, so a treasurer working the review queue is never
 * racing the dispatcher. (The two cron chains are otherwise
 * independent — auto-draft creates a draft invoice, dispatch sends
 * reminder emails; neither depends on the other's OUTPUT, only the
 * ordering avoids a same-day treasurer/dispatch surprise.)
 *
 * Auth: Bearer via `CRON_SECRET` env var (constant-time check).
 *
 * Three-key dark-ship (design §5.7) — env layer: BOTH
 * `FEATURE_F8_RENEWALS` and `FEATURE_AUTO_INVOICE` must be `true`, else
 * `200 {skipped: true}` (never 503 — Vercel/cron must not retry-storm).
 * Key #3 (`tenant_invoice_settings.auto_invoice_enabled` + cadence) is
 * enforced per-tenant inside the worker's use-case call (Task 7).
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
  readonly drafted?: number;
  readonly skipped_existing?: number;
  readonly skipped_race_lost?: number;
  readonly skipped_terminated?: number;
  readonly errors?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and any manual/legacy POST trigger.
// POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Shared bearer-auth gate emits the `cron_bearer_auth_rejected` audit
  // + IP rate-limit on rejection (uniform across all F8 cron coords).
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/auto-draft-coordinator',
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('auto_draft'),
    // Upstash fail-open counter — parity with the other coordinators.
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (authResponse) return authResponse;

  if (!env.features.f8Renewals || !env.features.autoInvoice) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  // READ_ONLY_MODE short-circuit (200 + skipped, no audit) so
  // cron-job.org / Vercel cron does not retry-storm during maintenance.
  // See lapse-coordinator for the full rationale.
  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('auto_draft');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_auto_draft_coordinator',
    { 'cron.endpoint': 'auto-draft-coordinator' },
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
            cron_kind: 'auto_draft',
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
        'cron.renewals.auto-draft.coordinator.audit_emit_failed',
      );
      renewalsMetrics.coordinatorAuditEmitFailed('auto_draft');
    }
    renewalsMetrics.coordinatorTenantsEnqueued('auto_draft', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('auto_draft', 0);
    renewalsMetrics.coordinatorDurationMs('auto_draft', summary.duration_ms);
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
          `${baseUrl}/api/cron/renewals/auto-draft/${encodeURIComponent(tenantId)}`,
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
          drafted: numFromJson(json, 'drafted'),
          skipped_existing: numFromJson(json, 'skipped_existing'),
          skipped_race_lost: numFromJson(json, 'skipped_race_lost'),
          skipped_terminated: numFromJson(json, 'skipped_terminated'),
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
        'cron.renewals.auto-draft.coordinator.per_tenant_fetch_rejected',
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
  // healthy" while no cycles actually drafted.
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
          cron_kind: 'auto_draft',
          ...summary,
          per_tenant_summaries: perTenantResults.map((r) =>
            r.error !== undefined
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped ?? false,
                  // This cron creates no reminder tasks — repurpose the
                  // legacy slot to carry the cycles-processed count
                  // (matches the `enter_awaiting` coordinator's
                  // precedent); the real counters live in `kind_specific`.
                  reminders_dispatched: r.cycles_processed ?? 0,
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'auto_draft',
                    errors: r.errors ?? 0,
                    drafted: r.drafted ?? 0,
                    // The `auto_draft` kind_specific shape carries one
                    // aggregate `skipped` counter (no per-reason
                    // breakdown) — sum the use-case's 3 named skip
                    // buckets.
                    skipped:
                      (r.skipped_existing ?? 0) +
                      (r.skipped_race_lost ?? 0) +
                      (r.skipped_terminated ?? 0),
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
      'cron.renewals.auto-draft.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('auto_draft');
  }

  renewalsMetrics.coordinatorTenantsEnqueued('auto_draft', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('auto_draft', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('auto_draft', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('auto_draft', summary.duration_ms);

  logger.info(
    {
      correlationId,
      ...summary,
      tenants_with_errors: tenantsWithErrors,
    },
    'cron.renewals.auto-draft.coordinator.complete',
  );

  return NextResponse.json({
    ...summary,
    tenants_with_errors: tenantsWithErrors,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
