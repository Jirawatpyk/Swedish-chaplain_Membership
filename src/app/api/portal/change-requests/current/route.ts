/**
 * F114 — `DELETE /api/portal/change-requests/current` — withdraw the caller's
 * pending request (US5 AS1; contracts/portal-change-requests-api.md
 * § withdraw; FR-009, FR-036, FR-038, FR-039).
 *
 * Platform flag OFF → 404 before any session work (dark ship). Member context
 * (member role only; the proxy already applied the CSRF Origin allow-list) →
 * in-route READ_ONLY_MODE 503 (T116) → the use case. There is no id in the
 * URL: the request withdrawn is the one the SESSION's user submitted, so a
 * colleague's request can never be named. 200 with the portal view
 * (`withdrawn/member`), 404 `no_pending_request` when none (a second call is
 * the same 404 — idempotent), 500 named `M114.portal.withdraw.<arm>`.
 * The tenant gate is NOT consulted: a request that exists may be withdrawn
 * even after the tenant switched approval off (it stays decidable, FR-032 —
 * so it must stay withdrawable).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { readOnlyModeResponse } from '@/app/api/plans/_read-only-guard';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseChangeRequestForPortal } from '@/lib/change-request-portal-view';
import { withdrawChangeRequest } from '@/modules/members';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ERROR_ID = 'M114.portal.withdraw';

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  if (!env.features.memberChangeApproval) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx) return ctx.response;

  // FR-036 — READ_ONLY_MODE (T116): 503 after auth, before any write.
  const roResp = readOnlyModeResponse();
  if (roResp) return roResp;

  const deps = buildChangeRequestDeps(ctx.tenant);
  const result = await withdrawChangeRequest(deps, {
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
    case 'no_pending_request':
      return NextResponse.json({ error: 'no_pending_request' }, { status: 404 });
    case 'server_error':
    default:
      logger.error(
        { errorId: `${ERROR_ID}.use_case_failed`, requestId: ctx.requestId, tenantId: ctx.tenant.slug, err: result.error.type },
        'change-requests.withdraw: use case failed',
      );
      return NextResponse.json({ error: 'server_error' }, { status: 500 });
  }
}
