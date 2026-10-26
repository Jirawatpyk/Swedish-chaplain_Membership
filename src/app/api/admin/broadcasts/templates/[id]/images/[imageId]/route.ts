/**
 * Spec 131 — DELETE /api/admin/broadcasts/templates/[id]/images/[imageId]
 *
 * Staff release of an image uploaded to a template and then left out of it
 * (its description cancelled). The template upload route's gate
 * (`broadcasts.write`), kill-switch, staff write bucket and ownership check
 * (the template must exist in the tenant; a miss → 404 + the template probe).
 * The row is stamped for the next daily sweep, whose marked arm keeps the
 * bytes and the row when the template's saved body still embeds the URL.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handleImageRelease } from '@/lib/broadcasts-image-release-route';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled } from '@/modules/broadcasts';

export const runtime = 'nodejs';

const Uuid = z.string().uuid();

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
  if (!Uuid.safeParse(id).success || !Uuid.safeParse(imageId).success) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  return handleImageRelease(
    {
      tenant: resolveTenantFromRequest(request),
      owner: { kind: 'template', id },
      imageId,
      actor: { kind: 'staff', userId: ctx.current.user.id, role: ctx.current.user.role ?? null },
      surface: 'template',
    },
    correlationId,
  );
}
