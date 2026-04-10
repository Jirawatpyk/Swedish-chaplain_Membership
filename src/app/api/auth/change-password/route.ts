/**
 * POST /api/auth/change-password (T152, contracts/auth-api.md § 5).
 *
 * Signed-in flow: verifies current password, enforces policy on the
 * new one, rotates the current session. Returns 200 with a rotated
 * Set-Cookie so the user continues signed in on their current device;
 * every OTHER session for the user is invalidated.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { changePassword } from '@/modules/auth/application/change-password';
import { getCurrentSession } from '@/lib/auth-session';
import { setSessionCookie } from '@/lib/auth-cookies';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  currentPassword: z.string().min(1).max(1000),
  newPassword: z.string().min(1).max(1000),
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

  const result = await changePassword({
    user: current.user,
    currentSessionId: current.session.id,
    currentPassword: parsed.data.currentPassword,
    newPassword: parsed.data.newPassword,
    sourceIp: clientIp(request),
    requestId,
  });

  if (result.ok) {
    // Rotate the cookie to the new session id
    await setSessionCookie(result.value.newSession.id);
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const { error } = result;
  switch (error.code) {
    case 'wrong-current-password':
      return NextResponse.json(
        { error: 'wrong-current-password' },
        { status: 403 },
      );
    case 'same-password':
      return NextResponse.json(
        { error: 'same-password' },
        { status: 400 },
      );
    case 'weak-password':
      return NextResponse.json(
        { error: 'weak-password', issues: error.errors.map((e) => e.code) },
        { status: 400 },
      );
    case 'rate-limited':
      return NextResponse.json(
        { error: 'rate-limited' },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
      );
    default: {
      logger.error({ requestId }, 'change-password: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
