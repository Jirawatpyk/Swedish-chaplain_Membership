/**
 * F114 — `GET /api/portal/change-requests/[id]` — one request in the
 * caller's FR-029 scope (US4 AS4; contracts/portal-change-requests-api.md
 * § history; FR-029, FR-039).
 *
 * Platform flag OFF → 404 before any session work. Member context (member
 * role only). 404 unless the row belongs to the caller's member AND is the
 * caller's own or company-level (`company` / `mixed`) — never a 403, which
 * would confirm a colleague's request exists. A `mixed` row from a colleague
 * is answered with its company fields only. The portal view never carries
 * the reviewer's identity or the staff note. `M114.portal.history_item.<arm>`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal } from '@/lib/change-request-portal-view';
import { getPortalChangeRequest, type ChangeRequestId } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.portal.history_item';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const deps = buildChangeRequestDeps(ctx.tenant);
  const me = asMembersUserId(ctx.current.user.id);
  const result = await getPortalChangeRequest(deps, { changeRequestId: id as ChangeRequestId, userId: me, memberId: ctx.memberId });

  if (!result.ok) {
    if (result.error.type === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
    logger.error(
      { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, changeRequestId: id, err: result.error.type === 'server_error' ? result.error.message : result.error.type },
      'change-requests.history-item: use case failed',
    );
    return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }

  const row = result.value;
  return NextResponse.json({
    request: serialiseChangeRequestForPortal(row.request, {
      contactId: row.request.submittedByContactId,
      displayName: row.submitter.displayName,
      isMe: row.request.submittedByUserId === me,
    }),
  });
}
