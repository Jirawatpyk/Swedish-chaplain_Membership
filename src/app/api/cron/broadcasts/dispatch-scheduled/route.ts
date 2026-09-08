/**
 * F7 US2 cron worker — POST `/api/cron/broadcasts/dispatch-scheduled`.
 *
 * Triggered every 5 min by cron-job.org (per docs/runbooks/cron-jobs.md).
 *
 * Auth: Bearer token via `CRON_SECRET` (matches F4 outbox-dispatch).
 *
 * Concurrency model (review C2 — 2026-04-30; clarified post-staff-review
 * 2026-05-01):
 *   - Eligible-row scan uses `FOR UPDATE SKIP LOCKED` to skip rows
 *     ALREADY held by another concurrent scan. **The row lock is
 *     released the moment `runInTenant` returns** (tx ends at line 69),
 *     so SKIP LOCKED only protects against two ticks racing to read the
 *     SAME eligibility batch — it does NOT protect the per-row dispatch
 *     window against another tick that arrives after this one's tx
 *     ended but before the dispatch use-case's own tx starts.
 *   - The authoritative dispatch-time concurrency guard is the per-row
 *     `pg_advisory_xact_lock('broadcasts:'+tenant+':'+id)` acquired
 *     inside the use-case's `withTx` — that lock survives the entire
 *     dispatch tx and is what closes the TOCTOU window between cron +
 *     manual admin send-now. SKIP LOCKED here is a small additional
 *     defence against eligible-scan duplication, not the primary guard.
 *
 * RLS context: the eligible scan runs with `runInTenant(tenant.slug)` so
 * RLS+FORCE policies apply (Constitution Principle I clause 1 — every
 * read goes through tenant isolation, even cron paths).
 *
 * Single-tenant SweCham MVP — runs against the deployed tenant slug.
 * Future SaaS multi-tenant: iterate tenant catalogue (deferred to F10).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import {
  asBroadcastId,
  dispatchScheduledBroadcast,
  makeDispatchScheduledBroadcastDeps,
  makeTickMemoizedMembersBridge,
  isF7ImportAudienceEnabled,
  buildAudienceTick,
  makeBuildAudienceTickDeps,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

const MAX_PER_TICK = 50;

// Parity with reconcile + prune cron routes: pin Node.js runtime
// explicitly. verifyCronBearer + Drizzle/Neon + advisory locks all
// require Node APIs (node:crypto, pg net socket); a future Edge default
// would silently break dispatch.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// BUG-028: give the audience sync the full function budget. Resend's Contacts
// API is one-at-a-time; the account limit is 10 req/s (measured 2026-09-08,
// T095 — this comment previously said 2), but the loop is serial so it runs at
// `min(10, 1/RTT)` ≈ 3.4 req/s on a ~0.29 s warm round trip. A ~130-recipient
// broadcast therefore syncs in ~40 s, and ~1,000 contacts is what one 300 s
// tick can drain — the gateway's reactive 429 backoff (no fixed pacing) never
// fires at that rate. (Genuinely huge audiences
// still need the batched multi-tick model; this covers SweCham scale +
// moderate growth without the fixed-pacing timeout that was rejected in
// review.)
export const maxDuration = 300;

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and the legacy cron-job.org trigger (POST)
// during migration. POST is hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  // Verify-fix R3 (Code-M2, 2026-05-02): constant-time Bearer check
  // via shared `verifyCronBearer` helper (matches F4 outbox + F5
  // sweep-stale-pending-refunds). Avoids timing side-channel.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // Verify-fix R3 (Errors-H2, 2026-05-02): kill-switch check — without
  // this, a feature-flag rollback would NOT stop in-flight `approved`
  // broadcasts from going out (cron picks them up, calls Resend, sends
  // real emails, consumes member quota). Returns 200 + {skipped:true}
  // so cron-job.org does NOT retry-storm a dark-launch period.
  //
  // R7 staff-review LOW-F fix — moved kill-switch check BEFORE tenant
  // resolution. `resolveTenantFromRequest` is currently a pure header
  // lookup (no DB call), but ordering kill-switch first establishes
  // the convention that disabled-feature cron ticks do zero work
  // beyond auth + flag check, regardless of how heavy tenant
  // resolution becomes in the future. We use the `request` headers
  // for tenant slug just before metric emission to keep the
  // observability label-cardinality bounded.
  if (!env.features.f7Broadcasts) {
    const tenantSlug = resolveTenantFromRequest(request).slug;
    logger.info(
      { tenantId: tenantSlug },
      'cron.broadcasts.dispatch.feature_disabled',
    );
    broadcastsMetrics.cronSkippedCount(tenantSlug, 'kill_switch');
    return NextResponse.json(
      { skipped: true, reason: 'feature_disabled' },
      { status: 200 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const tenant = asTenantContext(tenantCtx.slug);

  // Eligible-row pick goes through `runInTenant` so RLS+FORCE applies
  // (cron-system context). `FOR UPDATE SKIP LOCKED` prevents two ticks
  // grabbing the same row — the second tick's transaction will skip
  // any row whose advisory lock is held by an in-flight worker.
  //
  // With the batch path deleted there is no sibling cron to partition
  // against: this is the only claimant of `approved` rows. Size is bounded
  // where it belongs instead — with the import ON one call carries any
  // audience, and with it OFF `currentAudienceCeiling()` clamps to what the
  // serial push can drain, so an oversized audience is refused at submit
  // rather than claimed and stranded.
  let eligible: ReadonlyArray<{ broadcast_id: string }>;
  try {
    eligible = await runInTenant(tenant, async (tx) => {
      const rows = (await tx.execute(sql`
        SELECT broadcast_id::text AS broadcast_id
        FROM broadcasts
        WHERE tenant_id = ${tenant.slug}
          AND status = 'approved'
          AND scheduled_for IS NOT NULL
          AND scheduled_for <= now()
        ORDER BY scheduled_for ASC
        LIMIT ${MAX_PER_TICK}
        FOR UPDATE SKIP LOCKED
      `)) as unknown as Array<{ broadcast_id: string }>;
      return rows;
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenant.slug,
      },
      'cron.broadcasts.dispatch.eligible_query_failed',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' } },
      { status: 500 },
    );
  }

  const summary = {
    processed: 0,
    succeeded: 0,
    retryable: 0,
    permanent_failed: 0,
    resource_missing: 0,
    /**
     * T087 — imports handed to Resend this tick. Neither a success nor a
     * failure: nothing is delivered yet, and a later tick confirms it.
     * Counting these as `succeeded` would make the dashboard claim sends
     * that have not happened.
     */
    import_submitted: 0,
    import_pending: 0,
    unknown_error: 0,
    uncaught_error: 0,
  };

  // T172 — emit no-due-rows skip when query returned an empty set so
  // the cron tick observability dashboard can distinguish "queue
  // empty" from "feature_disabled". (R6 W-P5: `advisory_lock_held`
  // bucket removed — never emitted because FOR UPDATE SKIP LOCKED +
  // advisory_xact_lock pattern means contested rows aren't returned to
  // the scanner in the first place.)
  if (eligible.length === 0) {
    broadcastsMetrics.cronSkippedCount(tenant.slug, 'no_due_rows');
  }

  // T174 — root span `cron_dispatch_scheduled` per docs § 22 trace tree.
  // The span wraps the entire eligible-row loop so per-broadcast
  // dispatch sub-spans (created inside the use-case via Drizzle/fetch
  // auto-instr) hang as children of this root.
  //
  // Round 5 R5-CRON-B — span lifecycle wrapped in try/finally so a
  // synchronous throw from `makeDispatchScheduledBroadcastDeps` or
  // any code between span-create and `cronSpan.end()` (logger
  // formatter, etc.) does not leak the span and stall the trace
  // exporter.
  //
  // R6 staff-review W-P6 fix — converted from `startSpan` to
  // `startActiveSpan` (via the `withActiveSpan` helper) so the span
  // is set as the active context. Without this, auto-instrumented
  // child spans (Drizzle queries inside use-case `withTx`, Resend
  // fetch calls) appear orphaned at trace-tree root in Vercel
  // Observability, making latency attribution impossible.
  return withActiveSpan(
    broadcastsTracer(),
    'cron_dispatch_scheduled',
    {
      'tenant.id': tenant.slug,
      'cron.eligible_count': eligible.length,
    },
    async (cronSpan) => {
    const baseDeps = await makeDispatchScheduledBroadcastDeps(tenant.slug);
    // R6 staff-review W-P3 fix — per-tick memoization on segment
    // resolution. Multiple `all_members` (or shared-tier) broadcasts
    // in the same tick now share one F3 round-trip instead of
    // re-fetching the same recipient list per broadcast. Cache scope
    // = this cron-tick closure (fresh Map per tick).
    const deps = {
      ...baseDeps,
      membersBridge: makeTickMemoizedMembersBridge(baseDeps.membersBridge),
    };
    // T087 — with the import flag ON, the whole audience goes to Resend in ONE
    // call and is confirmed on a later tick, so this cron drives
    // `buildAudienceTick` instead of the serial single-tick push. Built once
    // per tick like `deps`, and only when it will be used: the maker resolves
    // the tenant display name, which is a DB read nobody should pay for on the
    // flag-OFF path.
    const importEnabled = isF7ImportAudienceEnabled();
    const importDeps = importEnabled
      ? {
          ...(await makeBuildAudienceTickDeps(tenant.slug, deps.membersBridge)),
          // Share the tick memo: several broadcasts on one segment resolve it
          // once, exactly as the single-tick path does.
          tenant: deps.tenant,
        }
      : null;

    for (const row of eligible) {
      summary.processed++;
      try {
        if (importDeps !== null) {
          const built = await buildAudienceTick(importDeps, {
            broadcastId: asBroadcastId(row.broadcast_id),
          });
          if (built.ok) {
            // Three distinct outcomes, counted apart. `import_submitted` and
            // `import_pending` are NOT successes: nothing has been delivered,
            // and folding them into `succeeded` would have the dashboard claim
            // sends that have not happened.
            if (built.value.kind === 'sent') summary.succeeded++;
            else if (built.value.kind === 'import_submitted') summary.import_submitted++;
            else summary.import_pending++;
            continue;
          }
          switch (built.error.kind) {
            case 'dispatch.server_error':
              // Transient: the row stays `approved` and the next tick retries.
              summary.retryable++;
              broadcastsMetrics.dispatchResolveFailedTotal(tenant.slug);
              break;
            case 'audience_import_failed':
            case 'audience_import_stuck':
            case 'broadcast_audience_too_large':
            case 'broadcast_audience_post_suppression_empty':
              // Terminal by design — every one of these is a statement about a
              // job that has already finished or an audience that cannot be
              // sent, so re-polling produces the same answer. The use case has
              // already moved the row to `failed_to_dispatch` and audited it.
              summary.permanent_failed++;
              break;
            default:
              summary.unknown_error++;
              broadcastsMetrics.cronUnknownErrorCount(tenant.slug);
              logger.error(
                {
                  tenantId: tenant.slug,
                  broadcastId: row.broadcast_id,
                  errorKind: (built.error as { kind?: string }).kind ?? 'unknown',
                },
                'cron.broadcasts.dispatch.unknown_error_kind',
              );
          }
          continue;
        }

        const result = await dispatchScheduledBroadcast(deps, {
          broadcastId: asBroadcastId(row.broadcast_id),
        });
        if (result.ok) {
          summary.succeeded++;
          continue;
        }
        switch (result.error.kind) {
          case 'dispatch.server_error':
            // code-review #11 — a typed, TRANSIENT infra failure (members-bridge
            // / Neon / RLS throw, mapped in dispatch-scheduled-broadcast.ts). The
            // broadcast stays 'approved' for a clean next-tick retry — identical
            // lifecycle to gateway_retryable. Bucket it as retryable (log-only, no
            // counter) so it neither raises the page-now `uncaught_error` alert nor
            // pollutes `unknown_error` (an enum-drift "should be 0" signal that
            // would page on-call for a routine transient DB blip).
            summary.retryable++;
            // Review 2026-09-07 (errors HIGH-4) — this was log-only: no
            // counter, and no wall-clock budget on this path (that budget is
            // the `gateway_retryable` branch's, FR-021), so a broadcast that
            // could not build its audience slipped `scheduled_for` forever
            // with nothing to alert on. The counter is the alarm; the row
            // still stays `approved` for a clean next-tick retry.
            broadcastsMetrics.dispatchResolveFailedTotal(tenant.slug);
            logger.warn(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                reason: result.error.message,
              },
              'cron.broadcasts.dispatch.server_error',
            );
            break;
          case 'gateway_retryable':
            summary.retryable++;
            logger.warn(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                subKind: result.error.subKind,
                reason: result.error.reason,
              },
              'cron.broadcasts.dispatch.retryable',
            );
            break;
          case 'broadcast_resend_resource_missing':
            summary.resource_missing++;
            logger.error(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                resourceType: result.error.resourceType,
                resourceId: result.error.resourceId,
              },
              'cron.broadcasts.dispatch.resend_resource_missing',
            );
            break;
          case 'broadcast_failed_to_dispatch':
          case 'broadcast_audience_post_suppression_empty':
            summary.permanent_failed++;
            break;
          default: {
            // Round-4 HIGH-D + Round-5 R5-CRON — unknown error kind
            // goes to the dedicated `unknown_error` counter AND emits
            // a metric (R5-CRON-A) so dashboards alert on the right
            // class without scraping JSON response bodies.
            summary.unknown_error++;
            broadcastsMetrics.cronUnknownErrorCount(tenant.slug);
            // Renamed off `errKind` — that name now belongs to the shared
            // PII-safe helper imported at the top of this file, and a local
            // shadowing it in one block while the catch below calls the import
            // is a reading hazard, not a compile error.
            const unroutedKind =
              (result.error as { kind?: string }).kind ?? 'unknown';
            logger.error(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                errorKind: unroutedKind,
              },
              'cron.broadcasts.dispatch.unknown_error_kind',
            );
          }
        }
      } catch (e) {
        // Review #13: uncaught throws (e.g., programming bugs) must be
        // distinguishable from handled permanent failures so dashboards
        // alert on the right class. The broadcast row stays 'approved'
        // but the next tick will hit the same bug — alert immediately.
        // Round 5 R5-CRON-A — also emit dedicated metric counter.
        summary.uncaught_error++;
        broadcastsMetrics.cronUncaughtErrorCount(tenant.slug);
        // PII-safe (108 Phase 9 review S15). This used to log `e.message` plus
        // the full `stack` under keys `err` and `stack`, and `REDACT_PATHS` in
        // `src/lib/logger.ts` is key-based — it covers `email`, `reason` and
        // friends, but never `err`, `message` or `stack`. A `GatewayThrowable`
        // carries Resend's response text verbatim, and `importFetch`'s non-JSON
        // fallback puts `text.slice(0, 200)` of a raw body straight into
        // `message`. The failing request on this path is the one carrying the
        // whole member CSV, which makes contact-import validation the single
        // likeliest place for a provider to echo an address back.
        //
        // Whether Resend actually echoes rows is UNMEASURED — which is the
        // reason to fail safe rather than a reason to wait. The error CLASS plus
        // the gateway's own `kind` is what an operator needs to route the
        // incident; the free text adds nothing they can act on.
        const shape = e as { kind?: unknown; code?: unknown };
        logger.error(
          {
            err: errKind(e),
            errorKind: typeof shape.kind === 'string' ? shape.kind : undefined,
            code: typeof shape.code === 'string' ? shape.code : undefined,
            tenantId: tenant.slug,
            broadcastId: row.broadcast_id,
          },
          'cron.broadcasts.dispatch.uncaught_error',
        );
      }
    }

    logger.info(
      { tenantId: tenant.slug, ...summary },
      'cron.broadcasts.dispatch.tick_complete',
    );
    cronSpan.setAttribute('cron.processed', summary.processed);
    cronSpan.setAttribute('cron.succeeded', summary.succeeded);
    if (summary.uncaught_error > 0 || summary.unknown_error > 0) {
      cronSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: `errors: uncaught=${summary.uncaught_error} unknown=${summary.unknown_error}`,
      });
    }
      return NextResponse.json(summary, { status: 200 });
    },
  );
}
