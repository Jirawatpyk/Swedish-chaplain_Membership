/**
 * POST /api/auth/users/[id]/disable (T130, contracts/auth-api.md § 8).
 *
 * Admin-only. Disables a user account + kills their sessions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { disableUser, asUserId } from '@/modules/auth';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;

  const { id } = await params;
  const result = await disableUser({
    targetUserId: asUserId(id),
    actorUserId: ctx.current.user.id,
    sourceIp: ctx.sourceIp,
    requestId: ctx.requestId,
  });

  if (result.ok) {
    return NextResponse.json(
      { ok: true, sessionsRevoked: result.value.sessionsRevoked },
      { status: 200 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'not-found':
      return NextResponse.json({ error: 'not-found' }, { status: 404 });
    case 'already-disabled':
      return NextResponse.json({ error: 'already-disabled' }, { status: 409 });
    case 'last-admin-protection':
      return NextResponse.json({ error: 'last-admin-protection' }, { status: 409 });
    default: {
      logger.error({ requestId: ctx.requestId }, 'disable-user: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
