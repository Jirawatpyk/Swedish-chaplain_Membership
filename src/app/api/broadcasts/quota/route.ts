/**
 * T078 — GET `/api/broadcasts/quota`.
 *
 * Returns the derived quota counter for the signed-in member's current
 * quota year. Backs the smart-features Benefit Dashboard surface.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  computeQuotaCounter,
  makeComputeQuotaDeps,
} from '@/modules/broadcasts';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  const deps = makeComputeQuotaDeps(ctx.tenant.slug);
  try {
    const result = await computeQuotaCounter(deps, {
      memberId: ctx.member.memberId,
    });
    if (!result.ok) {
      if (result.error.kind === 'quota.member_not_found') {
        return errorResponse(404, 'broadcast_not_found', correlationId);
      }
      logger.error(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          memberId: ctx.member.memberId,
          err: result.error,
        },
        'broadcasts.quota.invariant_violation',
      );
      return errorResponse(500, 'internal_error', correlationId);
    }

    const { counter, quotaYear, planCode, planId } = result.value;

    // Smart-4: humanize planCode to a display name (e.g.,
    // "premium_corporate" → "Premium Corporate"). Avoids extending the
    // F2 bridge contract just for a UI label.
    const planName =
      planCode.length > 0
        ? planCode
            .split(/[_-]/)
            .map((p) => (p.length === 0 ? p : p[0]!.toUpperCase() + p.slice(1)))
            .join(' ')
        : null;

    return NextResponse.json(
      {
        planId,
        planCode,
        planName,
        eblastPerYear: counter.cap,
        quotaYear,
        used: counter.used,
        reserved: counter.reserved,
        remaining: counter.remaining,
        cap: counter.cap,
      },
      {
        status: 200,
        headers: baseHeaders(correlationId),
      },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.member.memberId,
      },
      'broadcasts.quota.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
