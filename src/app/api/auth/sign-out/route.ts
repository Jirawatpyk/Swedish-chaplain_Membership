/**
 * POST /api/auth/sign-out (T071, contracts/auth-api.md § 2).
 *
 * Idempotent: returns 200 whether or not a valid session is present.
 * Always clears the session cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionCookie, getSessionIdFromCookie } from '@/lib/auth-cookies';
import { signOut } from '@/modules/auth/application/sign-out';
import { getClientIp } from '@/lib/client-ip';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);

  try {
    const sessionId = await getSessionIdFromCookie();

    // The use case owns the session lookup + audit attribution —
    // the route handler just forwards the cookie value it has.
    await signOut({
      sessionId,
      sourceIp: getClientIp(request),
      requestId,
    });

    await clearSessionCookie();

    logger.info(
      { requestId, hadSession: sessionId !== null },
      'sign_out completed',
    );
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    logger.error(
      { err: error, requestId },
      'sign_out failed — clearing cookie anyway for client safety',
    );
    // Clear the cookie even on error so the client is not stuck signed in.
    await clearSessionCookie();
    return NextResponse.json({ error: 'server-error' }, { status: 500 });
  }
}
