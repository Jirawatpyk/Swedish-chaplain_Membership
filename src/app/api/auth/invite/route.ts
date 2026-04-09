/**
 * POST /api/auth/invite (T128, contracts/auth-api.md § 6).
 *
 * Admin-only. Creates a pending user + invitation + sends email.
 * Maps Result union to HTTP:
 *   201 — { user }
 *   400 — invalid-input
 *   401 — no-session
 *   403 — forbidden (with manager_denied_write audit emission)
 *   409 — email-taken
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createUser } from '@/modules/auth/application/create-user';
import { getCurrentSession } from '@/lib/auth-session';
import { requireRole } from '@/lib/rbac-guard';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'manager', 'member']),
  displayName: z.string().min(1).max(120).optional(),
  locale: z.enum(['en', 'th', 'sv']).optional(),
});

function clientIp(request: NextRequest): string {
  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first;
  }
  return request.headers.get('x-real-ip') ?? '0.0.0.0';
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: 'no-session' }, { status: 401 });
  }

  const guard = await requireRole(current, 'auth:user', 'write', {
    sourceIp: clientIp(request),
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
      { error: 'invalid-input', message: 'Invalid request body' },
      { status: 400 },
    );
  }

  const result = await createUser({
    email: parsed.data.email,
    role: parsed.data.role,
    displayName: parsed.data.displayName ?? null,
    actorUserId: current.user.id,
    sourceIp: clientIp(request),
    requestId,
    locale: parsed.data.locale,
  });

  if (result.ok) {
    const { user } = result.value;
    return NextResponse.json(
      {
        user: {
          id: user.id,
          email: user.email,
          role: user.role,
          status: user.status,
          displayName: user.displayName,
        },
      },
      { status: 201 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'invalid-input':
      return NextResponse.json({ error: 'invalid-input' }, { status: 400 });
    case 'email-taken':
      return NextResponse.json({ error: 'email-taken' }, { status: 409 });
    default: {
      logger.error({ requestId }, 'invite: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
