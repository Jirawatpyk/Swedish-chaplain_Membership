/**
 * 107-auto-invoice Task 8 — Per-tenant auto-draft cron worker.
 *
 * Invoked by `auto-draft-coordinator` for each active tenant. Runs
 * Task 7's `autoDraftDueRenewals` use-case, which pre-fills a
 * `status='draft', origin='auto_renewal'` membership invoice for every
 * enrolled member whose current `upcoming|reminded` cycle has entered
 * its billing-cycle lead window — no §87 number, no PDF, no email
 * (design §5.2/§5.9).
 *
 * Auth: Bearer `CRON_SECRET` via `gateCronBearerOrRespond` — same
 * defence as every other F8 per-tenant cron route (rate-limit on 401 +
 * `cron_bearer_auth_rejected` audit emit).
 *
 * Three-key dark-ship (design §5.7) — the ENV layer of the gate:
 *   1. `FEATURE_F8_RENEWALS` — the whole F8 module kill-switch.
 *   2. `FEATURE_AUTO_INVOICE` — the auto-invoice master kill-switch.
 * Both must be `true` or this route short-circuits to `200 {skipped:
 * true}` — never a 503, so Vercel/cron never retry-storms. Key #3
 * (`tenant_invoice_settings.auto_invoice_enabled`) and the lead-day/
 * page-size cadence are enforced INSIDE `autoDraftDueRenewals` itself
 * (Task 7) — this route does not duplicate that check.
 *
 * Deliberately does NOT wrap the use-case call in an outer
 * `runInTenant` + advisory lock (unlike `enter-awaiting-payment`'s
 * worker). `autoDraftDueRenewals` manages its own split-tx internally
 * — tx1 (per-cycle advisory lock + re-read + checks) closes BEFORE the
 * standalone F4 `draftInvoiceForRenewal` call, then a fresh tx2
 * re-acquires the lock to stamp + audit. Wrapping THIS route in its
 * own outer tx/lock would hold an F8 transaction + advisory lock open
 * across every F4 `createInvoiceDraft` commit in the batch — exactly
 * the "never hold an F8 lock across an F4 commit" anti-pattern Task 7's
 * split-tx restructure exists to avoid. `autoDraftDueRenewals` is
 * already per-cycle-locked and dedup-idempotent, so concurrent runs of
 * this route are safe without a batch-level lock.
 *
 * MVP single-tenant guard: only `env.tenant.slug` accepted. Any other
 * slug → 400 `unknown_tenant`. Mirrors dispatch + lapse + at-risk +
 * enter-awaiting-payment per-tenant convention.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { gateCronBearerOrRespond } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import { renewalsMetrics } from '@/lib/metrics';
import { autoDraftDueRenewals, makeRenewalsDeps } from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_LABEL = '/api/cron/renewals/auto-draft/[tenantId]';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // Bearer + rate-limit + 401 audit (matches every other F8 per-tenant
  // cron route).
  const gate = await gateCronBearerOrRespond(request, {
    route: ROUTE_LABEL,
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('auto_draft'),
    rateLimitFallbackCounter: () => renewalsMetrics.redisFallback(),
  });
  if (gate !== null) return gate;

  // Env layer of the three-key dark-ship gate — key #3
  // (`auto_invoice_enabled` + cadence config) is checked inside the
  // use-case itself.
  if (!env.features.f8Renewals || !env.features.autoInvoice) {
    return NextResponse.json(
      { skipped: true, reason: 'feature_flag_disabled' },
      { status: 200 },
    );
  }
  // Write-freeze parity (audit: financial) — mirror the coordinator / prune /
  // reconcile routes so a direct authenticated POST during READ_ONLY_MODE
  // creates no draft rows.
  if (env.flags.readOnlyMode) {
    return NextResponse.json(
      { skipped: true, reason: 'read_only_mode' },
      { status: 200 },
    );
  }

  const { tenantId } = await context.params;

  // MVP single-tenant guard. Strict equality rejects path-traversal-
  // style attacks. Post-F10: validate against tenants-table membership.
  if (tenantId !== env.tenant.slug) {
    logger.warn(
      { tenantId, expectedTenant: env.tenant.slug },
      'cron.renewals.auto-draft.unknown_tenant',
    );
    return NextResponse.json(
      { error: { code: 'unknown_tenant' } },
      { status: 400 },
    );
  }

  // Generate fresh correlationId — never trust inbound `x-request-id`
  // even when called by the trusted coordinator (matches dispatch /
  // enter-awaiting-payment hardening). Coordinator + per-tenant runs
  // are joinable via `tenant_id + started_at` in audit + log.
  const correlationId = uuidv7();
  const startedAt = Date.now();

  try {
    const deps = makeRenewalsDeps(tenantId);
    const result = await autoDraftDueRenewals(deps, { tenantId, correlationId });
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
      drafted: result.value.drafted,
      skipped_existing: result.value.skippedExisting,
      skipped_race_lost: result.value.skippedRaceLost,
      skipped_terminated: result.value.skippedTerminated,
      errors: result.value.errors,
      cycles_processed: result.value.cyclesProcessed,
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId,
      },
      'cron.renewals.auto-draft.per-tenant.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
