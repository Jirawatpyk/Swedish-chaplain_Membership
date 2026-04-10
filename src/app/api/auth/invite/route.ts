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
 *   500 — server-error (infra failure during session lookup / RBAC)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { createUser } from '@/modules/auth/application/create-user';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';

const inputSchema = z.object({
  email: z.string().email().max(254),
  role: z.enum(['admin', 'manager', 'member']),
  displayName: z.string().min(1).max(120).optional(),
  locale: z.enum(['en', 'th', 'sv']).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireAdminContext(request);
  if ('response' in ctx) return ctx.response;

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
    actorUserId: ctx.current.user.id,
    sourceIp: ctx.sourceIp,
    requestId: ctx.requestId,
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
      logger.error(
        { requestId: ctx.requestId },
        'invite: unhandled error variant',
      );
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
