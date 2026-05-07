/**
 * F8 Phase 5 Wave C · T140 — Per-tenant reconcile-pending-reactivations.
 *
 * Invoked by the coordinator (T139) for each active tenant. Runs the
 * `reconcilePendingReactivations` use-case (T138) which walks pending
 * cycles + emits reminder ladder audits + auto-times-out at >= 30 days.
 *
 * Auth: Bearer `CRON_SECRET` (same as coordinator). Kill-switch
 * mirrors coordinator semantics — short-circuits with 200 + skipped.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import {
  reconcilePendingReactivations,
  makeRenewalsDeps,
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
  const correlationId =
    request.headers.get('x-request-id') ?? uuidv7();
  const startedAt = Date.now();

  try {
    const deps = makeRenewalsDeps(tenantId);
    const result = await reconcilePendingReactivations(deps, {
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
      reminders_t7: result.value.remindersT7,
      reminders_t3: result.value.remindersT3,
      reminders_t1: result.value.remindersT1,
      // Round 2 review-fix (I-6): SRE-visible reminder-emit failures.
      // Round 1 silently swallowed these into a `logger.warn`. Now the
      // success counters above only bump on emit-success and this
      // counter tracks failures (parity with timeout_refund_failures).
      reminders_failed: result.value.remindersFailed,
      timed_out: result.value.timedOut,
      timeout_refund_failures: result.value.timeoutRefundFailures,
      duration_ms: Date.now() - startedAt,
    });
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        tenantId,
      },
      'cron.renewals.reconcile-pending.per-tenant.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'server_error' } },
      { status: 500 },
    );
  }
}
