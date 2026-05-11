/**
 * F8 Phase 9 retrofit (PR #25) — Weekly prune of consumed link tokens.
 *
 * Deletes rows from `consumed_link_tokens` whose `consumed_at` is older
 * than the 60-day retention window (`data-model.md § 2.8` + migration
 * 0093 header comment). The token-replay-protection table is append-
 * only by design (no UPDATE GRANT); without this cron the table grows
 * unbounded.
 *
 * Triggered WEEKLY at Saturday 04:00 Asia/Bangkok by cron-job.org per
 * `docs/runbooks/cron-jobs.md` F8 token-prune entry.
 *
 * MVP single-tenant: this route does both orchestrator + per-tenant
 * work (no fan-out needed at SweCham scale). When the project moves to
 * multi-tenant, fan out via internal HTTP per the
 * tier-upgrade-evaluate-coordinator pattern. Pattern mirrors
 * `reconcile-pending-applications` (closest existing single-route
 * weekly housekeeping cron).
 *
 * Auth: Bearer via `CRON_SECRET`.
 * Kill-switch: `FEATURE_F8_RENEWALS=false` → 200 + skipped (no retry
 * storm; cron-job.org does NOT retry on 200).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { asTenantContext } from '@/modules/tenants';
import { pruneConsumedTokens, makeRenewalsDeps } from '@/modules/renewals';

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

  // Kill-switch — return 200 + skipped so cron-job.org does NOT retry-
  // storm during dark-launch. Note: the F8 proxy gate
  // (`src/proxy.ts:389`) also returns 503 for `/api/cron/renewals/**`
  // when the flag is false — this in-route check is defence-in-depth
  // and the canonical contract for ops dashboards once the proxy
  // carve-out for `*-coordinator` and housekeeping routes lands.
  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const tenantId = env.tenant.slug;
  const tenantCtx = asTenantContext(tenantId);
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    // Per-tenant advisory lock so a cron-job.org HTTP retry (timeout
    // window) cannot double-fire DELETE and produce surprising row-
    // count metrics. Lock namespace `renewals:prune:` is disjoint
    // from `renewals:reconcile:`, `renewals:tierupgrade:`,
    // `renewals:dispatch:`, `renewals:at-risk:` (other F8 cron
    // coordinators) + F4 `invoicing:`, F5 `payments:`, F7
    // `broadcasts:` namespaces (P2 Innovation pattern from
    // retrospective.md). Auto-released at tx end. Concurrent
    // invocations serialise — the second waits, then DELETE returns
    // 0 rows (state is idempotent).
    const lockHeld = await runInTenant(tenantCtx, async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:prune:'||${tenantId}, 0))`,
      );
      return true;
    });
    if (!lockHeld) {
      // Defensive — `runInTenant` would have thrown if the lock
      // acquisition failed. Kept as a guard so a future refactor
      // that splits the lock + use-case calls preserves the
      // sequencing intent.
      throw new Error('advisory lock not acquired');
    }

    const result = await pruneConsumedTokens(deps, {
      tenantId,
      correlationId,
      now: new Date(),
    });
    if (!result.ok) {
      logger.error(
        {
          tenantId,
          correlationId,
          errorKind: result.error.kind,
        },
        'cron.renewals.prune_consumed_tokens.failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      pruned: result.value.pruned,
      cutoff_iso: result.value.cutoffIso,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...body },
      'cron.renewals.prune_consumed_tokens.complete',
    );
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.prune_consumed_tokens.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
