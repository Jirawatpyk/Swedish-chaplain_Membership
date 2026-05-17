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
    // S4 (Round 4) — clearSessionCookie() is itself wrapped so a
    // platform-level cookie-store failure surfaces as a structured
    // 500 with requestId (via the `if (failed)` branch below)
    // rather than a raw Next.js HTML 500 with no correlation handle.
    try {
      await clearSessionCookie();
    } catch (cookieErr) {
      failed = true;
      logger.error(
        { err: cookieErr, requestId },
        'sign_out.clear_cookie_failed',
      );
    }
  }

  if (failed) {
    // M1 (Round 3) — include requestId in body for client-side log
    // correlation. Matches the B3 pattern in the other 7 auth routes.
    return NextResponse.json(
      { error: 'server-error', requestId },
      { status: 500 },
    );
  }

  logger.info({ requestId, hadSession }, 'sign_out completed');
  return NextResponse.json({ ok: true }, { status: 200 });
}
