/**
 * Spec 131 — DELETE /api/broadcasts/inline-image-upload/[imageId]?draftId=…
 *
 * The member's release of an image they uploaded to their own draft and then
 * left out of the message (its description cancelled). The same gate,
 * kill-switch and write bucket as the upload route beside it, and the same
 * ownership check (`authorizeImageOwner`: their own `draft`; another member's
 * → 404 + `broadcast_cross_member_probe`, an unknown or other-tenant id →
 * 404 + `broadcast_cross_tenant_probe`, a closed one → 409). The row is
 * stamped for the next daily sweep; nothing is deleted here.
 * Shared handler: `src/lib/broadcasts-image-release-route.ts`.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { handleImageRelease } from '@/lib/broadcasts-image-release-route';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled, parseBroadcastId } from '@/modules/broadcasts';

export const runtime = 'nodejs';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ imageId: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();

  if (!isF71aUs2Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs2DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  const { imageId } = await context.params;
  if (!parseBroadcastId(imageId).ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }
  const draftId = request.nextUrl.searchParams.get('draftId');
  if (draftId === null || !parseBroadcastId(draftId).ok) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: { draftId: ['draftId is required'] },
    });
  }

  return handleImageRelease(
    {
      tenant: ctx.tenant,
      owner: { kind: 'broadcast', id: draftId },
      imageId,
      actor: {
        kind: 'member',
        memberId: ctx.member.memberId,
        userId: ctx.current.user.id,
        role: ctx.current.user.role ?? null,
      },
      surface: 'member',
    },
    correlationId,
  );
}
