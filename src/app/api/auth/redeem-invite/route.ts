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
import { redeemInvite } from '@/modules/auth/application/redeem-invite';
import { setSessionCookie } from '@/lib/auth-cookies';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  token: z.string().min(32).max(128),
  password: z.string().min(1).max(1000),
  displayName: z.string().min(1).max(120).optional(),
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
    token: parsed.data.token,
    password: parsed.data.password,
    displayName: parsed.data.displayName ?? null,
    sourceIp: clientIp(request),
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
    case 'link-invalid':
      return NextResponse.json({ error: 'link-invalid' }, { status: 410 });
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
}
