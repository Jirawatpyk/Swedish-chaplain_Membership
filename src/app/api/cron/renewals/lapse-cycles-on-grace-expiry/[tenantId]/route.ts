/**
 * F8 Phase 5 wave K24 · T115a — Per-tenant lapse-cycles-on-grace-expiry.
 *
 * Invoked by the coordinator for each active tenant. Runs the
 * `lapseCyclesOnGraceExpiry` use-case which walks `awaiting_payment`
 * cycles past the grace boundary + transitions them to `lapsed`
 * with the specific `closed_reason` per AS3.
 *
 * Auth: Bearer `CRON_SECRET` via `gateCronBearerOrRespond` — gives this
 * route the same defence as the dispatch + at-risk per-tenant routes
 * (rate-limit on 401 + `cron_bearer_auth_rejected` audit emit). Kill-
 * switch mirrors coordinator semantics — short-circuits with 200 +
 * skipped.
 *
 * Per-tenant advisory lock: `renewals:lapse:<tenantId>`. Auto-released
 * at tx end. Concurrent cron-job.org retries serialise so the
 * "list eligible cycles" query is not double-issued.
 *
 * MVP single-tenant guard: only `env.tenant.slug` accepted. Any other
 * slug → 400 `unknown_tenant`. Mirrors dispatch + at-risk per-tenant
 * convention; closes the 4-of-5-handlers-validated gap surfaced in the
 * deep review.
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
  createEscalationTask,
  lapseCyclesOnGraceExpiry,
  makeRenewalsDeps,
} from '@/modules/renewals';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROUTE_LABEL = '/api/cron/renewals/lapse-cycles-on-grace-expiry/[tenantId]';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ tenantId: string }> },
): Promise<NextResponse> {
  // Bearer + rate-limit + 401 audit (matches dispatch/at-risk).
  const gate = await gateCronBearerOrRespond(request, {
    route: ROUTE_LABEL,
    metricsCounter: () => renewalsMetrics.coordinatorAuditEmitFailed('lapse'),
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
      'cron.renewals.lapse-cycles.unknown_tenant',
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
    const deps = makeRenewalsDeps(tenantId);
    const result = await runInTenant(tenantCtx, async (tx) => {
      // Per-tenant advisory lock — `renewals:lapse:<tenantId>` is
      // distinct from `renewals:dispatch:` + `renewals:at-risk:` +
      // `renewals:tierupgrade:` so the four cron passes can run
      // concurrently on the same tenant. Cross-feature namespaces stay
      // disjoint: F4 `invoicing:`, F5 `payments:`, F7 `broadcasts:`.
      // Auto-released at tx-end.
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended('renewals:lapse:'||${tenantId}, 0))`,
      );

      return lapseCyclesOnGraceExpiry(deps, {
        tenantId,
        now: new Date(),
        correlationId,
      });
    });
    if (!result.ok) {
      return NextResponse.json(
        {
          error: {
            code: result.error.kind,
            message:
              result.error.kind === 'invalid_input'
                ? result.error.message
                : 'tenant_renewal_settings row missing',
          },
        },
        {
          status:
            result.error.kind === 'tenant_settings_not_found' ? 500 : 400,
        },
      );
    }

    // 066 §3.2(3) — turn every dormancy-guard deferral into an
    // ADMIN-visible escalation task. Runs OUTSIDE the advisory-lock tx
    // (createEscalationTask opens its own tenant tx — nesting it inside
    // the lock tx is the documented pool-starvation class). Idempotent:
    // the (tenant, member, cycle, task_type) WHERE status='open' unique
    // index makes daily re-runs a no-op. Best-effort — a task-write
    // failure must not fail the cron response (the counter + metric
    // already recorded the deferral).
    for (const d of result.value.deferredNoPriorWarningCycles) {
      try {
        await createEscalationTask(deps, {
          tenantId,
          memberId: d.memberId,
          cycleId: d.cycleId,
          taskType: 'termination_warning_blocked',
          assignedToRole: 'admin',
          dueAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          triggerReason: 'scheduled_cron_step',
          actorUserId: null,
          actorRole: 'cron',
          correlationId,
          summary:
            'due+60 termination deferred — member has never received a statutory warning (blocked warning channel); fix the contact/email data or use the manual renew/cancel flows',
        });
      } catch (escErr) {
        logger.error(
          {
            err: escErr instanceof Error ? escErr : new Error(String(escErr)),
            cycleId: d.cycleId,
            tenantId,
            correlationId,
          },
          'cron.renewals.lapse-cycles.warning-blocked-escalation-failed',
        );
      }
    }

    return NextResponse.json({
      skipped: false,
      cycles_processed: result.value.cyclesProcessed,
      grace_expired: result.value.graceExpired,
      payment_failed: result.value.paymentFailed,
      transition_race_skipped: result.value.transitionRaceSkipped,
      // 065 §5.2 (final-review V8) — the deferred branches are the bulk
      // of `cycles_processed` now that selection is ALL awaiting_payment
      // cycles; without them the operator surface (cron-job.org history)
      // cannot verify the SC sum invariant: grace_expired +
      // payment_failed + transition_race_skipped + the five counters
      // below === cycles_processed.
      deferred_invoice_not_due: result.value.deferredInvoiceNotDue,
      deferred_within_termination_window:
        result.value.deferredWithinTerminationWindow,
      deferred_no_invoice_backstop: result.value.deferredNoInvoiceBackstop,
      // 066 §3.2(3) — dormancy-guard deferrals (each also raises an
      // idempotent `termination_warning_blocked` escalation task).
      deferred_no_prior_warning: result.value.deferredNoPriorWarning,
      deferred_guard_errors: result.value.deferredGuardErrors,
      errors: result.value.errors,
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId,
      },
      'cron.renewals.lapse-cycles.per-tenant.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
