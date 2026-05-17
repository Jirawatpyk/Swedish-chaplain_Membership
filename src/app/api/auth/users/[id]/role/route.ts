/**
 * POST /api/auth/users/[id]/role (T132, contracts/auth-api.md § 10).
 *
 * Admin-only. Changes a user's role + invalidates all their sessions.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { changeRole, asUserId } from '@/modules/auth';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

const inputSchema = z.object({
  newRole: z.enum(['admin', 'manager', 'member']),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;
  // B3 — outer try/catch (see sign-in/route.ts B3 note).
  try {
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
      return NextResponse.json({ error: 'invalid-role' }, { status: 400 });
    }

    const { id } = await params;
    const result = await changeRole({
      targetUserId: asUserId(id),
      newRole: parsed.data.newRole,
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
      case 'same-role':
        return NextResponse.json({ error: 'same-role' }, { status: 409 });
      case 'role-portal-mismatch':
        return NextResponse.json(
          { error: 'role-portal-mismatch' },
          { status: 400 },
        );
      case 'last-admin-protection':
        return NextResponse.json(
          { error: 'last-admin-protection' },
          { status: 409 },
        );
      default: {
        logger.error(
          { requestId: ctx.requestId },
          'change-role: unhandled error variant',
        );
        return NextResponse.json({ error: 'server-error' }, { status: 500 });
      }
    }
  } catch (error) {
    logger.error(
      { err: error, requestId: ctx.requestId },
      'change-role.infra-error',
    );
    return NextResponse.json(
      { error: 'server-error', requestId: ctx.requestId },
      { status: 500 },
    );
  }
}
