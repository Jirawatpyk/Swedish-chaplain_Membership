/**
 * Spec 131 — DELETE /api/admin/broadcasts/[id]/images/[imageId]
 *
 * Staff release of an image uploaded to an E-Blast and then left out of it
 * (its description cancelled). The upload route's gate
 * (`broadcasts.write`), kill-switch, staff write bucket and ownership check
 * (`IMAGE_UPLOAD_STAFF_STAGES`: draft, submitted, in_design; later → 409
 * `stage_changed`; another tenant's → 404 + probe). The row is stamped for
 * the next daily sweep; nothing is deleted here.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { handleImageRelease } from '@/lib/broadcasts-image-release-route';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled, parseBroadcastId } from '@/modules/broadcasts';

export const runtime = 'nodejs';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string; imageId: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;

  if (!isF71aUs2Enabled()) {
    return NextResponse.json(
      { error: 'feature_disabled', reason: f71aUs2DisabledReason() },
      { status: 503, headers: baseHeaders(correlationId) },
    );
  }

  const { id, imageId } = await context.params;
  if (!parseBroadcastId(id).ok || !parseBroadcastId(imageId).ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  return handleImageRelease(
    {
      tenant: resolveTenantFromRequest(request),
      owner: { kind: 'broadcast', id },
      imageId,
      actor: { kind: 'staff', userId: ctx.current.user.id, role: ctx.current.user.role ?? null },
      surface: 'staff',
    },
    correlationId,
  );
}
