/**
 * F114 — `GET /api/admin/members/[id]/change-requests` — one member's
 * history (US4 AS1; contracts/admin-change-requests-api.md § per-member
 * history; FR-026, FR-039).
 *
 * Platform flag OFF → 404 before any session work. Gate:
 * `requireApiPermission('members.read')`. The member must exist in the
 * caller's tenant (`memberRepo.findById` — another tenant's member is
 * invisible under RLS, so the answer is a 404 problem, never a 403 that
 * confirms existence; a malformed id is a 404 too). Every state, newest
 * first, the queue's list-row shape (no field values, no staff note); keyset
 * `cursor` / `limit ≤ 100`. `M114.admin.member_history.<arm>` on the 500s.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { problemResponse } from '@/lib/http/problem-response';
import { logger } from '@/lib/logger';
import { requireApiPermission } from '@/lib/rbac';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { serialiseQueueItem } from '@/lib/change-request-staff-view';
import { QUEUE_PAGE_DEFAULT, QUEUE_PAGE_MAX, asMemberId, listMemberChangeRequests } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.admin.member_history';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const querySchema = z.object({
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(QUEUE_PAGE_MAX).default(QUEUE_PAGE_DEFAULT),
});

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.read');
  if ('response' in ctx) return ctx.response;

  // the segment is `[id]` — every `/api/admin/members/[id]/*` sibling names it so
  const { id: memberId } = await context.params;
  const notFound = () => problemResponse(404, 'not_found', 'Member not found', undefined, { extras: { requestId: ctx.requestId } });
  if (!UUID_RE.test(memberId)) return notFound();

  const parsed = querySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams.entries()));
  if (!parsed.success) {
    return problemResponse(400, 'invalid_query', 'Invalid query', undefined, { extras: { requestId: ctx.requestId } });
  }

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));
  const member = await deps.memberRepo.findById(deps.tenant, asMemberId(memberId));
  if (!member.ok) {
    if (member.error.code === 'repo.not_found') return notFound();
    logger.error(
      { errorId: `${ERROR_ID}.member_read_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, memberId, err: member.error.code },
      'change-requests.member-history: member read failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the member', undefined, { extras: { requestId: ctx.requestId } });
  }

  const result = await listMemberChangeRequests(deps, { memberId: asMemberId(memberId), cursor: parsed.data.cursor ?? null, limit: parsed.data.limit });
  if (!result.ok) {
    if (result.error.type === 'invalid_cursor') {
      return problemResponse(400, 'invalid_query', 'Invalid cursor', undefined, { extras: { requestId: ctx.requestId } });
    }
    logger.error(
      { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, memberId, err: result.error.message },
      'change-requests.member-history: use case failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the history', undefined, { extras: { requestId: ctx.requestId } });
  }

  return NextResponse.json({ items: result.value.items.map(serialiseQueueItem), nextCursor: result.value.nextCursor });
}
