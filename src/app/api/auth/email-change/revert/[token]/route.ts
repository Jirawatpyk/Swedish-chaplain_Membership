/**
 * Public revert endpoint — FR-012b (endpoint #16).
 *
 * The OLD-address revert notification links here. The endpoint:
 *   1. Accepts the plaintext token from the URL path
 *   2. Rate-limits per-IP (5 attempts per 10 minutes) — prevents token
 *      enumeration bursts
 *   3. Hashes the plaintext and looks up the active revert token via
 *      the members public barrel (no tenant context yet)
 *   4. Derives the TenantContext from the token row and delegates to
 *      the `revertContactEmail` use case which runs the atomic rollback
 *
 * Responses:
 *   - 200 `{ ok: true }`
 *   - 400 `{ error: 'invalid_token' }` — missing / malformed / consumed /
 *         expired / wrong-type
 *   - 409 `{ error: 'conflict' }`
 *   - 429 `{ error: 'rate_limited' }`
 *   - 500 `{ error: 'server_error' }`
 */

import { createHash } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { asTenantContext } from '@/modules/tenants';
import { revertContactEmail } from '@/modules/members';
import {
  buildMembersDeps,
  buildPublicEmailChangeLookup,
} from '@/modules/members/members-deps';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';

function hashToken(plaintext: string): string {
  return createHash('sha256').update(plaintext).digest('hex');
}

function clientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

async function handle(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const { token } = await params;

  // 1. Rate limit (spec § Security 4.2 — 5-in-10min per IP)
  const ip = clientIp(request);
  const rl = await rateLimiter.check(
    `email-change-revert:${ip}`,
    5,
    10 * 60,
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: {
          'retry-after': String(Math.ceil((rl.reset - Date.now()) / 1000)),
        },
      },
    );
  }

  if (!token || token.length < 32 || token.length > 256) {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  const tokenId = hashToken(token);

  // 2. Stand-alone lookup (no TenantContext yet — derived from the row)
  const publicLookup = buildPublicEmailChangeLookup();
  const lookup = await publicLookup.findActiveToken(tokenId);
  if (!lookup.ok) {
    logger.warn(
      { requestId, reason: 'token_lookup_miss' },
      'email_change.revert.reject',
    );
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }
  if (lookup.value.type !== 'revert') {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  // 3. Delegate to the atomic use case under the token's tenant
  const tenant = asTenantContext(lookup.value.tenantId);
  const deps = buildMembersDeps(tenant);
  const result = await revertContactEmail(
    {
      tenant,
      tokens: deps.tokens,
      contactRepo: deps.contactRepo,
      userEmails: deps.userEmails,
      sessions: deps.sessions,
      clock: deps.clock,
    },
    { tokenId, requestId },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
      case 'wrong_type':
        return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
      case 'conflict':
        return NextResponse.json(
          { error: 'conflict', reason: result.error.reason },
          { status: 409 },
        );
      default:
        logger.error(
          { requestId, err: result.error },
          'email_change.revert.server_error',
        );
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  logger.info(
    {
      requestId,
      userId: result.value.userId,
      sessionsRevoked: result.value.sessionsRevoked,
    },
    'email_change.revert.success',
  );
  return NextResponse.json({ ok: true }, { status: 200 });
}

export const POST = handle;
export const GET = handle;
