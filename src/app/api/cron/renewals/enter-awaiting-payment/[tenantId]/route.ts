/**
 * F8-completion slice 2 · Task 2.4 — Per-tenant enter-awaiting-payment
 * (T-0) cron.
 *
 * Invoked by the coordinator for each active tenant. Runs the
 * `enterAwaitingPaymentOnExpiry` use-case which walks cycles in
 * `upcoming`/`reminded` whose `expires_at <= now` + flips them to
 * `awaiting_payment` so the member self-service confirm + paid-completion
 * paths become reachable.
 *
 * Auth: Bearer `CRON_SECRET` via `gateCronBearerOrRespond` — same
 * defence as the dispatch + lapse + at-risk per-tenant routes (rate-limit
 * on 401 + `cron_bearer_auth_rejected` audit emit). Kill-switch mirrors
 * coordinator semantics — short-circuits with 200 + skipped.
 *
 * Per-tenant advisory lock: `renewals:enter-awaiting:<tenantId>`. Auto-
 * released at tx end + DISJOINT from `renewals:lapse:`/`dispatch:`/
 * `at-risk:`/`tierupgrade:` (and the cross-feature `invoicing:`/
 * `payments:`/`broadcasts:` namespaces), so the cron passes can run
 * concurrently on the same tenant. Concurrent cron-job.org retries
 * serialise so the "list eligible cycles" query is not double-issued.
 *
 * MVP single-tenant guard: only `env.tenant.slug` accepted. Any other
 * slug → 400 `unknown_tenant`. Mirrors dispatch + lapse + at-risk
 * per-tenant convention.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { runInTenant } from '@/lib/db';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { asTenantContext } from '@/modules/tenants';
import {
  enterAwaitingPaymentOnExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_LABEL = '/api/cron/renewals/enter-awaiting-payment/[tenantId]';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // Bearer + rate-limit + 401 audit (matches dispatch/lapse/at-risk).
  const gate = await gateCronBearerOrRespond(request, {
    route: ROUTE_LABEL,
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('enter_awaiting'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gate !== null) return gate;

  if (!env.features.f8Renewals) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  const { tenantId } = await context.params;

  // MVP single-tenant guard. Strict equality rejects path-traversal-
  // style attacks. Post-F10: validate against tenants-table membership.
  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.enter-awaiting.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  // Generate fresh correlationId — never trust inbound `x-request-id`
  // even when called by the trusted coordinator (matches dispatch K1-C1
  // hardening). Coordinator + per-tenant runs are joinable via
  // `tenant_id + started_at` in audit + log.
  const correlationId = uuidv7();
  const tenantCtx = asTenantContext(tenantId);
  const startedAt = Date.now();

  try {
    return await runInTenant(tenantCtx, async (tx) => {
      // Per-tenant advisory lock — `renewals:enter-awaiting:<tenantId>`
      // is distinct from `renewals:lapse:` + `renewals:dispatch:` +
      // `renewals:at-risk:` + `renewals:tierupgrade:` so the cron
      // passes can run concurrently on the same tenant. Cross-feature
      // namespaces stay disjoint: F4 `invoicing:`, F5 `payments:`, F7
      // `broadcasts:`. Auto-released at tx-end.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:enter-awaiting:'||${tenantId}, 0))`,
      );

      const deps = makeRenewalsDeps(tenantId);
      const result = await enterAwaitingPaymentOnExpiry(deps, {
        tenantId,
        now: new Date(),
        correlationId,
      });
      if (!result.ok) {
        return NextResponse.json(
          {
            error: {
              code: result.error.kind,
              message: result.error.message,
            },
          },
          { status: 400 },
        );
      }
      return NextResponse.json({
        skipped: false,
        cycles_processed: result.value.cyclesProcessed,
        flipped: result.value.flipped,
        race_skipped: result.value.raceSkipped,
        errors: result.value.errors,
        duration_ms: Date.now() - startedAt,
      });
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId,
      },
      'cron.renewals.enter-awaiting.per-tenant.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
