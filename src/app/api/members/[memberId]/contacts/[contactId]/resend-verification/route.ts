/**
 * Admin resend-verification endpoint — FR-012c action.
 *
 * Admin-only POST that issues a fresh 24h verification token + outbox
 * row for a contact whose email change previously failed to deliver
 * (dispatcher flipped the original outbox row to `permanently_failed`).
 *
 * Response: 200 `{ outbox_row_id, invalidated_prior }` — the admin UI
 * surfaces a toast confirming the re-send and closes the failure
 * banner.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  resendVerificationEmail,
  type ContactId,
  type MemberId,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requireAdminContext } from '@/lib/admin-context';
import { logger } from '@/lib/logger';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
  contactId: z.string().uuid(),
});

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string; contactId: string }> },
): Promise<NextResponse> {
  const gate = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in gate) return gate.response;
  const { current, requestId } = gate;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    // Flat shape matches the use-case 404 branch and the sibling
    // resend-invite route. The client button discriminates on
    // `body.error === 'not_found'`; the nested shape would silently
    // fall through to the generic toast.
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  const { memberId, contactId } = parsed.data;
  const tenant = resolveTenantFromRequest(request);

  // DV-11 (security) — throttle re-sends per contact (inbox protection).
  // Key is per-(tenant, contact) NOT per-(admin, contact): including the
  // admin userId gives each admin an independent bucket, allowing N admins
  // to collectively mail-bomb a contact inbox N× the stated limit.
  // Per-DOCUMENT pattern matches the F4 invoice resend route.
  const rl = await rateLimiter.check(
    `resend-verify:${tenant.slug}:${contactId}`,
    3,
    3600, // 3 per hour
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: 'rate_limited' },
      {
        status: 429,
        headers: { 'Retry-After': String(retryAfterSecondsFromRl(rl)) },
      },
    );
  }

  const deps = buildMembersDeps(tenant);

  const result = await resendVerificationEmail(
    {
      tenant,
      contactRepo: deps.contactRepo,
      tokens: deps.tokens,
      emails: deps.emails,
      userEmails: deps.userEmails,
      audit: deps.audit,
      clock: deps.clock,
    },
    {
      contactId: contactId as ContactId,
      memberId: memberId as MemberId,
      actorUserId: current.user.id,
      requestId,
      // Admin tenant doesn't carry a session locale on the request — we
      // default to English; a richer UX can pass ?locale=th|sv when the
      // admin UI exposes locale selection (follow-up ticket).
      locale: 'en',
    },
  );

  if (!result.ok) {
    switch (result.error.code) {
      case 'not_found':
        return NextResponse.json({ error: 'not_found' }, { status: 404 });
      case 'not_eligible':
        return NextResponse.json(
          { error: 'not_eligible', reason: result.error.reason },
          { status: 409 },
        );
      default:
        logger.error(
          { requestId, err: result.error },
          'members.resend_verification.server_error',
        );
        return NextResponse.json({ error: 'server_error' }, { status: 500 });
    }
  }

  return NextResponse.json(
    {
      outbox_row_id: result.value.outboxRowId,
      invalidated_prior: result.value.invalidatedPrior,
    },
    { status: 200 },
  );
}
