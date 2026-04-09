/**
 * POST /api/auth/reset-password (T102, contracts/auth-api.md § 4).
 *
 * Maps the Result union from `resetPassword()` to HTTP status codes:
 *   200 — { ok: true, signInUrl }
 *   400 — invalid-input / weak-password
 *   404/410 — link-invalid (single public slug — no leak between the
 *           three underlying reasons: missing, expired, used)
 *   429 — rate-limited (with Retry-After)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { resetPassword } from '@/modules/auth/application/reset-password';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  token: z.string().min(32).max(128),
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

  const result = await resetPassword({
    token: parsed.data.token,
    newPassword: parsed.data.newPassword,
    sourceIp: clientIp(request),
    requestId,
  });

  if (result.ok) {
    return NextResponse.json(
      { ok: true, signInUrl: result.value.signInUrl },
      { status: 200 },
    );
  }

  const { error } = result;
  switch (error.code) {
    case 'link-invalid':
      // Single public slug; status 410 Gone is semantically closest.
      return NextResponse.json({ error: 'link-invalid' }, { status: 410 });
    case 'weak-password':
      return NextResponse.json(
        {
          error: 'weak-password',
          issues: error.errors.map((e) => e.code),
        },
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
      logger.error({ requestId }, 'reset-password: unhandled error variant');
      return NextResponse.json({ error: 'server-error' }, { status: 500 });
    }
  }
}
