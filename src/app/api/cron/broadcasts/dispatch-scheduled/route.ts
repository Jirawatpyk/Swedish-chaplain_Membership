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
  SPLIT_THRESHOLD_RECIPIENTS,
  isF71aUs1Enabled,
} from '@/modules/broadcasts';
import { runInTenant } from '@/lib/db';
import { asTenantContext } from '@/modules/tenants';
import { env } from '@/lib/env';
import { verifyCronBearer } from '@/lib/cron-auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
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
  // Phase 9b (T137) — the `estimated_recipient_count` predicate is what makes
  // this cron and `split-large-broadcasts` a PARTITION of the `approved` set
  // rather than two overlapping filters. Both run every five minutes; the
  // sibling selects `> SPLIT_THRESHOLD_RECIPIENTS`, and `splitBroadcastIntoBatches`
  // does not change the broadcast's status, so without this line whichever cron
  // runs first claims the row. `FOR UPDATE SKIP LOCKED` does not help: it stops
  // CONCURRENT claims on the same row, not sequential ones seconds apart. A row
  // above the threshold claimed here would be pushed by the serial single-tick
  // loop and killed at `maxDuration = 300`.
  //
  // The estimate is frozen at submit and can be days stale, so this predicate
  // is a cheap indexed FIRST pass, not the real bound. The use case re-resolves
  // and hands a grown audience back to the split path (T147); the split cron
  // never releases a row whose audience shrank (T148). Between them every
  // `approved` row has exactly one owner in either direction of drift.
  //
  // **The predicate MOVES WITH THE BATCHING FLAG** (H-4 / whole-branch #13).
  // `split-large-broadcasts` returns `feature_disabled` outright when
  // `isF71aUs1Enabled()` is false, so keeping the exclusion in that state would
  // leave a row above the threshold owned by NEITHER cron — silently stuck in
  // `approved`, which is strictly worse than the pre-branch behaviour where it
  // was claimed here and refused loudly. Flag OFF is the documented rollback
  // position; it has to keep behaving as it did before this branch.
  const claimBound = isF71aUs1Enabled()
    ? sql`AND estimated_recipient_count <= ${SPLIT_THRESHOLD_RECIPIENTS}`
    : sql``;
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
          ${claimBound}
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
     * Phase 9b (T147) — rows handed to `split-large-broadcasts` because the
     * audience outgrew one tick since submit. Neither a success nor a failure:
     * the broadcast is intact, still `approved`, and delivered by the batch
     * path within ~5 minutes. A sustained non-zero value means audiences are
     * routinely crossing the threshold, which is information, not an incident.
     */
    deferred_to_batch_path: 0,
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
    for (const row of eligible) {
      summary.processed++;
      try {
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
          case 'DEFERRED_TO_BATCH_PATH':
            // Phase 9b (T147) — NOT a failure. The audience grew past what one
            // tick can push since submit, so the use case corrected
            // `estimated_recipient_count` and left the row `approved`; the next
            // `split-large-broadcasts` tick claims it on the corrected number
            // and the batch path delivers it.
            //
            // It needs its own counter precisely because the `default` arm
            // below raises `cronUnknownErrorCount`, which is alarmed on. A
            // routine hand-off must not page anyone.
            summary.deferred_to_batch_path++;
            logger.info(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                resolvedCount: result.error.resolvedCount,
                deliverablePerTick: result.error.deliverablePerTick,
              },
              'cron.broadcasts.dispatch.deferred_to_batch_path',
            );
            break;
          default: {
            // Round-4 HIGH-D + Round-5 R5-CRON — unknown error kind
            // goes to the dedicated `unknown_error` counter AND emits
            // a metric (R5-CRON-A) so dashboards alert on the right
            // class without scraping JSON response bodies.
            summary.unknown_error++;
            broadcastsMetrics.cronUnknownErrorCount(tenant.slug);
            const errKind = (result.error as { kind?: string }).kind ?? 'unknown';
            logger.error(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                errorKind: errKind,
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
        logger.error(
          {
            err: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
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
