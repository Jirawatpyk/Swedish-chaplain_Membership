/**
 * Public email-verification endpoint — FR-012a companion.
 *
 * Consumes the 24h verification token issued by the change-contact-email
 * atomic txn. Success flips `users.email_verified` back to TRUE and
 * closes the matching 48h revert window, unblocking F1 sign-in.
 *
 * Security: same rate-limit + token-hash pattern as the revert endpoint.
 * No session required (the user can't sign in yet — that's the whole
 * point).
 *
 * Responses:
 *   - 200 `{ ok: true }`
 *   - 400 `{ error: 'invalid_token' }`
 *   - 400 `{ error: 'not_yet_active', retryAfterSeconds }`
 *   - 429 `{ error: 'rate_limited' }`
 *   - 500 `{ error: 'server_error' }`
 */

import { NextResponse, type NextRequest } from 'next/server';
import { asTenantContext } from '@/modules/tenants';
import { verifyContactEmail } from '@/modules/members';
import {
  buildMembersDeps,
  buildPublicEmailChangeLookup,
} from '@/modules/members/members-deps';
import { rateLimiter } from '@/lib/auth-deps';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getClientIp } from '@/lib/client-ip';
import { sha256Hex } from '@/lib/crypto';

async function handle(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> },
): Promise<NextResponse> {
  const requestId = requestIdFromHeaders(request.headers);
  const { token } = await params;

  const ip = getClientIp(request);
  const rl = await rateLimiter.check(
    `email-verification:${ip}`,
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

  const tokenId = sha256Hex(token);

  const publicLookup = buildPublicEmailChangeLookup();
  const lookup = await publicLookup.findActiveToken(tokenId);
  if (!lookup.ok) {
    logger.warn(
      { requestId, reason: 'token_lookup_miss' },
      'email_verification.reject',
    );
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }
  if (lookup.value.type !== 'verification') {
    return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
  }

  const tenant = asTenantContext(lookup.value.tenantId);
  const deps = buildMembersDeps(tenant);
  const result = await verifyContactEmail(
    {
      tenant,
      tokens: deps.tokens,
      userEmails: deps.userEmails,
      clock: deps.clock,
    },
    { tokenId, requestId },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
      case 'wrong_type':
        return NextResponse.json({ error: 'invalid_token' }, { status: 400 });
      case 'not_yet_active': {
        const retry = Math.max(
          0,
          Math.ceil(
            (result.error.activatedAt.getTime() - Date.now()) / 1000,
          ),
        );
        return NextResponse.json(
          { error: 'not_yet_active', retryAfterSeconds: retry },
          { status: 400 },
        );
      }
      default:
        logger.error(
          { requestId, err: result.error },
          'email_verification.server_error',
        );
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  logger.info(
    { requestId, userId: result.value.userId },
    'email_verification.success',
  );
  return NextResponse.json({ ok: true }, { status: 200 });
}

export const POST = handle;

// GET must NOT consume tokens — email-client prefetchers (Gmail Safe
// Browsing, Apple Mail Privacy Protection, Outlook Link Preview) send
// GET requests before the user clicks. The client-side page at
// /email-verification/[token]/page.tsx renders a confirmation UI that
// POSTs to this endpoint.
export async function GET(): Promise<NextResponse> {
  return NextResponse.json(
    { error: 'method_not_allowed', message: 'Use POST to consume the verification token.' },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
