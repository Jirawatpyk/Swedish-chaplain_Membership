/**
 * F114 — `POST /api/portal/change-requests/[id]/acknowledge` — dismiss a
 * shown decision (US3; contracts/portal-change-requests-api.md
 * § acknowledge; FR-010, FR-029, FR-039).
 *
 * Platform flag OFF → 404 before any session work. Member context (member
 * role only; the proxy already applied CSRF + read-only 503). The tenant
 * gate is NOT consulted: a decision shown to a person may be dismissed even
 * after the tenant switched approval off. Envelope `{ error }` on failure;
 * the portal view never carries the reviewer's identity or the staff note.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal } from '@/lib/change-request-portal-view';
import { acknowledgeChangeRequest, type ChangeRequestId } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.portal.acknowledge';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  // FR-036 — READ_ONLY_MODE (T116): 503 after auth, before any write.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  const { id } = await context.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  const deps = buildChangeRequestDeps(ctx.tenant);
  const result = await acknowledgeChangeRequest(deps, {
    changeRequestId: id as ChangeRequestId,
    actorUserId: asMembersUserId(ctx.current.user.id),
    actorRole: ctx.current.user.role,
    requestId: ctx.requestId,
  });

  if (result.ok) {
    return NextResponse.json({
      request: serialiseChangeRequestForPortal(result.value.request, {
        contactId: ctx.ownContactId,
        displayName: `${ctx.ownContact.firstName} ${ctx.ownContact.lastName}`.trim(),
        isMe: true,
      }),
    });
  }

  switch (result.error.type) {
    case 'not_found':
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    case 'not_decided':
      return NextResponse.json({ error: 'not_decided', message: 'Only a decided request can be dismissed.' }, { status: 409 });
    case 'server_error':
    default:
      logger.error(
        { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, changeRequestId: id, err: result.error.type },
        'change-requests.acknowledge: use case failed',
      );
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
