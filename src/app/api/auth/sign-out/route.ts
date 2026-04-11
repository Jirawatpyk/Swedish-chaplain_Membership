/**
 * POST /api/auth/sign-out (T071, contracts/auth-api.md § 2).
 *
 * Idempotent: returns 200 whether or not a valid session is present.
 * `clearSessionCookie()` is called in a `finally` block so the
 * cookie is ALWAYS cleared — even if both `signOut()` and the
 * logger throw. Client safety: a caller that gets any response
 * from this endpoint can trust that their cookie is gone.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionCookie, getSessionIdFromCookie } from '@/lib/auth-cookies';
import { signOut } from '@/modules/auth';
import { getClientIp } from '@/lib/client-ip';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  let hadSession = false;
  let failed = false;

  try {
    const sessionId = await getSessionIdFromCookie();
    hadSession = sessionId !== null;

    // The use case owns the session lookup + audit attribution —
    // the route handler just forwards the cookie value it has.
    await signOut({
      sessionId,
      sourceIp: getClientIp(request),
      requestId,
    });
  } catch (error) {
    failed = true;
    logger.error(
      { err: error, requestId },
      'sign_out failed — clearing cookie anyway for client safety',
    );
  } finally {
    // ALWAYS clear the cookie. `finally` guarantees this runs even
    // if the catch block itself throws (e.g., a logger init error).
    // If clearSessionCookie itself throws the request still returns
    // a 500, but the underlying Next.js cookie store going down is
    // a platform issue we can't recover from at this layer.
    await clearSessionCookie();
  }

  if (failed) {
    return NextResponse.json({ error: 'server-error' }, { status: 500 });
  }

  logger.info({ requestId, hadSession }, 'sign_out completed');
  return NextResponse.json({ ok: true }, { status: 200 });
}
