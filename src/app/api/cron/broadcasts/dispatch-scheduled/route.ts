/**
 * F7 US2 cron worker — POST `/api/cron/broadcasts/dispatch-scheduled`.
 *
 * Triggered every 5 min by **native Vercel Cron** (`vercel.json`) since the
 * 2026-07-17 Pro migration — UTC-only, invoked with GET, which is why `GET` is
 * aliased to `POST` below. cron-job.org is a paused standby.
 * See docs/runbooks/cron-jobs.md.
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
 *   - **Round 4, whole-branch review #3 — this paragraph said the legacy leg's
 *     per-row `pg_advisory_xact_lock` "closes the TOCTOU window", implying the
 *     gap below is import-leg-only. It does not, and the gap is not.** That lock
 *     is taken inside `lockForUpdate`'s transaction, and that transaction
 *     COMMITS before any gateway call — an advisory *xact* lock dies with its
 *     transaction, so nothing is held across `createAudience` /
 *     `addContactsToAudience` / `createBroadcast` / `sendBroadcast`. Holding one
 *     across a 300-second HTTP budget would be worse, which is why it is not
 *     done; but the honest description is that NEITHER leg is protected there.
 *     SKIP LOCKED is a defence against eligible-scan duplication, not the guard
 *     this claimed.
 *
 *     Concretely on the legacy leg: an admin cancel landing during the serial
 *     push (~72 s for 150 contacts) commits while the row is still `approved`,
 *     the send goes out, and Step 4's `applyTransition(from 'approved')` then
 *     matches 0 rows — rolling back `attachResendIds` with it. The row ends
 *     `cancelled` with `resend_broadcast_id` NULL, so every webhook 200-acks as
 *     `unknown_resend_broadcast_id`, bounces never reach suppression, and
 *     `reconcile-stuck-sending` cannot see it (the row is not `sending`).
 *     **CLOSED by F4 (PR #353).** `resend_broadcast_id` is persisted in its own
 *     tx before the send, so it survives the transition rollback a landing
 *     cancel causes, and the webhook can correlate. Note what that does NOT
 *     do: the mail still goes out if Resend accepted the send. What changed is
 *     that the row can afterwards say which resource sent it.
 *   - **On the IMPORT leg that lock does NOT span the send** (round 3 finding
 *     3-6). `buildAudienceTick`'s locking tx COMMITS before every gateway call,
 *     so the window covers a poll, a full re-resolve, `createBroadcast` and
 *     `sendBroadcast`. A cancel can land inside it. That path therefore persists
 *     the Resend ids in their own transaction BEFORE the status transition, so a
 *     lost race still leaves the webhooks resolvable. This paragraph claimed the
 *     lock "survives the entire dispatch tx" for both legs; it never did for
 *     that one.
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
// T095), but the loop is serial, so throughput is `min(10, 1/RTT)` and RTT is
// what binds: **0.481 s per `POST /contacts` ⇒ ~2.08 req/s ⇒ ~623 contacts in
// this 300 s budget** (~63 s for 130 recipients, ~72 s for 150).
//
// Two numbers were struck here, both derived from a 0.29 s sample that had timed
// `GET /audiences` instead of the `POST /contacts` the loop actually calls: a
// "3.4 req/s" rate and the "~1,000 contacts per tick" that followed from it. A
// third stale clause pointed at "the batched multi-tick model", which
// `ca51f59a1` DELETED on this branch — there is no batch path; an audience above
// `currentAudienceCeiling()` is refused, not split.
//
// `audience-ceiling.ts` names this exact drift as the reason the derivation lives
// in ONE place (`research.md` § R9, the CORRECTED block). It took three passes to
// remove: round 4 deleted the derived figure and left the premise sentence, which
// then contradicted its own correction three lines below it.
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
        err: errKind(e),
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
    /**
     * Round 2 R2-1/R2-44 + round 3 finding 3-13 — the row is no longer what the
     * claim query saw: a cancel landed, another worker won the transition, or an
     * row was deleted between the claim and the write. Normal, self-healing,
     * and NOT a failure of any
     * kind: nothing to retry (the other worker finished the work) and nothing
     * failed (so `permanent_failed`, which reads as "done", would suppress a
     * real alert if this bucket ever did mean trouble).
     *
     * Both kinds used to fall to `default` → `unknown_error` +
     * `cronUnknownErrorCount`, the page-on-call enum-drift signal — while the
     * use case that produces one of them says in the same breath "do NOT page
     * on-call (no actual failure)" (`dispatch-scheduled-broadcast.ts:1076`).
     *
     * Named after the existing `concurrent_skip` in the cascade-outcome metric
     * (`metrics.ts:2544`), which draws the same line for the same reason.
     */
    concurrent_skip: 0,
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
              // Round 4 L4 — this arm had NO log line, only the counter. That
              // is the second half of round-3 finding 3-13, and the round-3
              // ledger recorded 3-13 as fully CLOSED when only its first
              // sentence was addressed (`review-20260909-092000.md:153` maps it
              // to `aeb8d42ce`; line 114 of the same file proves the "half"
              // notation was available and unused).
              //
              // The consequence: `broadcasts.dispatch_resolve_failed.total`
              // alarms at >0 sustained 15 min and routes on-call to
              // `broadcast-audience-build.md` § C, whose triage tree is F3
              // pages / Neon / opt-out lookup — while the same counter also
              // fires for every Resend 5xx/429. With no log line there was
              // nothing on this leg to correct that reading. The legacy arm
              // below has always had one.
              logger.warn(
                {
                  tenantId: tenant.slug,
                  broadcastId: row.broadcast_id,
                  errClass: built.error.errClass ?? 'unclassified',
                },
                'cron.broadcasts.dispatch.server_error',
              );
              break;
            case 'broadcast_resend_resource_missing':
              // Round 4 F5 — its own bucket, matching the legacy arm below. The
              // 404 path used to return `audience_import_failed`, so this counter
              // was structurally 0 on the import leg and a trace read
              // "permanent_failed=1, resource_missing=0" — finished, nothing to
              // do — for the one failure whose docblock says an admin has to look
              // at the Resend account.
              //
              // NOTE the arm is required, not cosmetic: without it the new kind
              // falls to `default` → `unknown_error` + `cronUnknownErrorCount`,
              // which is the enum-drift signal that PAGES on-call. Adding a kind
              // to `BuildAudienceTickError` without an arm here trades a silent
              // mis-bucket for a false page.
              summary.resource_missing++;
              logger.error(
                {
                  tenantId: tenant.slug,
                  broadcastId: row.broadcast_id,
                  resourceType: built.error.resourceType,
                  resourceId: built.error.resourceId,
                },
                'cron.broadcasts.dispatch.resend_resource_missing',
              );
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
            case 'broadcast_invalid_state_transition':
            case 'broadcast_not_found':
              // See `summary.concurrent_skip` above. Logged at warn with the
              // kind so the two stay distinguishable — `not_found` after an
              // erasure cascade and `invalid_state_transition` after a cancel
              // are the same bucket but not the same event.
              summary.concurrent_skip++;
              logger.warn(
                {
                  tenantId: tenant.slug,
                  broadcastId: row.broadcast_id,
                  errorKind: built.error.kind,
                },
                'cron.broadcasts.dispatch.concurrent_skip',
              );
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
                // Round 4 L3 — was `reason: result.error.message`, and `reason`
                // is a REDACT_PATH (`logger.ts:332`), deliberately broad because
                // free text on this module can carry a Neon error's bound
                // parameters — member addresses. So this line printed
                // `reason:"[REDACTED]"` and the leg that runs in production had
                // NO diagnostic at all.
                //
                // Renaming the key would have un-redacted the free text, which
                // is the wrong direction. `errClass` is the bounded half,
                // carried from the resolver's catch: `NeonDbError` (a DB blip),
                // `TypeError` (our bug), a fetch error (the network).
                errClass: result.error.errClass ?? 'unclassified',
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
                // Round 4 L3 — `reason: result.error.reason` removed. It is
                // Resend's own response text, so `reason`/`*.reason` redacts it
                // and the line printed `[REDACTED]`; `subKind` already carries
                // the classification an operator acts on (network / timeout /
                // server_5xx / api), so nothing readable is lost.
                subKind: result.error.subKind,
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
          case 'broadcast_invalid_state_transition':
          case 'broadcast_not_found':
            // Same bucket as the import branch above — and this is the leg that
            // is LIVE at merge, so it is the half that mattered first. The G1
            // arm in `dispatchScheduledBroadcast` has produced
            // `broadcast_invalid_state_transition` since 2026-05-02 with a
            // comment saying it must not page; this route sent it to
            // `unknown_error` the whole time.
            summary.concurrent_skip++;
            logger.warn(
              {
                tenantId: tenant.slug,
                broadcastId: row.broadcast_id,
                errorKind: result.error.kind,
              },
              'cron.broadcasts.dispatch.concurrent_skip',
            );
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
    // Round 2 R2-15 — the span carried only `processed` + `succeeded`, so the
    // FIRST tick of an import build traced as `processed=1, succeeded=0` with no
    // error status: indistinguishable from a tick that did nothing at all. That
    // is the one trace an operator opens on the first real send, and tick 1
    // legitimately succeeding looks identical to tick 1 silently failing.
    //
    // Every bucket the summary counts is now an attribute, so the trace says
    // WHICH outcome happened. `import_submitted` and `import_pending` are the two
    // that used to be invisible.
    cronSpan.setAttribute('cron.processed', summary.processed);
    cronSpan.setAttribute('cron.succeeded', summary.succeeded);
    cronSpan.setAttribute('cron.import_submitted', summary.import_submitted);
    cronSpan.setAttribute('cron.import_pending', summary.import_pending);
    cronSpan.setAttribute('cron.retryable', summary.retryable);
    cronSpan.setAttribute('cron.permanent_failed', summary.permanent_failed);
    cronSpan.setAttribute('cron.concurrent_skip', summary.concurrent_skip);
    cronSpan.setAttribute('cron.resource_missing', summary.resource_missing);
    cronSpan.setAttribute('cron.unknown_error', summary.unknown_error);
    cronSpan.setAttribute('cron.uncaught_error', summary.uncaught_error);
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
