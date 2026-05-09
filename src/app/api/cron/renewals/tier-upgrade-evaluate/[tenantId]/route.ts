/**
 * F8 Phase 7 T190 — Per-tenant tier-upgrade-evaluate route.
 *
 * Called by the weekly tier-upgrade-evaluate-coordinator (T189) — NOT
 * by cron-job.org directly. Receives `tenantId` as a URL path param,
 * validates against `env.tenant.slug` (MVP single-tenant guard),
 * acquires per-tenant advisory lock, then runs `evaluateTierUpgrade`.
 *
 * Per-tenant advisory lock convention:
 *   pg_advisory_xact_lock(hashtextextended('renewals:tierupgrade:'||tenantId, 0))
 *
 * Distinct namespace from `renewals:dispatch:` and `renewals:at-risk:`
 * so the three F8 weekly cron streams can run concurrently without
 * contention.
 *
 * Auth: Bearer via `CRON_SECRET`.
 *
 * Kill-switch: `FEATURE_F8_RENEWALS=false` → 200 + `{skipped: true,
 * reason: 'feature_flag_disabled'}` (whole-F8 dark launch).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { asTenantContext } from '@/modules/tenants';
import {
  evaluateTierUpgrade,
  makeRenewalsDeps,
  DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
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

  const { tenantId } = await context.params;

  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.tier_upgrade.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  const correlationId = uuidv7();
  const tenantCtx = asTenantContext(tenantId);
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    const txResult = await runInTenant(tenantCtx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:tierupgrade:'||${tenantId}, 0))`,
      );
      return await evaluateTierUpgrade(deps, {
        tenantId,
        correlationId,
        pageSize: DEFAULT_TIER_UPGRADE_EVAL_PAGE_SIZE,
      });
    });

    if (!txResult.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: txResult.error.kind,
          message:
            txResult.error.kind === 'invalid_input' ||
            txResult.error.kind === 'server_error'
              ? txResult.error.message
              : undefined,
        },
        'cron.renewals.tier_upgrade.evaluate_failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const responseBody = {
      skipped: false as const,
      tenant_id: tenantId,
      tenant_skipped_reason: txResult.value.tenantSkipped?.reason ?? null,
      members_scanned: txResult.value.membersScanned,
      suggestions_created: txResult.value.suggestionsCreated,
      already_at_target: txResult.value.alreadyAtTarget,
      suppressed_skipped: txResult.value.suppressedSkipped,
      conflict_skipped: txResult.value.conflictSkipped,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...responseBody },
      'cron.renewals.tier_upgrade.complete',
    );
    return NextResponse.json(responseBody);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.tier_upgrade.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
