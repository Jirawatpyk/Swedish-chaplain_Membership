/**
 * F8 Phase 5 wave K24 · T115a — Daily lapse-cycles-on-grace-expiry
 * coordinator.
 *
 * Triggered DAILY at 06:30 Asia/Bangkok by cron-job.org. Walks every
 * active tenant's cycles in `awaiting_payment` whose
 * `expires_at + grace_period_days < now` and transitions them to
 * `lapsed` with the **specific** `closed_reason` discriminator
 * (`grace_expired` vs `payment_failed`) per FR-004 + AS3.
 *
 * Sequenced 30 min BEFORE `reconcile-pending-reactivations-coordinator`
 * (07:00) so that any cycle that JUST crossed the grace boundary
 * doesn't get a reminder email out of the dispatcher (which runs
 * earlier at 06:00) immediately followed by a lapse-transition —
 * the lapse-transition tx wins the day's race because the dispatcher
 * has already finished its pass for the day.
 *
 * Architecture mirrors `reconcile-pending-reactivations-coordinator`
 * (T139) — fans out via internal HTTP to per-tenant routes for
 * own-budget isolation.
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
  readonly grace_expired?: number;
  readonly payment_failed?: number;
  readonly transition_race_skipped?: number;
  // 065 §5.2 (final-review V8) — forwarded from the per-tenant route so
  // the coordinator's response (the surface cron-job.org retains) can
  // reconcile the SC sum invariant now that `cycles_processed` counts the
  // whole awaiting_payment cohort, most of which defers on any given day.
  readonly deferred_invoice_not_due?: number;
  readonly deferred_within_termination_window?: number;
  readonly deferred_no_invoice_backstop?: number;
  /** 066 §3.2(3) — dormancy-guard deferrals (no statutory warning yet). */
  readonly deferred_no_prior_warning?: number;
  readonly deferred_guard_errors?: number;
  readonly errors?: number;
  readonly duration_ms?: number;
  readonly error?: string;
}

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Round-4 review-finding C2 — shared bearer-auth gate emits the
  // `cron_bearer_auth_rejected` audit + IP rate-limit on rejection
  // (prior implementation 401'd silently; round-3 review found 2 of 3
  // coordinators missing this; now uniform across all 3 cron coords).
  const authResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('lapse'),
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
    renewalsMetrics.coordinatorSkippedReadOnly('lapse');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();

  return withActiveSpan(
    renewalsTracer(),
    'cron_renewal_lapse_coordinator',
    { 'cron.endpoint': 'lapse-cycles-on-grace-expiry-coordinator' },
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
            cron_kind: 'lapse',
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
        'cron.renewals.lapse-cycles.coordinator.audit_emit_failed',
      );
      renewalsMetrics.coordinatorAuditEmitFailed('lapse');
    }
    renewalsMetrics.coordinatorTenantsEnqueued('lapse', 0);
    renewalsMetrics.coordinatorTenantsSucceeded('lapse', 0);
    renewalsMetrics.coordinatorDurationMs('lapse', summary.duration_ms);
    return NextResponse.json({ ...summary, per_tenant_results: [] });
  }

  const baseUrl = env.app.baseUrl;
  const cronSecret = env.cron.secret;

  // Round 5 staff-review (K24-Simplify-S1): local helper to dedupe
  // the 6× `typeof json.X === 'number' ? json.X : 0` ternaries.
  // Same pattern can be lifted to a shared helper if more F8 cron
  // coordinators adopt the convention; kept inline for now.
  const numFromJson = (
    json: Record<string, unknown>,
    key: string,
  ): number => (typeof json[key] === 'number' ? (json[key] as number) : 0);

  const settled = await Promise.allSettled(
    activeTenants.map((tenantId) =>
      (async (): Promise<PerTenantResult> => {
        const r = await fetch(
          `${baseUrl}/api/cron/renewals/lapse-cycles-on-grace-expiry/${encodeURIComponent(tenantId)}`,
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
          grace_expired: numFromJson(json, 'grace_expired'),
          payment_failed: numFromJson(json, 'payment_failed'),
          transition_race_skipped: numFromJson(json, 'transition_race_skipped'),
          deferred_invoice_not_due: numFromJson(json, 'deferred_invoice_not_due'),
          deferred_within_termination_window: numFromJson(
            json,
            'deferred_within_termination_window',
          ),
          deferred_no_prior_warning: numFromJson(
            json,
            'deferred_no_prior_warning',
          ),
          deferred_no_invoice_backstop: numFromJson(
            json,
            'deferred_no_invoice_backstop',
          ),
          deferred_guard_errors: numFromJson(json, 'deferred_guard_errors'),
          errors: numFromJson(json, 'errors'),
          duration_ms: numFromJson(json, 'duration_ms'),
        };
      })(),
    ),
  );

  const perTenantResults: PerTenantResult[] = settled.map((r, i) => {
    const tenantId = activeTenants[i]!;
    if (r.status === 'rejected') {
      // Round-4 review-finding H1: do NOT persist `String(r.reason)`
      // into audit_log — the same pattern R4-W2 fixed in
      // cancel-cycle.ts + mark-paid-offline.ts leaks DB connection
      // strings, column names, internal stack frames into immutable
      // audit rows. Use a fixed taxonomy + a categorise() helper.
      logger.error(
        {
          err: r.reason instanceof Error ? r.reason : new Error(String(r.reason)),
          tenant_id: tenantId,
          correlationId,
        },
        'cron.renewals.lapse-cycles.coordinator.per_tenant_fetch_rejected',
      );
      return { tenant_id: tenantId, error: 'fetch_rejected' };
    }
    return r.value;
  });

  const tenantsSucceeded = perTenantResults.filter(
    (r) => r.error === undefined,
  ).length;
  const tenantsFailed = perTenantResults.length - tenantsSucceeded;
  // Round 5 staff-review (K24-Errors-S1): surface tenants that
  // returned 200-OK but had per-cycle errors. Without this, a tenant
  // whose F5 bridge consistently throws (DB blip, RLS misconfig)
  // returns `errors === cycles_processed` per run but appears in
  // `tenants_succeeded` — SRE alert rules reading the success ratio
  // see "100% healthy" while no cycles actually transitioned. Alert
  // dashboards on `tenants_with_errors > 0` in addition to the
  // tenants_failed gauge.
  const tenantsWithErrors = perTenantResults.filter(
    (r) => r.error === undefined && (r.errors ?? 0) > 0,
  ).length;

  // TODO(round-5 M3): the typed `cron_dispatch_orchestrated` payload
  // re-purposes `tasks_created` for 3 different counters across the 4
  // coordinators (dispatch=tasks created · lapse=per-cycle errors ·
  // reconcile=F5 refund failures · at-risk=members failed). SRE
  // dashboards aggregating on this field get nonsense values. Per-
  // cron-kind discriminator (e.g. `kind_specific: { errors?, refund_
  // failures?, members_failed? }`) is invasive (changes the audit
  // payload schema; backfill needed) — defer to F8 Phase 7 audit
  // schema cleanup. Tracked at `phase-10-backlog.md`.
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
          cron_kind: 'lapse',
          ...summary,
          per_tenant_summaries: perTenantResults.map((r) =>
            r.error !== undefined
              ? { tenant_id: r.tenant_id, error: r.error }
              : {
                  tenant_id: r.tenant_id,
                  skipped: r.skipped ?? false,
                  reminders_dispatched: r.cycles_processed ?? 0,
                  // Round-5 review-finding M3: stop overloading
                  // `tasks_created` with per-cycle errors. Set to 0
                  // (lapse cron creates no tasks) and surface the
                  // counter in the typed `kind_specific` slot below.
                  tasks_created: 0,
                  duration_ms: r.duration_ms ?? 0,
                  kind_specific: {
                    kind: 'lapse',
                    errors: r.errors ?? 0,
                    grace_expired: r.grace_expired ?? 0,
                    payment_failed: r.payment_failed ?? 0,
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
      'cron.renewals.lapse-cycles.coordinator.audit_emit_failed',
    );
    renewalsMetrics.coordinatorAuditEmitFailed('lapse');
  }

  // W0-09: § 23.1.3 coordinator-level metrics.
  renewalsMetrics.coordinatorTenantsEnqueued('lapse', summary.tenants_enqueued);
  renewalsMetrics.coordinatorTenantsSucceeded('lapse', summary.tenants_succeeded);
  if (summary.tenants_failed > 0) {
    renewalsMetrics.coordinatorTenantsFailed('lapse', summary.tenants_failed);
  }
  renewalsMetrics.coordinatorDurationMs('lapse', summary.duration_ms);

  logger.info(
    {
      correlationId,
      ...summary,
      tenants_with_errors: tenantsWithErrors,
    },
    'cron.renewals.lapse-cycles.coordinator.complete',
  );

  return NextResponse.json({
    ...summary,
    tenants_with_errors: tenantsWithErrors,
    per_tenant_results: perTenantResults,
  });
  }); // end withActiveSpan
}
