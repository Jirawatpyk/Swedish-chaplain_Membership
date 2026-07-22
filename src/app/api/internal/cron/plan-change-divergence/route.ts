/**
 * Finding #20 defense-in-depth — standing plan-change divergence scan (Vercel Cron).
 *
 * Wires the read-only `checkPlanChangeDivergence` detector (also used by the
 * `pnpm check:plan-divergence` operator gate + its integration test) to a
 * recurring native Vercel Cron so a cycle↔linked-§86/4 frozen-price disagreement
 * surfaces in minutes rather than on a manual run. The confirm-renewal
 * reconcile-at-link guard (this feature's primary fix) should keep this at 0;
 * this cron is the safety net that alerts if it ever isn't (e.g. a divergence
 * introduced by a future code path the reconcile guard does not cover).
 *
 * Cross-tenant by design: `checkPlanChangeDivergence` uses the `@/lib/db`
 * singleton (RLS-bypass owner role) with explicit `tenant_id` join predicates,
 * so one pass scans every tenant — the same pattern the stale-pending-count and
 * void-pdf-reconcile internal crons use. Read-only; mutates nothing.
 *
 * Scheduling: native Vercel Cron (`vercel.json`), GET-only, `CRON_SECRET`
 * Bearer auto-injected by Vercel. Vercel cron is UTC.
 *
 * Alerting: on ANY divergence the route (a) emits the
 * `renewals_plan_change_divergence_detected_total{tenant}` counter with the
 * per-tenant count and (b) returns a non-2xx status so Vercel cron-failure
 * alerting fires independently of the metrics pipeline. A clean pass returns 200.
 *
 * Runtime: Node.js (Drizzle). Force-dynamic — the scan MUST reflect current DB
 * state, never a cached response.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { verifyCronBearer } from '@/lib/cron-auth';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsMetrics } from '@/lib/metrics';
import { requestIdFromHeaders } from '@/lib/request-id';
import { checkPlanChangeDivergence } from '@/../scripts/check-plan-change-divergence';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  if (!verifyCronBearer(request.headers.get('authorization'), env.cron.secret)) {
    logger.warn({ requestId }, 'cron.plan_change_divergence.unauthorized');
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  let report: Awaited<ReturnType<typeof checkPlanChangeDivergence>>;
  try {
    report = await checkPlanChangeDivergence();
  } catch (e) {
    // Constructor name only — a wrapped Postgres error message can carry SQL
    // params / table names (forbidden-fields hygiene; parity with sibling crons).
    logger.error(
      { requestId, errKind: e instanceof Error ? e.constructor.name : 'unknown' },
      'cron.plan_change_divergence.scan_failed',
    );
    return NextResponse.json({ error: 'scan_failed' }, { status: 500 });
  }

  // Roll up divergences per tenant → emit the alerting counter.
  const perTenant = new Map<string, number>();
  for (const d of report.divergences) {
    perTenant.set(d.tenantId, (perTenant.get(d.tenantId) ?? 0) + 1);
  }
  for (const [tenantId, count] of perTenant) {
    renewalsMetrics.planChangeDivergenceDetected(tenantId, count);
  }

  if (report.divergences.length > 0) {
    logger.error(
      {
        requestId,
        scannedCount: report.scannedCount,
        divergenceCount: report.divergences.length,
        tenants: [...perTenant.keys()],
      },
      'cron.plan_change_divergence.found — renewal_cycle frozen price disagrees with its linked §86/4',
    );
    // Non-2xx so Vercel cron-failure alerting fires. See
    // docs/runbooks/plan-change-divergence.md for triage.
    return NextResponse.json(
      {
        ok: false,
        scannedCount: report.scannedCount,
        divergenceCount: report.divergences.length,
      },
      { status: 500 },
    );
  }

  logger.info(
    { requestId, scannedCount: report.scannedCount },
    'cron.plan_change_divergence.clean',
  );
  return NextResponse.json(
    { ok: true, scannedCount: report.scannedCount, divergenceCount: 0 },
    { status: 200 },
  );
}
