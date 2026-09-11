/**
 * F114 — `GET /api/admin/change-requests/[id]` — the review payload (US2;
 * contracts/admin-change-requests-api.md § review; FR-019, FR-020, FR-039).
 *
 * Platform flag OFF → 404 before any session work (dark ship). Gate:
 * `requireApiPermission('members.read')`; `canDecide` in the body is derived
 * from the evaluator (`members.write`) so a manager sees the page read-only.
 * RFC 7807 problem bodies on every error arm; `M114.admin.review.<arm>`
 * errorIds on the 500s.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { problemResponse } from '@/lib/http/problem-response';
import { logger } from '@/lib/logger';
import { canPerform, requireApiPermission } from '@/lib/rbac';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { serialiseChangeRequestForStaff, serialiseReviewField } from '@/lib/change-request-staff-view';
import { getChangeRequestReview, type ChangeRequestId } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.admin.review';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return problemResponse(404, 'not_found', 'Not found');
  }

  const ctx = await requireApiPermission(request, 'members.read');
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return problemResponse(404, 'not_found', 'Change request not found', undefined, { extras: { requestId: ctx.requestId } });

  const deps = buildChangeRequestDeps(resolveTenantFromRequest(request));
  const result = await getChangeRequestReview(deps, {
    changeRequestId: id as ChangeRequestId,
    // rbac-subgate-ok: gates the `canDecide` FIELD of an already-authorised
    // (members.read) response — a manager reads the payload with canDecide
    // false; admission is the requireApiPermission call above.
    canWrite: canPerform(ctx.current.user.role, 'members.write'),
    actor: { userId: asMembersUserId(ctx.current.user.id), role: ctx.current.user.role, requestId: ctx.requestId },
  });

  if (!result.ok) {
    if (result.error.type === 'not_found') {
      return problemResponse(404, 'not_found', 'Change request not found', undefined, { extras: { requestId: ctx.requestId } });
    }
    logger.error(
      { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: deps.tenant.slug, changeRequestId: id, err: result.error.message },
      'change-requests.review: use case failed',
    );
    return problemResponse(500, 'server_error', 'Could not load the change request', undefined, { extras: { requestId: ctx.requestId } });
  }

  const review = result.value;
  return NextResponse.json({
    request: serialiseChangeRequestForStaff(review.row),
    fields: review.fields.map(serialiseReviewField),
    member: review.member,
    canDecide: review.canDecide,
  });
}
