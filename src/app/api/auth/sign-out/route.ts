/**
 * POST /api/auth/sign-out (T071, contracts/auth-api.md § 2).
 *
 * Idempotent: returns 200 whether or not a valid session is present.
 * Always clears the session cookie.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { clearSessionCookie, getSessionIdFromCookie } from '@/lib/auth-cookies';
import { sessionRepo } from '@/modules/auth/infrastructure/db/session-repo';
import { signOut } from '@/modules/auth/application/sign-out';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';

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

  try {
    const sessionId = await getSessionIdFromCookie();

    let userId: string | null = null;
    if (sessionId) {
      const session = await sessionRepo.findById(sessionId);
      if (session) {
        userId = session.userId;
      }
    }

    await signOut({
      sessionId,
      // Cast — userId is the branded UserId at the use-case boundary
      // (see Application layer types). The repo returns the same brand.
      userId: userId as never,
      sourceIp: clientIp(request),
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
