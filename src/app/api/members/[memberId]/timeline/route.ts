/**
 * GET /api/members/[memberId]/timeline — staff load-more (F9 US3).
 *
 * Returns the keyset-paginated unified multi-source timeline (`member_timeline_v`:
 * audit · invoice · payment · event · broadcast · renewal) for a single member,
 * newest-first. RBAC: admin + manager (full), member-role redaction applied by
 * the use-case. Query params: cursor (opaque keyset), limit (1..100, default 50),
 * and the FR-015 filters source/actorKind/from/to (`from`/`to` = YYYY-MM-DD
 * tenant-tz days → UTC bounds; malformed → 400).
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind, rootCause } from '@/lib/log-id';
import {
  timelineList,
  TIMELINE_SOURCES,
  TIMELINE_ACTOR_KINDS,
} from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { isYmd } from '@/lib/tenant-day-range';
import { buildTimelineFilterInput } from '@/lib/timeline-filter-input';
import { toTimelineApiItem } from '@/lib/timeline-presenter';
import { env } from '@/lib/env';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // F9 US3 filters (FR-015). `from`/`to` are YYYY-MM-DD tenant-tz calendar
  // days, converted to UTC bounds below.
  source: z.enum(TIMELINE_SOURCES).optional(),
  actorKind: z.enum(TIMELINE_ACTOR_KINDS).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
  // F9 kill-switch (F9 #11): the staff timeline is an F9 US3 surface (it emits
  // member_timeline_viewed) and must go dark with the rest of F9 when the flag
  // is off — flag-first to match the other F9 routes.
  if (!env.features.f9Dashboard) {
    return NextResponse.json(
      { error: { code: 'feature_disabled', message: 'Timeline is not available.' } },
      { status: 503 },
    );
  }
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'read',
  });
  if ('response' in ctx) return ctx.response;

  const resolved = await params;
  const parsed = paramsSchema.safeParse(resolved);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: 'not_found', message: 'Member not found.' } },
      { status: 404 },
    );
  }

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
      {
        error: {
          code: 'validation_error',
          message: 'Invalid query parameters.',
          details: queryParsed.error.issues.map((i) => ({
            field: i.path.join('.'),
            issue: i.message,
          })),
        },
      },
      { status: 400 },
    );
  }

  // Convert YYYY-MM-DD tenant-tz calendar days into UTC bounds (FR-015).
  // A malformed date → 400 before the use-case (mirrors the audit viewer).
  const { from: fromYmd, to: toYmd } = queryParsed.data;
  if ((fromYmd && !isYmd(fromYmd)) || (toYmd && !isYmd(toYmd))) {
    return NextResponse.json(
      { error: { code: 'validation_error', message: 'Invalid date filter.' } },
      { status: 400 },
    );
  }
  const tz = env.tenant.timezone;

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await timelineList(
    {
      memberId: parsed.data.memberId,
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
    {
      actorUserId: ctx.current.user.id,
      actorRole: ctx.current.user.role as 'admin' | 'manager' | 'member',
      requestId: ctx.requestId,
    },
    tenant,
    {
      memberRepo: deps.memberRepo,
      timeline: deps.timeline,
    },
  );

  if (!result.ok) {
    switch (result.error.type) {
      case 'not_found':
        return NextResponse.json(
          { error: { code: 'not_found', message: result.error.message } },
          { status: 404 },
        );
      case 'invalid_input':
        return NextResponse.json(
          { error: { code: 'validation_error', message: result.error.message } },
          { status: 400 },
        );
      default:
        // Log errKind of the underlying cause only — result.error.cause can be
        // a raw Neon error carrying SQL params/table names (forbidden-fields
        // hygiene, R003).
        logger.error(
          { requestId: ctx.requestId, errKind: errKind(rootCause(result.error)) },
          'timeline.server_error',
        );
        return NextResponse.json(
          { error: { code: 'internal', message: 'Internal server error.' } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json({
    items: result.value.events.map(toTimelineApiItem),
    next_cursor: result.value.nextCursor,
    total: result.value.total,
  });
}
