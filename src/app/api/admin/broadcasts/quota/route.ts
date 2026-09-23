/**
 * F119 T145 (US6-AS5, FR-039) — GET `/api/admin/broadcasts/quota?memberId=`.
 *
 * The staff read of a NAMED member's E-Blast allowance, so the compose-on-behalf
 * screen can show the member's remaining quota before staff spend it. The
 * member's own `/api/broadcasts/quota` resolves the member from the SESSION
 * (`requireMemberContext`), which a staff user can never satisfy for someone
 * else — this route reuses the same `computeQuotaCounter` with the member taken
 * from the query and returns the same envelope
 * (`quotaResponseBody`), so `QuotaDisplay` renders it unchanged.
 *
 * `broadcasts.read`: reading an allowance is a read, so a `manager` sees it;
 * a member session is refused by the gate. No write, so no write bucket.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { computeQuotaCounter, makeComputeQuotaDeps } from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { quotaResponseBody } from '@/lib/broadcasts-draft-response';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';

const MemberIdSchema = z.string().uuid();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.read');
  if ('response' in ctx) return ctx.response;

  const parsed = MemberIdSchema.safeParse(
    request.nextUrl.searchParams.get('memberId') ?? undefined,
  );
  if (!parsed.success) {
    return errorResponse(400, 'invalid_query', correlationId, {
      fieldErrors: { memberId: ['memberId must be a uuid'] },
    });
  }
  const memberId = parsed.data;
  const tenantCtx = resolveTenantFromRequest(request);

  try {
    const result = await computeQuotaCounter(makeComputeQuotaDeps(tenantCtx.slug), {
      memberId: asMemberId(memberId),
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'quota.member_not_found':
          // Same code the member route uses — an on-call reader must not be
          // sent looking for a missing broadcast.
          return errorResponse(404, 'broadcast_member_not_found', correlationId);
        case 'quota.invariant_violation':
          logger.error(
            {
              correlationId,
              tenantId: tenantCtx.slug,
              err: result.error.kind,
              errorId: 'M119.admin.quota.invariant',
            },
            'admin.broadcasts.quota.invariant_violation',
          );
          return errorResponse(500, 'internal_error', correlationId);
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          logger.error(
            {
              correlationId,
              tenantId: tenantCtx.slug,
              errorId: 'M119.admin.quota.unhandled_variant',
            },
            'admin.broadcasts.quota.unhandled_error_variant',
          );
          return errorResponse(500, 'internal_error', correlationId);
        }
      }
    }

    return NextResponse.json(quotaResponseBody(result.value), {
      status: 200,
      headers: baseHeaders(correlationId),
    });
  } catch (e) {
    logger.error(
      {
        err: errKind(e),
        correlationId,
        tenantId: tenantCtx.slug,
        errorId: 'M119.admin.quota.unexpected',
      },
      'admin.broadcasts.quota.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
