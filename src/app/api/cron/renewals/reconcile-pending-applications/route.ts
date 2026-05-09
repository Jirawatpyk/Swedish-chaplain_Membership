/**
 * F8 Phase 7 T191 — Weekly reconcile-pending-applications cron.
 *
 * MVP single-tenant: this route does both the orchestrator role and
 * the per-tenant work (no fan-out needed). When the project moves to
 * multi-tenant, fan out via internal HTTP per the
 * tier-upgrade-evaluate-coordinator pattern.
 *
 * Detects orphaned `accepted_pending_apply` suggestions whose target
 * cycle is `cancelled` or `lapsed` (the F4 hook would never fire) and
 * transitions them to `dismissed` with `reason='orphan_target_cycle_terminal'`.
 *
 * Triggered WEEKLY at Saturday 05:00 Asia/Bangkok by cron-job.org.
 *
 * Auth: Bearer via `CRON_SECRET`.
 * Kill-switch: `FEATURE_F8_RENEWALS=false` → 200 + skipped.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import {
  reconcilePendingApplications,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (
    !verifyCronBearer(request.headers.get('authorization'), env.cron.secret)
  ) {
    return NextResponse.json(
      { error: { code: 'unauthorized' } },
      { status: 401 },
    );
  }

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const tenantId = env.tenant.slug;
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    const result = await reconcilePendingApplications(deps, {
      tenantId,
      correlationId,
    });
    if (!result.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: result.error.kind,
        },
        'cron.renewals.reconcile_pending.failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }
    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      orphans_detected: result.value.orphansDetected,
      orphans_dismissed: result.value.orphansDismissed,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...body },
      'cron.renewals.reconcile_pending.complete',
    );
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.reconcile_pending.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
