/**
 * POST /api/auth/users/[id]/role (T132, contracts/auth-api.md § 10).
 *
 * Admin-only. Changes a user's role + invalidates all their sessions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { changeRole } from '@/modules/auth/application/change-role';
import { asUserId } from '@/modules/auth/domain/branded';
import { getCurrentSession } from '@/lib/auth-session';
import { requireRole } from '@/lib/rbac-guard';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  newRole: z.enum(['admin', 'manager', 'member']),
});

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

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'invalid-input', message: 'Body must be JSON' },
      { status: 400 },
    );
  }

  const parsed = inputSchema.safeParse(payload);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid-role' },
      { status: 400 },
    );
  }

  const { id } = await params;
  const result = await changeRole({
    targetUserId: asUserId(id),
    newRole: parsed.data.newRole,
    actorUserId: current.user.id,
    sourceIp: getClientIp(request),
    requestId,
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
    case 'same-role':
      return NextResponse.json({ error: 'same-role' }, { status: 409 });
    case 'role-portal-mismatch':
      return NextResponse.json({ error: 'role-portal-mismatch' }, { status: 400 });
    case 'last-admin-protection':
      return NextResponse.json({ error: 'last-admin-protection' }, { status: 409 });
    default: {
      logger.error({ requestId }, 'change-role: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
