/**
 * POST /api/auth/users/[id]/enable (T131, contracts/auth-api.md § 9).
 *
 * Admin-only. Transitions disabled → active.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { enableUser } from '@/modules/auth/application/enable-user';
import { asUserId } from '@/modules/auth/domain/branded';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;

  const { id } = await params;
  const result = await enableUser({
    targetUserId: asUserId(id),
    actorUserId: ctx.current.user.id,
    sourceIp: ctx.sourceIp,
    requestId: ctx.requestId,
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
      logger.error({ requestId: ctx.requestId }, 'enable-user: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
