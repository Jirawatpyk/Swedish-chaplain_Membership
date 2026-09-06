/**
 * 108 PR-C T088 — `GET /api/admin/broadcasts/recipient-count` (admin proxy
 * compose, Q12 on-behalf-of-member).
 *
 * Query: `member_id=<uuid>` (the proxied member — its contacts are the ones
 * self-excluded) + the same `segment` / `tier` as the member route. Gate
 * `broadcasts.write` (data-model § 4). Order: gate → query (400) → 30/min
 * (tenant, admin user) limiter → member resolved INSIDE the tenant (RLS):
 * an unknown or foreign `member_id` → 404 with the non-disclosure body and a
 * `member_cross_tenant_probe` audit (Constitution I.4, the same rule as the
 * member routes — the repo cannot tell "does not exist" from "another
 * tenant's", and any miss from an authenticated staff user is high-signal)
 * → resolve → 503 `count_unavailable` on failure. Numbers only (FR-040a).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { broadcastsRateLimiter, makeResolveSegmentDeps } from '@/modules/broadcasts';
import { asMemberId, drizzleMemberRepo } from '@/modules/members';
import { buildContactMarketingDeps } from '@/lib/contact-marketing-deps';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import {
  RECIPIENT_COUNT_RATE_MAX,
  RECIPIENT_COUNT_RATE_WINDOW_SECONDS,
  countRecipients,
  parseRecipientCountQuery,
  recipientCountRateKey,
} from '@/lib/broadcasts-recipient-count';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const memberIdSchema = z.string().uuid();

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;

  const memberIdParsed = memberIdSchema.safeParse(request.nextUrl.searchParams.get('member_id'));
  const query = parseRecipientCountQuery(request.nextUrl.searchParams);
  if (!memberIdParsed.success || !query.ok) {
    return errorResponse(400, 'invalid_query', correlationId);
  }
  const memberId = memberIdParsed.data.toLowerCase();

  const tenant = resolveTenantFromRequest(request);
  const actorUserId = ctx.current.user.id;

  const limit = await broadcastsRateLimiter.checkLimit(
    recipientCountRateKey(tenant.slug, actorUserId),
    RECIPIENT_COUNT_RATE_MAX,
    RECIPIENT_COUNT_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  // Resolve the proxied member INSIDE the tenant. A miss (unknown id, or a
  // member of another tenant filtered by RLS) is a probe: audited with ids
  // only, answered with the same 404 either way. The audit's own failure is
  // logged and never masks the 404.
  const lookup = await drizzleMemberRepo.findById(tenant, asMemberId(memberId));
  if (!lookup.ok) {
    const probe = await buildContactMarketingDeps(tenant).audit.record(tenant, {
      type: 'member_cross_tenant_probe',
      actorUserId,
      requestId: ctx.requestId ?? correlationId,
      summary: `probe on member ${memberId} (recipient count)`,
      payload: { attempted_member_id: memberId, actor_tenant_id: tenant.slug, surface: 'recipient_count' },
    });
    if (!probe.ok) {
      logger.error(
        { tenantId: tenant.slug, correlationId, err: probe.error },
        'broadcasts.recipient_count.probe_audit_failed',
      );
    }
    return errorResponse(404, 'broadcast_member_not_found', correlationId);
  }

  const outcome = await countRecipients(makeResolveSegmentDeps(tenant.slug), {
    segment: query.segment,
    requestingMemberId: memberId,
    correlationId,
  });
  if (outcome.status === 'unavailable') {
    return errorResponse(503, 'count_unavailable', correlationId);
  }
  return NextResponse.json(outcome.body, { status: 200, headers: baseHeaders(correlationId) });
}
