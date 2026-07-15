/**
 * F9 US3 (T057) — GET /api/portal/timeline.
 *
 * Member self-service load-more endpoint for the member's OWN unified
 * timeline. Resolves the member linked to the session user, then runs the
 * same `timelineList` use case with `actorRole: 'member'` so internal
 * annotations are redacted (FR-017) and only this member's rows are visible.
 *
 * A member can never pass another member's id — the member is derived from
 * the session, not the request (FR-017 own-history-only).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import { env } from '@/lib/env';
import { isYmd } from '@/lib/tenant-day-range';
import { buildTimelineFilterInput } from '@/lib/timeline-filter-input';
import { toTimelineApiItem } from '@/lib/timeline-presenter';
import { checkPortalAccess } from '@/lib/lapsed-portal-scope';
import { buildPortalAccessDeps, toPortalAccessAction } from '@/lib/portal-access-deps';
import {
  timelineList,
  TIMELINE_SOURCES,
  TIMELINE_ACTOR_KINDS,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  source: z.enum(TIMELINE_SOURCES).optional(),
  actorKind: z.enum(TIMELINE_ACTOR_KINDS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const EMPTY = { items: [], next_cursor: null, total: 0 } as const;

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { user } = await requireSession('member');
  const tenant = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  const url = new URL(request.url);
  const queryParsed = querySchema.safeParse({
    cursor: url.searchParams.get('cursor') ?? undefined,
    limit: url.searchParams.get('limit') ?? 50,
    source: url.searchParams.get('source') ?? undefined,
    actorKind: url.searchParams.get('actorKind') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
  });
  if (!queryParsed.success) {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'Invalid query parameters.' } },
      { status: 400 },
    );
  }

  const { from: fromYmd, to: toYmd } = queryParsed.data;
  if ((fromYmd && !isYmd(fromYmd)) || (toYmd && !isYmd(toYmd))) {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'Invalid date filter.' } },
      { status: 400 },
    );
  }
  const tz = env.tenant.timezone;

  const deps = buildMembersDeps(tenant);
  const memberResult = await deps.memberRepo.findByLinkedUserId(tenant, user.id);
  if (!memberResult.ok) {
    // Only an UNLINKED account is a benign empty stream. Any other repo error
    // (DB outage, RLS misconfig) MUST surface as 500 + a log — never be masked
    // as "no activity" (review-run C1).
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        {
          requestId,
          errCode: memberResult.error.code,
          // Unwrap `.cause`: the Result error is a plain object, not an Error,
          // so errKind(error) would log 'unknown' (cf. the use-case path below
          // which already reads `.cause`).
          errKind: errKind(rootCause(memberResult.error)),
        },
        'portal.timeline.member_lookup_failed',
      );
      return NextResponse.json(
        { error: { code: 'internal', message: 'Internal server error.' } },
        { status: 500 },
      );
    }
    return NextResponse.json(EMPTY);
  }
  const member = memberResult.value;

  // 059-membership-suspension Task 7b — this route resolves its member via
  // a bespoke `requireSession` + `findByLinkedUserId` lookup instead of
  // `requireMemberContext` (`src/lib/member-context.ts`), so it does NOT
  // automatically inherit that helper's `checkPortalAccess` enforcement.
  // Wire the same gate directly, same deps builder + ctx shape + fail-open
  // behaviour as `requireMemberContext` (checkPortalAccess fails open
  // internally on a cyclesRepo read error, so no extra try/catch needed here).
  // `new URL(request.url).pathname` (NOT `request.nextUrl.pathname`) per the
  // same Task 3 controller note `requireMemberContext` follows — the
  // normalized literal request path.
  const actionValue = toPortalAccessAction(request.method);
  const accessDecision = await checkPortalAccess(buildPortalAccessDeps(tenant), {
    tenantId: tenant.slug,
    memberId: member.memberId,
    pathname: new URL(request.url).pathname,
    actorUserId: user.id,
    correlationId: requestId,
    requestId,
    ...(actionValue ? { action: actionValue } : {}),
  });
  if (!accessDecision.allowed) {
    return NextResponse.json(
      {
        error: {
          code: 'membership_access_restricted',
          message: 'Membership access is restricted for this route.',
        },
      },
      { status: 403 },
    );
  }

  const result = await timelineList(
    {
      memberId: member.memberId,
      cursor: queryParsed.data.cursor,
      limit: queryParsed.data.limit,
      ...buildTimelineFilterInput(
        {
          source: queryParsed.data.source,
          actorKind: queryParsed.data.actorKind,
          fromYmd,
          toYmd,
        },
        tz,
      ),
    },
    { actorUserId: user.id, actorRole: 'member', requestId },
    tenant,
    { memberRepo: deps.memberRepo, timeline: deps.timeline },
  );

  if (!result.ok) {
    if (result.error.type === 'invalid_input') {
      return NextResponse.json(
        { error: { code: 'validation_error', message: result.error.message } },
        { status: 400 },
      );
    }
    if (result.error.type === 'not_found') {
      // The member was found at findByLinkedUserId but the timeline use-case
      // reports not_found — a mid-request inconsistency, not a benign empty.
      logger.warn({ requestId }, 'portal.timeline.member_vanished_mid_request');
      return NextResponse.json(EMPTY);
    }
    logger.error(
      { requestId, errKind: errKind(rootCause(result.error)) },
      'portal.timeline.server_error',
    );
    return NextResponse.json(
      { error: { code: 'internal', message: 'Internal server error.' } },
      { status: 500 },
    );
  }

  return NextResponse.json({
    items: result.value.events.map(toTimelineApiItem),
    next_cursor: result.value.nextCursor,
    total: result.value.total,
  });
}
