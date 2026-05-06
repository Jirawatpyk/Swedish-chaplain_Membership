/**
 * F8 Phase 4 Wave I5 / T104 — Per-tenant reminder dispatch route.
 *
 * Called by the daily dispatch coordinator (T103) — NOT by cron-job.org
 * directly. Receives `tenantId` as a URL path param, validates it
 * against `env.tenant.slug` (MVP single-tenant guard), acquires the
 * per-tenant advisory lock, then invokes:
 *
 *   1. `dispatchRenewalCycle` (Wave I2c) — new dispatches per
 *      schedule policy + FR-011 idempotency on (cycle, step, year).
 *   2. `retryFailedReminders` (Wave I2e) — FR-010a 24h retry budget
 *      pass for transient failures + permanent-exhaustion handling.
 *
 * Per-tenant advisory lock convention:
 *   pg_advisory_xact_lock(hashtextextended('renewals:dispatch:'||tenantId, 0))
 *
 * Auto-released at tx end. Concurrent T103 coordinator runs would
 * race on the same lock — second waits, then sees zero new dispatches
 * via FR-011 idempotency. Safe.
 *
 * Auth: Bearer via `CRON_SECRET` (same as T103 coordinator). The
 * coordinator forwards its Bearer to the per-tenant route — both
 * cron-job.org-facing and internal endpoints share the same secret.
 *
 * MVP guard: only `env.tenant.slug` accepted. Any other slug → 400
 * `unknown_tenant`. Post-F10 SaaS would validate against a tenants
 * table.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { getClientIp } from '@/lib/client-ip';
import { asTenantContext } from '@/modules/tenants';
import {
  dispatchRenewalCycle,
  retryFailedReminders,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // Constant-time Bearer check.
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    // K12-6 + K12-8 (SEC-K-5 + TST-K-4): rate-limit the 401 path
    // BEFORE the audit emit and emit `cron_bearer_auth_rejected` so
    // a sustained Bearer-rejection rate is forensically traceable on
    // the per-tenant cron surface too (coordinator already does this
    // since K6). 60 requests / 60 sec / IP — same parameters as the
    // coordinator. Once the limit is hit we short-circuit with no
    // INSERT into audit_log.
    //
    // K13-1 (REL-R12-1): fail-open on Upstash outage — see
    // dispatch-coordinator/route.ts for full rationale.
    const ip = getClientIp(request);
    try {
      const rl = await rateLimiter.check(
        `f8:cron:bearer-rejected:${ip}`,
        60,
        60,
      );
      if (!rl.success) {
        return NextResponse.json(
          { error: { code: 'rate_limited' } },
          {
            status: 429,
            headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
          },
        );
      }
    } catch (e) {
      logger.warn(
        {
          err: e instanceof Error ? e : new Error(String(e)),
          route: '/api/cron/renewals/dispatch/[tenantId]',
        },
        'cron.renewals.dispatch.rate_limit_check_failed_fail_open',
      );
    }
    try {
      const deps = makeRenewalsDeps(env.tenant.slug);
      await deps.auditEmitter.emit(
        {
          type: 'cron_bearer_auth_rejected',
          payload: { route: '/api/cron/renewals/dispatch/[tenantId]' },
        },
        {
          tenantId: env.tenant.slug,
          actorUserId: null,
          actorRole: 'cron',
          correlationId: uuidv7(),
          requestId: null,
        },
      );
    } catch (e) {
      logger.error(
        {
          err: e instanceof Error ? e : new Error(String(e)),
        },
        'cron.renewals.dispatch.bearer_rejected_audit_failed',
      );
    }
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  // Kill-switch — return 200 + skipped (matches coordinator semantics).
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const { tenantId } = await context.params;

  // MVP single-tenant guard. Path-decoded by Next.js; strict equality
  // rejects path-traversal-style attacks. Post-F10: validate against
  // tenants-table membership.
  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.dispatch.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  // K1-C1: generate fresh UUID — never trust inbound `x-request-id`
  // even when called by the trusted coordinator. Defence-in-depth
  // against an attacker who has `CRON_SECRET` and bypasses the
  // coordinator to call this route directly with a forged
  // correlationId. The coordinator already logs its own correlationId;
  // per-tenant + coordinator runs are joinable via `tenant_id` +
  // `started_at` window (both audit + log).
  const correlationId = uuidv7();
  const tenantCtx = asTenantContext(tenantId);
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    return await runInTenant(tenantCtx, async (tx) => {
      // K4: Per-tenant advisory lock — uses sub-key
      // `renewals:dispatch:<tenantId>` distinct from F8's
      // mark-paid-offline lock which uses sub-key
      // `renewals:<tenantId>:<cycleId>`; both belong to the F8
      // `renewals:` namespace family but address disjoint scopes
      // (per-tenant cron pass vs per-cycle admin action). Cross-feature
      // namespaces stay disjoint: F4 uses `invoicing:`, F5 `payments:`,
      // F7 `broadcasts:`. Auto-released at tx end. The TX exists ONLY
      // to acquire the lock — the inner use-cases open their OWN
      // runInTenant blocks for atomic state+audit.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:dispatch:'||${tenantId}, 0))`,
      );

      // 1. New dispatches.
      const dispatchResult = await dispatchRenewalCycle(deps, {
        tenantId,
        correlationId,
      });
      if (!dispatchResult.ok) {
        logger.error(
          {
            tenantId,
            correlationId,
            error: dispatchResult.error.kind,
            message: dispatchResult.error.message,
          },
          'cron.renewals.dispatch.dispatch_failed',
        );
        return NextResponse.json(
          {
            error: { code: 'dispatch_failed' },
            tenant_id: tenantId,
          },
          { status: 500 },
        );
      }

      // 2. Retry pass (FR-010a 24h budget).
      const retryResult = await retryFailedReminders(deps, {
        tenantId,
        correlationId,
      });
      // J2-B5: previously a `retryResult.ok === false` was silently
      // coerced to `0 retried / 0 exhausted` and the per-tenant route
      // returned 200 with green metrics — the coordinator then emitted
      // `cron_dispatch_orchestrated` "succeeded" while the retry pass
      // had completely no-op'd. Now we elevate the err Result to an
      // error log + surface `retry_pass_failed: true` in the response
      // body so the coordinator audit + observability dashboards
      // distinguish "no retries needed" from "retry pass crashed".
      // We deliberately keep HTTP 200 (rather than 5xx) to avoid
      // cron-job.org retry storms — the dispatch pass already
      // succeeded; one ops alert is preferable to a flood of duplicate
      // dispatch attempts.
      if (!retryResult.ok) {
        logger.error(
          {
            tenantId,
            correlationId,
            errKind: retryResult.error.kind,
            errMessage: retryResult.error.message,
          },
          'cron.renewals.dispatch.retry_pass_failed',
        );
      }

      const responseBody = {
        skipped: false as const,
        tenant_id: tenantId,
        reminders_dispatched: dispatchResult.value.summary.emailsSent,
        reminders_skipped: dispatchResult.value.summary.skipped,
        tasks_created: dispatchResult.value.summary.tasksCreated,
        reminders_failed_transient:
          dispatchResult.value.summary.failedTransient,
        reminders_failed_permanent:
          dispatchResult.value.summary.failedPermanent,
        reminders_retried: retryResult.ok
          ? retryResult.value.summary.retrySucceeded
          : 0,
        reminders_exhausted: retryResult.ok
          ? retryResult.value.summary.exhaustedMarked
          : 0,
        // J2-B5: surfaced retry-pass health for coordinator audit +
        // ops dashboards. `retry_pass_failed=false` on success;
        // `retry_pass_error` carries the Result error kind on failure.
        retry_pass_failed: !retryResult.ok,
        retry_pass_error: retryResult.ok ? null : retryResult.error.kind,
        candidates_processed:
          dispatchResult.value.summary.candidatesProcessed,
        duration_ms: Date.now() - startedAt,
      };

      logger.info(
        {
          tenantId,
          correlationId,
          ...responseBody,
        },
        'cron.renewals.dispatch.complete',
      );

      return NextResponse.json(responseBody);
    });
  } catch (e) {
    logger.error(
      {
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type.
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.dispatch.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
