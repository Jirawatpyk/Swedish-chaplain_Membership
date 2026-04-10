/**
 * POST /api/auth/users/[id]/enable (T131, contracts/auth-api.md § 9).
 *
 * Admin-only. Transitions disabled → active.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { enableUser } from '@/modules/auth/application/enable-user';
import { asUserId } from '@/modules/auth/domain/branded';
import { getCurrentSession } from '@/lib/auth-session';
import { requireRole } from '@/lib/rbac-guard';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: 'no-session' }, { status: 401 });
  }

  const guard = await requireRole(current, 'auth:user', 'write', {
    sourceIp: getClientIp(request),
    requestId,
  });
  if (!guard.ok) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }

  const { id } = await params;
  const targetUserId = asUserId(id);

  const result = await enableUser({
    targetUserId,
    actorUserId: current.user.id,
    sourceIp: getClientIp(request),
    requestId,
  });

  if (result.ok) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const { error } = result;
  switch (error.code) {
    case 'not-found':
      return NextResponse.json({ error: 'not-found' }, { status: 404 });
    case 'not-disabled':
      return NextResponse.json({ error: 'not-disabled' }, { status: 409 });
    default: {
      logger.error({ requestId }, 'enable-user: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
