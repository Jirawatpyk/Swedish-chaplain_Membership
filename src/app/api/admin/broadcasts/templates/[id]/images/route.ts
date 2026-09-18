/**
 * F119 T107 — POST /api/admin/broadcasts/templates/[id]/images (FR-046a)
 *
 * `requireApiPermission(request, 'broadcasts.write')`, the F7.1a US2 image
 * kill-switch, then the shared handler: 30 / 60 s staff write bucket, the
 * template must exist in the tenant (a miss → 404 + the template probe),
 * the identical image rules, and ONE `broadcast_images` row with
 * `owner_kind='template'` (`related_member_id: null`). Starting an E-Blast
 * from a template carries its images BY REFERENCE (today's snapshot
 * semantics): the draft gets its own `broadcast_images` row sharing the
 * content hash, which is exactly what the last-reference sweep needs so a
 * later template edit or delete never breaks a draft already started from
 * it. No per-block authorship, no "from template" marking anywhere.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { handleImageUpload } from '@/lib/broadcasts-image-upload-route';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { f71aUs2DisabledReason, isF71aUs2Enabled } from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const TemplateId = z.string().uuid();

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
  if (!TemplateId.safeParse(id).success) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }

  return handleImageUpload(
    request,
    {
      tenant: resolveTenantFromRequest(request),
      owner: { kind: 'template', id },
      actor: { kind: 'staff', userId: ctx.current.user.id, email: ctx.current.user.email, role: ctx.current.user.role ?? null },
      surface: 'template',
    },
    correlationId,
  );
}
