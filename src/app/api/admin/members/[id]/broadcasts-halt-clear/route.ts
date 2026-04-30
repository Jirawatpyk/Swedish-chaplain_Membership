/**
 * T114 — POST `/api/admin/members/[id]/broadcasts-halt-clear`.
 *
 * Q14 / R3-NEW-3 admin clear-halt action. Sets
 * `broadcasts_halted_until_admin_review = false` on the member row
 * and emits `broadcast_member_dispatch_resumed` audit.
 *
 * Authz: admin only (manager 403 on `broadcast` write).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  clearHalt,
  makeClearHaltDeps,
  type ClearHaltError,
} from '@/modules/broadcasts';
import { tryMemberId } from '@/modules/members';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const memberIdResult = tryMemberId(id);
  if (!memberIdResult.ok) {
    return errorResponse(404, 'broadcast_member_not_found', correlationId);
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeClearHaltDeps(tenantCtx.slug);

  try {
    const result = await clearHalt(deps, {
      memberId: memberIdResult.value as string,
      actorUserId: ctx.current.user.id,
      requestId: ctx.requestId,
    });
    if (!result.ok) {
      return mapClearHaltError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        memberId: result.value.memberId,
        clearedAt: result.value.clearedAt.toISOString(),
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        memberId: id,
      },
      'admin.broadcasts.clear_halt.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapClearHaltError(
  error: ClearHaltError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'member_not_found') {
    return errorResponse(404, 'broadcast_member_not_found', correlationId, {
      details: { memberId: error.memberId },
    });
  }
  if (error.kind === 'forbidden') {
    return errorResponse(403, 'forbidden', correlationId, {
      details: { reason: error.reason },
    });
  }
  return errorResponse(500, 'internal_error', correlationId);
}
