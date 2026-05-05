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
import { requestIdFromHeaders } from '@/lib/request-id';
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

  const correlationId = requestIdFromHeaders(request.headers);
  const tenantCtx = asTenantContext(tenantId);
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    return await runInTenant(tenantCtx, async (tx) => {
      // Per-tenant advisory lock — namespace 'renewals:dispatch:'+tenantId
      // is disjoint from F4 'invoicing:', F5 'payments:', F7 'broadcasts:',
      // F8 'renewals:' (mark-paid-offline). Auto-released at tx end.
      // The TX exists ONLY to acquire the lock — the inner use-cases
      // open their OWN runInTenant blocks for atomic state+audit.
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
        err: e instanceof Error ? e.message : String(e),
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
