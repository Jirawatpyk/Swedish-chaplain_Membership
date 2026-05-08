/**
 * F8 Phase 5 wave K24 · T115a — Per-tenant lapse-cycles-on-grace-expiry.
 *
 * Invoked by the coordinator for each active tenant. Runs the
 * `lapseCyclesOnGraceExpiry` use-case which walks `awaiting_payment`
 * cycles past the grace boundary + transitions them to `lapsed`
 * with the specific `closed_reason` per AS3.
 *
 * Auth: Bearer `CRON_SECRET`. Kill-switch mirrors coordinator
 * semantics — short-circuits with 200 + skipped.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { verifyCronBearer } from '@/lib/cron-auth';
import { uuidv7 } from '@/lib/request-id';
import {
  lapseCyclesOnGraceExpiry,
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
  const correlationId = request.headers.get('x-request-id') ?? uuidv7();
  const startedAt = Date.now();

  try {
    const deps = makeRenewalsDeps(tenantId);
    const result = await lapseCyclesOnGraceExpiry(deps, {
      tenantId,
      now: new Date(),
      correlationId,
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
          status: result.error.kind === 'tenant_settings_not_found' ? 500 : 400,
        },
      );
    }
    return NextResponse.json({
      skipped: false,
      cycles_processed: result.value.cyclesProcessed,
      grace_expired: result.value.graceExpired,
      payment_failed: result.value.paymentFailed,
      transition_race_skipped: result.value.transitionRaceSkipped,
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
