/**
 * F119 T106 (PR-1) · T106a (PR-2 widens the stage set) —
 * POST /api/admin/broadcasts/[id]/images
 *
 * `requireApiPermission(request, 'broadcasts.write')` (marketing / admin /
 * super_admin; a manager is read-only), the F7.1a US2 image kill-switch,
 * then the shared handler: 30 / 60 s staff write bucket, the ownership check
 * (stage in `('draft','submitted','in_design')` — the compose-on-behalf
 * draft, a member's submission the proxy author may still illustrate, and
 * the version marketing is formatting (T106a, `authorizeImageOwner`'s
 * `IMAGE_UPLOAD_STAFF_STAGES`); a sent version is read-only → 409
 * `stage_changed`), the identical 5 MB / MIME /
 * ClamAV / source-allowlist rules as a member's image, and ONE
 * `broadcast_images` row (`owner_kind='broadcast'`) audited with
 * `related_member_id` (a staff upload must not move the member's recency).
 * 404 + probe on another tenant's id, 409 outside the stage set, 201 on success.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { handleImageUpload } from '@/lib/broadcasts-image-upload-route';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled, parseBroadcastId } from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
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

  const { id } = await context.params;
  if (!parseBroadcastId(id).ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  return handleImageUpload(
    request,
    {
      tenant: resolveTenantFromRequest(request),
      owner: { kind: 'broadcast', id },
      actor: { kind: 'staff', userId: ctx.current.user.id, email: ctx.current.user.email, role: ctx.current.user.role ?? null },
      surface: 'staff',
    },
    correlationId,
  );
}
