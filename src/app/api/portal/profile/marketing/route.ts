/**
 * PATCH /api/portal/profile/marketing — 108 PR-D (US6 / FR-030b, FR-032,
 * FR-033; contracts/contact-marketing-api.md § 2).
 *
 * The contact's OWN marketing preference. The session decides which contact
 * is acted on (`ctx.ownContactId`) — the body is `{ optOut: boolean }` and
 * nothing else (strict), so no other contact can be addressed (FR-032). Same
 * rules as the staff toggle: `Idempotency-Key` required (replay returns the
 * stored outcome, never a second write or audit), 60/min per tenant + user
 * consumed before the write — the SAME bucket, so a person cannot double
 * their budget by switching surfaces. A suppressed address refuses "on" with
 * 409 (the portal hides the control in that state).
 *
 * The primary contact may switch marketing off like anyone else; money
 * emails are untouched by design (FR-033 — the money recipient read never
 * consults these columns).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireMemberContext } from '@/lib/member-context';
import {
  parseIdempotencyKey,
  classifyIdempotencyRequest,
  reserveIdempotencyRecord,
  rememberIdempotentResponse,
  hashRequestBody,
} from '@/lib/idempotency';
import { rateLimitedJson } from '@/lib/rate-limit-helpers';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/modules/auth';
import { deriveMarketingState, setContactMarketingOptOut } from '@/modules/members';
import {
  buildContactMarketingDeps,
  makeMarketingSuppressionLookup,
} from '@/lib/contact-marketing-deps';

const bodySchema = z.object({ optOut: z.boolean() }).strict();

/** FR-030b — shared with the staff toggle (same key shape, same bucket). */
const RATE_MAX = 60;
const RATE_WINDOW_SECONDS = 60;

function errorJson(status: number, code: string, message?: string, headers?: HeadersInit) {
  return NextResponse.json(
    { error: message === undefined ? { code } : { code, message } },
    { status, ...(headers !== undefined ? { headers } : {}) },
  );
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const keyCheck = parseIdempotencyKey(request.headers);
  if (!keyCheck.ok) {
    return errorJson(400, 'missing_idempotency_key', 'Idempotency-Key header required');
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return errorJson(400, 'invalid_body', 'Invalid JSON');
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorJson(400, 'invalid_body', 'Body must be exactly { optOut: boolean }');
  }

  const actorUserId = ctx.current.user.id;
  const rl = await rateLimiter.check(
    `contacts:marketing:${ctx.tenant.slug}:${actorUserId}`,
    RATE_MAX,
    RATE_WINDOW_SECONDS,
  );
  if (!rl.success) return rateLimitedJson(rl);

  const bodyHash = hashRequestBody(parsed.data, `PATCH /portal/profile/marketing/${ctx.ownContactId}`);
  const classification = await classifyIdempotencyRequest(ctx.tenant, keyCheck.key, bodyHash);
  if (classification.kind === 'replay') {
    return NextResponse.json(classification.previousResponse.body, {
      status: classification.previousResponse.status,
    });
  }
  if (classification.kind === 'conflict') {
    return errorJson(409, 'idempotency_conflict', 'Idempotency-Key was reused with a different body');
  }
  const reserved = await reserveIdempotencyRecord(ctx.tenant, keyCheck.key, bodyHash);
  if (!reserved.ok) {
    return errorJson(
      503,
      'idempotency_reservation_failed',
      'Idempotency reservation temporarily unavailable. Retry shortly.',
      { 'Retry-After': '5' },
    );
  }

  const result = await setContactMarketingOptOut(
    {
      contactId: ctx.ownContactId,
      state: parsed.data.optOut ? 'off' : 'on',
      actor: { userId: actorUserId, role: ctx.current.user.role, source: 'self' },
      requestId: ctx.requestId,
    },
    buildContactMarketingDeps(ctx.tenant),
  );

  if (result.ok) {
    // The DISPLAYED state after the change (suppression > opt-out > on).
    // "on" succeeded ⇒ not suppressed; "off" may still sit under an
    // unsubscribe, so ask — and degrade honestly if the list is unreadable.
    let suppressed: boolean | 'unknown' = false;
    if (parsed.data.optOut) {
      try {
        suppressed = await makeMarketingSuppressionLookup(ctx.tenant).isSuppressed(
          result.value.contact.email,
        );
      } catch {
        suppressed = 'unknown';
      }
    }
    const body = {
      outcome: result.value.outcome,
      marketing: { state: deriveMarketingState(result.value.contact.marketing, suppressed) },
    };
    await rememberIdempotentResponse(ctx.tenant, keyCheck.key, bodyHash, { status: 200, body });
    return NextResponse.json(body, { status: 200 });
  }

  switch (result.error.type) {
    case 'not_found':
    case 'removed':
      return errorJson(404, 'not_found');
    case 'self_opted_out':
      // Unreachable for `source: 'self'` (the contact may always lift their
      // own opt-out) — mapped for exhaustiveness.
      return errorJson(409, 'self_opted_out');
    case 'suppressed':
      return errorJson(
        409,
        'suppressed',
        'You unsubscribed from marketing emails; that choice stays in force.',
      );
    case 'suppression_unavailable':
      return errorJson(
        503,
        'suppression_unavailable',
        'Unsubscribe status is temporarily unavailable. Retry shortly.',
        { 'Retry-After': '5' },
      );
    case 'server_error':
    default:
      logger.error(
        { requestId: ctx.requestId, err: result.error.message },
        'portal.profile.marketing.patch.error',
      );
      return errorJson(500, 'internal');
  }
}
