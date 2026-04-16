/**
 * T131 — GET /api/members/[memberId]/timeline (US6).
 *
 * Returns paginated audit-log events for a single member, newest-first.
 * RBAC: admin + manager (full), member (own + redacted).
 * Query params: cursor (opaque), limit (1..100, default 50).
 *
 * FR-020: per-member timeline, paginated in batches of 50.
 * FR-023: reads from the shared audit_log.
 * FR-024: response shape supports WCAG 2.1 AA timeline rendering.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { timelineList } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';

const paramsSchema = z.object({
  memberId: z.string().uuid(),
});

const querySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ memberId: string }> },
): Promise<NextResponse> {
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

  const tenant = resolveTenantFromRequest(request);
  const deps = buildMembersDeps(tenant);

  const result = await timelineList(
    {
      memberId: parsed.data.memberId,
      cursor: queryParsed.data.cursor,
      limit: queryParsed.data.limit,
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
        logger.error(
          { requestId: ctx.requestId, err: result.error },
          'timeline.server_error',
        );
        return NextResponse.json(
          { error: { code: 'internal', message: 'Internal server error.' } },
          { status: 500 },
        );
    }
  }

  return NextResponse.json({
    items: result.value.events.map((e) => ({
      id: e.id,
      timestamp: e.timestamp.toISOString(),
      event_type: e.eventType,
      actor_user_id: e.actorUserId,
      actor_display_name: e.actorDisplayName,
      payload: e.payload,
    })),
    next_cursor: result.value.nextCursor,
    total: result.value.total,
  });
}
