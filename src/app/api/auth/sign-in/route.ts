/**
 * POST /api/auth/sign-in (T070, contracts/auth-api.md § 1).
 *
 * Validates the input with zod, calls the sign-in use case, sets the
 * session cookie on success, and maps the Result union to HTTP status
 * codes per the contract:
 *
 *   200 — { user: { id, email, role, displayName }, redirect }
 *   400 — invalid-input
 *   401 — invalid-credentials (collapses email-not-found, wrong-password,
 *          portal mismatch, AND pending-account into a single uniform
 *          response — T-03 enumeration defence)
 *   403 — account-disabled / account-locked
 *   429 — rate-limited (with Retry-After header)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { signIn } from '@/modules/auth/application/sign-in';
import { setSessionCookie } from '@/lib/auth-cookies';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(1).max(256),
  portal: z.enum(['staff', 'member']),
});

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
      {
        error: 'invalid-input',
        message: 'Invalid request body',
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const result = await signIn({
    email: parsed.data.email,
    password: parsed.data.password,
    portal: parsed.data.portal,
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
          displayName: user.displayName,
        },
        redirect: parsed.data.portal === 'staff' ? '/admin' : '/portal',
      },
      { status: 200 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'invalid-credentials':
      return NextResponse.json(
        { error: 'invalid-credentials' },
        { status: 401 },
      );
    case 'account-disabled':
      return NextResponse.json(
        { error: 'account-disabled' },
        { status: 403 },
      );
    case 'account-locked':
      return NextResponse.json(
        { error: 'account-locked' },
        {
          status: 403,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
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
      // Exhaustive — should never hit
      logger.error({ requestId }, 'sign-in: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
