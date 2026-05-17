/**
 * POST /api/auth/redeem-invite (T129, contracts/auth-api.md § 7).
 *
 * Public endpoint (anyone holding the token). Validates the token,
 * applies password policy, transitions pending→active, creates the
 * initial session (auto sign-in), sets the cookie, returns 200 with
 * redirectTo.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { redeemInvite, asTokenId } from '@/modules/auth';
import { setSessionCookie } from '@/lib/auth-cookies';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(1).max(256),
  displayName: z.string().min(1).max(120).optional(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  // B3 — outer try/catch wraps the full body so any infra throw
  // (Neon, sessions.create row-not-returned, Drizzle constraint blip
  // mid-tx) surfaces as a structured 500 with requestId, not a raw
  // Next.js HTML 500. See sign-in/route.ts B3 note.
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
    return NextResponse.json(
      { error: 'invalid-input', message: 'Invalid request body' },
      { status: 400 },
    );
  }

  const result = await redeemInvite({
    token: asTokenId(parsed.data.token),
    password: parsed.data.password,
    displayName: parsed.data.displayName ?? null,
    sourceIp: getClientIp(request),
    requestId,
  });

  if (result.ok) {
    await setSessionCookie(result.value.session.id);
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
        redirectTo: result.value.redirectTo,
      },
      { status: 200 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'link-invalid': {
      // B1 (post-ship 2026-05-17) — collapsed 404/410 split to a uniform
      // 410 Gone. The previous status-code distinction (404 vs 410)
      // leaked which random 64-hex strings hit real issued invitations.
      // The internal `error.reason` still drives logs + metrics.
      logger.warn(
        { requestId, reason: error.reason },
        'redeem-invite.link-invalid',
      );
      return NextResponse.json({ error: 'link-invalid' }, { status: 410 });
    }
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
      logger.error({ requestId }, 'redeem-invite: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
  } catch (error) {
    logger.error({ err: error, requestId }, 'redeem-invite.infra-error');
    return NextResponse.json(
      { error: 'server-error', requestId },
      { status: 500 },
    );
  }
}
