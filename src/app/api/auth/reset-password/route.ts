/**
 * POST /api/auth/reset-password (T102, contracts/auth-api.md § 4).
 *
 * Maps the Result union from `resetPassword()` to HTTP status codes:
 *   200 — { ok: true, signInUrl }
 *   400 — invalid-input / weak-password
 *   410 — link-invalid (uniform Gone status across all reasons —
 *         missing/expired/used — per B1 enumeration safety)
 *   429 — rate-limited (with Retry-After)
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  resetPassword,
  parseResetTokenId,
  MalformedTokenError,
} from '@/modules/auth';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

const inputSchema = z.object({
  token: z.string().min(32).max(128),
  newPassword: z.string().min(1).max(256),
});

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
      { error: 'invalid-input', message: 'Invalid request body' },
      { status: 400 },
    );
  }

  // I3 (Round 2) — parse instead of cast: validates 64-hex at the
  // trust boundary so a malformed URL gets a uniform 410 link-invalid
  // instead of silently never matching in the repo sha256Hex lookup.
  let parsedToken;
  try {
    parsedToken = parseResetTokenId(parsed.data.token);
  } catch (parseErr) {
    if (parseErr instanceof MalformedTokenError) {
      logger.warn(
        { requestId, reason: 'malformed-token' },
        'reset-password.link-invalid',
      );
      return NextResponse.json({ error: 'link-invalid' }, { status: 410 });
    }
    throw parseErr;
  }

  const result = await resetPassword({
    token: parsedToken,
    newPassword: parsed.data.newPassword,
    sourceIp: getClientIp(request),
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
    case 'link-invalid': {
      // B1 (post-ship 2026-05-17) — collapsed 404/410 split to a uniform
      // 410 Gone. The previous split (404=not-found, 410=expired|used)
      // re-introduced enumeration leakage at the status-code layer:
      // an attacker submitting random 64-hex strings could probe which
      // prefixes match real issued tokens by counting 404 vs 410. No
      // legitimate client benefits from distinguishing (the UI shows
      // the same "request a new link" either way). Internal logs +
      // metrics still discriminate via `error.reason`.
      logger.warn(
        { requestId, reason: error.reason },
        'reset-password.link-invalid',
      );
      return NextResponse.json({ error: 'link-invalid' }, { status: 410 });
    }
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
  } catch (error) {
    logger.error({ err: error, requestId }, 'reset-password.infra-error');
    return NextResponse.json(
      { error: 'server-error', requestId },
      { status: 500 },
    );
  }
}
