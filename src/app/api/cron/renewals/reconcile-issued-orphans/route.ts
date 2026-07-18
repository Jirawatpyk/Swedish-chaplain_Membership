/**
 * 107-auto-invoice Task 11 — Daily reconcile-issued-orphans housekeeping cron.
 *
 * Backstop for `issueAutoDraftedRenewal`'s link-step failure
 * (`F8.AUTO_ISSUE.LINK_FAILED`): re-links an `origin='auto_renewal'
 * status='issued'` invoice to its cycle when `linked_invoice_id` never got
 * stamped. See `reconcile-issued-orphans.ts`'s module docstring for the
 * full design rationale.
 *
 * Single-route housekeeping shape — mirrors `prune-consumed-tokens/route.ts`
 * (no `[tenantId]` segment, no coordinator/worker fan-out).
 *
 * Auth: Bearer via `CRON_SECRET` (through `gateCronBearerOrRespond`).
 *
 * Three-key dark-ship (design §5.7) — env layer: BOTH
 * `FEATURE_F8_RENEWALS` and `FEATURE_AUTO_INVOICE` must be `true`, else
 * `200 {skipped: true}` (never 503).
 *
 * READ_ONLY_MODE: short-circuits to 200 + skipped + observability counter.
 *
 * Concurrency: each candidate's relink acquires the SAME per-cycle
 * advisory lock (`renewals:{tenant}:{cycle}`) every other cycle-mutating
 * F8 use-case uses — see the use-case module docstring.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { reconcileIssuedOrphans, makeRenewalsDeps } from '@/modules/renewals';

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
    route: '/api/cron/renewals/reconcile-issued-orphans',
    metricsCounter: () =>
      renewalsMetrics.coordinatorAuditEmitFailed('reconcile_issued_orphans'),
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
    renewalsMetrics.coordinatorSkippedReadOnly('reconcile_issued_orphans');
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
    const result = await reconcileIssuedOrphans(deps, {
      tenantId,
      correlationId,
    });
    if (!result.ok) {
      logger.error(
        { tenantId, correlationId, errorKind: result.error.kind },
        'cron.renewals.reconcile_issued_orphans.failed',
      );
      renewalsMetrics.reconcileIssuedOrphansRunCompleted(tenantId, 'failure');
      return NextResponse.json(
        { error: { code: 'server_error' }, tenant_id: tenantId },
        { status: 500 },
      );
    }

    const body = {
      skipped: false as const,
      tenant_id: tenantId,
      candidates_found: result.value.candidatesFound,
      relinked: result.value.relinked,
      skipped_terminal: result.value.skippedTerminal,
      skipped_conflict: result.value.skippedConflict,
      skipped_gone: result.value.skippedGone,
      skipped_invoice_not_issued: result.value.skippedInvoiceNotIssued,
      errors: result.value.errors,
      duration_ms: Date.now() - startedAt,
    };
    logger.info(
      { tenantId, correlationId, ...body },
      'cron.renewals.reconcile_issued_orphans.complete',
    );
    renewalsMetrics.reconcileIssuedOrphansRunCompleted(tenantId, 'success');
    renewalsMetrics.reconcileIssuedOrphansRelinked(tenantId, result.value.relinked);
    return NextResponse.json(body);
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        tenantId,
        correlationId,
      },
      'cron.renewals.reconcile_issued_orphans.unexpected_error',
    );
    renewalsMetrics.reconcileIssuedOrphansRunCompleted(tenantId, 'failure');
    return NextResponse.json(
      { error: { code: 'server_error' }, tenant_id: tenantId },
      { status: 500 },
    );
  }
}
