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
import { quotaResponseBody } from '@/lib/broadcasts-draft-response';
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
      // Exhaustive switch — keeps the error-code surface accurate
      // (`broadcast_not_found` was misleading for a member-not-found
      // probe; on-call would search for a missing broadcast).
      switch (result.error.kind) {
        case 'quota.member_not_found':
          return errorResponse(404, 'broadcast_member_not_found', correlationId);
        case 'quota.invariant_violation':
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
        default: {
          const _exhaustive: never = result.error;
          logger.error(
            {
              correlationId,
              tenantId: ctx.tenant.slug,
              memberId: ctx.member.memberId,
              err: _exhaustive,
            },
            'broadcasts.quota.unhandled_error_variant',
          );
          return errorResponse(500, 'internal_error', correlationId);
        }
      }
    }

    // F119 T145 — the envelope is shared with the staff
    // `/api/admin/broadcasts/quota`, which reads the SAME counter for a member
    // named in the query. `QuotaDisplay` takes only an endpoint, so the two
    // must not drift a field at a time.
    return NextResponse.json(quotaResponseBody(result.value), {
      status: 200,
      headers: baseHeaders(correlationId),
    });
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
