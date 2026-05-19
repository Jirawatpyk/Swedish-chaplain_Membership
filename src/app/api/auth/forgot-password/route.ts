/**
 * POST /api/auth/forgot-password (T101, contracts/auth-api.md § 3).
 *
 * Always returns 200 with a neutral body unless the request itself is
 * malformed (400) or the rate limit fires (429). This is spec FR-016
 * enumeration protection.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { forgotPassword, type EmailLocale } from '@/modules/auth';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  email: z.string().email().max(254),
  locale: z.enum(['en', 'th', 'sv']).optional(),
});

const NEUTRAL_MESSAGE =
  'If an account exists for that email, a reset link has been sent.';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  // B3 — outer try/catch (see sign-in/route.ts B3 note).
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
      {
        error: 'invalid-input',
        message: 'Invalid request body',
      },
      { status: 400 },
    );
  }

  const locale: EmailLocale | undefined = parsed.data.locale;
  const result = await forgotPassword({
    email: parsed.data.email,
    sourceIp: getClientIp(request),
    requestId,
    locale,
  });

  if (!result.ok) {
    const { error } = result;
    if (error.code === 'rate-limited') {
      return NextResponse.json(
        { error: 'rate-limited' },
        {
          status: 429,
          headers: { 'Retry-After': String(error.retryAfterSeconds) },
        },
      );
    }
    logger.error(
      { requestId, errCode: (error as { code: string }).code },
      'forgot-password: unhandled error variant',
    );
    return NextResponse.json({ error: 'server-error' }, { status: 500 });
  }

  return NextResponse.json({ message: NEUTRAL_MESSAGE }, { status: 200 });
  } catch (error) {
    logger.error({ err: error, requestId }, 'forgot-password.infra-error');
    return NextResponse.json(
      { error: 'server-error', requestId },
      { status: 500 },
    );
  }
}
