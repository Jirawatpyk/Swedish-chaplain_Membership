/**
 * T130a — Stale-pending-refund sweep cron.
 *
 * Scheduled via Vercel Cron Hobby (daily) — `vercel.json` entry:
 *   { "path": "/api/cron/sweep-stale-pending-refunds", "schedule": "0 3 * * *" }
 *
 * Also scheduled redundantly on cron-job.org at `0 15 * * *` UTC
 * (12h offset). Sweep is idempotent — dual-firing safe (verified by
 * the integration test's "idempotent" case). See runbook
 * § "Redundant scheduling".
 *
 * Recovery sweep for the Postgres double-fault scenario in
 * `issueRefund` (Phase 6 review fix C2 covers the common case;
 * this is the last-resort recovery if BOTH Phase B AND its
 * failure-finalise tx throw — leaving a `pending` refund row
 * forever, blocking all future refunds on that payment via the
 * `refund_in_progress` guard).
 *
 * Per-tenant invocation: the cron iterates all tenants with
 * `online_payment_enabled = true` (the only tenants that can have
 * F5 refund rows) and calls `sweepStalePendingRefunds` once each.
 * Per-tenant errors are logged + skipped so one bad tenant does
 * not block the rest.
 *
 * Authentication: gated by `CRON_SECRET` (Bearer token in the
 * `Authorization` header). Dev-mode accepts unauthenticated calls
 * for manual operator triggering.
 *
 * Idempotent: re-running the cron is safe — already-swept rows are
 * already in `failed` status and won't match `WHERE status='pending'`.
 *
 * Runbook: `docs/runbooks/stale-pending-refund-sweep.md`
 */
import { NextResponse, type NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { verifyCronBearer } from '@/lib/cron-auth';
// Cron path: bulk read across tenants + per-tenant use-case
// invocation. No top-level Application use case exists for cross-
// tenant orchestration — it is a maintenance path, not a user
// flow. Documented escape hatch (mirrors lockout-cleanup pattern).
/* eslint-disable no-restricted-imports */
import { tenantPaymentSettings } from '@/modules/payments/infrastructure/schema';
/* eslint-enable no-restricted-imports */
import { eq } from 'drizzle-orm';
import {
  sweepStalePendingRefunds,
  makeSweepStalePendingRefundsDeps,
} from '@/modules/payments';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { paymentsMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_OLDER_THAN_HOURS = 24;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  // F5R1-E10 fix — use the zod-validated `env.cron.secret` instead of
  // raw `process.env.CRON_SECRET`. The validated env refuses to boot
  // when the var is unset (zod `.min(16)` on line 198 of env.ts), so
  // the previous `else if (!env.isDevelopment)` dev-mode fallback that
  // allowed unauthenticated access on a misconfigured deploy is no
  // longer reachable — the app would not have started.
  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId }, 'cron.sweep_stale_pending_refunds.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // Operator override via query param (`?olderThanHours=2` for
  // manual deeper sweeps during incident response). Validated +
  // bounded so a typo can't sweep all pending rows.
  const olderThanRaw = request.nextUrl.searchParams.get('olderThanHours');
  const olderThanHours = (() => {
    if (olderThanRaw === null) return DEFAULT_OLDER_THAN_HOURS;
    const parsed = Number(olderThanRaw);
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 24 * 30) {
      return DEFAULT_OLDER_THAN_HOURS;
    }
    return parsed;
  })();

  // Iterate every tenant with online payment enabled — only these
  // can have F5 refund rows. Reads bypass tenant RLS (no
  // app.current_tenant set) intentionally — this is a cross-tenant
  // ops surface gated by CRON_SECRET, not a user request.
  let tenantRows: Array<{ tenantId: string }> = [];
  try {
    tenantRows = await db
      .select({ tenantId: tenantPaymentSettings.tenantId })
      .from(tenantPaymentSettings)
      .where(eq(tenantPaymentSettings.onlinePaymentEnabled, true));
  } catch (e) {
    // R3 M-4 rel (2026-04-28): constructor.name only — Postgres
    // errors can carry SQL fragments / column names in `.message`.
    logger.error(
      { requestId, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.sweep_stale_pending_refunds.tenant_list_failed',
    );
    return NextResponse.json({ error: 'tenant_list_failed' }, { status: 500 });
  }

  let totalSwept = 0;
  let totalSkipped = 0;
  let tenantsOk = 0;
  let tenantsErrored = 0;

  for (const { tenantId } of tenantRows) {
    try {
      const deps = makeSweepStalePendingRefundsDeps(tenantId);
      const result = await sweepStalePendingRefunds(deps, {
        tenantId,
        olderThanHours,
        requestId,
      });
      if (result.ok) {
        totalSwept += result.value.sweptCount;
        totalSkipped += result.value.skippedCount;
        tenantsOk += 1;
        if (result.value.sweptCount > 0) {
          logger.warn(
            {
              requestId,
              tenantId,
              swept: result.value.sweptCount,
              skipped: result.value.skippedCount,
              cutoff: result.value.cutoff,
            },
            'cron.sweep_stale_pending_refunds.tenant_swept',
          );
        }
      } else {
        tenantsErrored += 1;
        // F5R1-E11 — emit metric counter so SRE alert rules attached
        // to OTel counters (not log strings) can fire on sustained
        // per-tenant sweep failures. Pino logs alone roll off in
        // 30 days; alert rules + the audit-log forensic trail (5y)
        // are the long-term compliance anchors.
        paymentsMetrics.cronSweepTenantFailed(tenantId);
        logger.error(
          { requestId, tenantId, cause: result.error.cause },
          'cron.sweep_stale_pending_refunds.tenant_failed',
        );
      }
    } catch (e) {
      tenantsErrored += 1;
      paymentsMetrics.cronSweepTenantFailed(tenantId);
      logger.error(
        { requestId, tenantId, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
        'cron.sweep_stale_pending_refunds.tenant_threw',
      );
    }
  }

  logger.info(
    {
      requestId,
      tenantsTotal: tenantRows.length,
      tenantsOk,
      tenantsErrored,
      totalSwept,
      totalSkipped,
      olderThanHours,
    },
    'cron.sweep_stale_pending_refunds.completed',
  );

  return NextResponse.json(
    {
      ok: true,
      tenantsTotal: tenantRows.length,
      tenantsOk,
      tenantsErrored,
      totalSwept,
      totalSkipped,
      olderThanHours,
    },
    { status: 200 },
  );
}
