/**
 * 107-auto-invoice Task 11 — Daily prune-auto-drafts housekeeping cron.
 *
 * Discards `origin='auto_renewal' status='draft'` invoices whose cycle has
 * LEFT the `upcoming|reminded` eligibility window (member self-renewed, or
 * the cycle lapsed after a T-30ish draft). See `prune-auto-drafts.ts`'s
 * module docstring for the full design rationale.
 *
 * Single-route housekeeping shape — mirrors `prune-consumed-tokens/route.ts`
 * (no `[tenantId]` segment, no coordinator/worker fan-out; MVP
 * single-tenant does the whole tenant's pass in one invocation).
 *
 * Auth: Bearer via `CRON_SECRET` (through `gateCronBearerOrRespond` —
 * adds rate-limit + `cron_bearer_auth_rejected` audit on 401 path).
 *
 * Three-key dark-ship (design §5.7) — env layer: BOTH
 * `FEATURE_F8_RENEWALS` and `FEATURE_AUTO_INVOICE` must be `true`, else
 * `200 {skipped: true}` (never 503 — Vercel cron must not retry-storm).
 * A tenant with the flags OFF can still have PRE-EXISTING auto-drafted
 * rows from when the flags were on; this cron intentionally stays gated
 * behind the SAME flags as the feature that creates them (consistent
 * dark-ship contract, not a correctness requirement — the housekeeping
 * itself has no destructive effect on non-auto-invoice data either way).
 *
 * READ_ONLY_MODE: short-circuits to 200 + skipped + observability counter
 * (mirrors every other F8 cron route).
 *
 * Concurrency: NO advisory lock at the route/use-case boundary — each
 * candidate's discard is individually guarded (see the use-case's own
 * per-row transaction + the F4 bridge's status-guarded DELETE statement).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { pruneAutoDrafts, makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Vercel-native Cron invokes each scheduled path with a GET; this handler's
// Bearer-gated logic lives in POST. Alias GET → POST so one handler serves
// both the Vercel cron (GET) and any manual/legacy POST trigger. POST is
// hoisted, so the forward ref is safe.
// See docs/runbooks/cron-jobs.md § "Migration path: Pro plan".
export const GET = POST;

export async function POST(request: NextRequest): Promise<NextResponse> {
  const gateResponse = await gateCronBearerOrRespond(request, {
    route: '/api/cron/renewals/prune-auto-drafts',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('prune_auto_drafts'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gateResponse) {
    return gateResponse;
  }

  if (!env.features.f8Renewals || !env.features.autoInvoice) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }

  if (env.flags.readOnlyMode) {
    renewalsMetrics.coordinatorSkippedReadOnly('prune_auto_drafts');
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const correlationId = uuidv7();
  const tenantId = env.tenant.slug;
  const deps = makeRenewalsDeps(tenantId);
  const startedAt = Date.now();

  try {
    const result = await pruneAutoDrafts(deps, { tenantId, correlationId });
    if (!result.ok) {
      logger.error(
        { tenantId, correlationId, errorKind: result.error.kind },
        'cron.renewals.prune_auto_drafts.failed',
      );
      renewalsMetrics.pruneAutoDraftsRunCompleted(tenantId, 'failure');
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      candidates_found: result.value.candidatesFound,
      pruned: result.value.pruned,
      skipped_already_gone: result.value.skippedAlreadyGone,
      errors: result.value.errors,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...body },
      'cron.renewals.prune_auto_drafts.complete',
    );
    renewalsMetrics.pruneAutoDraftsRunCompleted(tenantId, 'success');
    renewalsMetrics.pruneAutoDraftsPruned(tenantId, result.value.pruned);
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.prune_auto_drafts.unexpected_error',
    );
    renewalsMetrics.pruneAutoDraftsRunCompleted(tenantId, 'failure');
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
