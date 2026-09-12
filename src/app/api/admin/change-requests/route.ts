/**
 * F114 — `GET /api/admin/change-requests` — the tenant-wide queue (US4 AS2;
 * contracts/admin-change-requests-api.md § queue; FR-027, FR-033, FR-039).
 *
 * Platform flag OFF → 404 before any session work (dark ship). Gate:
 * `requireApiPermission('members.read')` — a manager reads the queue; deciding
 * is the review route's `members.write`. Query: `state` (default `pending`,
 * oldest waiting first; any other state newest first), `outcome`, `memberId`,
 * `submitter` (the staff-email deep link), `from` / `to` (ISO-8601), the
 * opaque keyset `cursor` and `limit ≤ 100`; anything else → 400 problem
 * `invalid_query` (a malformed cursor included — never page one silently).
 * The body carries the tenant's `pendingCount` + `oldestPendingAgeSeconds`
 * (FR-033) and a list row per request WITHOUT field values or the staff note.
 * RFC 7807 problem bodies on every error arm; `M114.admin.queue.<arm>`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { problemResponse } from '@/lib/http/problem-response';
import { logger } from '@/lib/logger';
import { requireApiPermission } from '@/lib/rbac';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { serialiseQueueItem } from '@/lib/change-request-staff-view';
import {
  CHANGE_REQUEST_OUTCOMES,
  CHANGE_REQUEST_STATES,
  QUEUE_PAGE_DEFAULT,
  QUEUE_PAGE_MAX,
  asMemberId,
  listChangeRequestQueue,
} from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.admin.queue';

const querySchema = z.object({
  state: z.enum(CHANGE_REQUEST_STATES).optional(),
  outcome: z.enum(CHANGE_REQUEST_OUTCOMES).optional(),
  memberId: z.string().uuid().optional(),
  submitter: z.string().uuid().optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(QUEUE_PAGE_MAX).default(QUEUE_PAGE_DEFAULT),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.read');
  if ('response' in ctx) return ctx.response;

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return problemResponse(400, 'invalid_query', 'Invalid query', undefined, { extras: { requestId: ctx.requestId, issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) } });
  }
  const q = parsed.data;

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));
  const result = await listChangeRequestQueue(deps, {
    filter: {
      ...(q.state ? { state: q.state } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.memberId ? { memberId: asMemberId(q.memberId) } : {}),
      ...(q.submitter ? { submitterUserId: asMembersUserId(q.submitter) } : {}),
      ...(q.from ? { from: new Date(q.from) } : {}),
      ...(q.to ? { to: new Date(q.to) } : {}),
    },
    cursor: q.cursor ?? null,
    limit: q.limit,
  });

  if (!result.ok) {
    if (result.error.type === 'invalid_cursor') {
      return problemResponse(400, 'invalid_query', 'Invalid cursor', undefined, { extras: { requestId: ctx.requestId } });
    }
    logger.error(
      { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, err: result.error.message },
      'change-requests.queue: use case failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the queue', undefined, { extras: { requestId: ctx.requestId } });
  }

  const page = result.value;
  return NextResponse.json({
    items: page.items.map(serialiseQueueItem),
    nextCursor: page.nextCursor,
    pendingCount: page.pendingCount,
    oldestPendingAgeSeconds: page.oldestPendingAgeSeconds,
  });
}
