/**
 * F119 T107 — POST /api/admin/broadcasts/templates/[id]/images (FR-046a)
 *
 * `requireApiPermission(request, 'broadcasts.write')`, the F7.1a US2 image
 * kill-switch, then the shared handler: 30 / 60 s staff write bucket, the
 * template must exist in the tenant (a miss → 404 + the template probe),
 * the identical image rules, and ONE `broadcast_images` row with
 * `owner_kind='template'` (`related_member_id: null`).
 *
 * ROUND-3 #6 — what happens when a draft is STARTED from a template. This
 * docblock used to say the draft "gets its own `broadcast_images` row sharing
 * the content hash". It does not. `snapshotTemplateToDraft` copies the body
 * and records nothing, and T140 re-seeds the editor client-side; no upload
 * happens, so no row is written under `owner_kind='broadcast'`.
 *
 * The bytes survive anyway, by two other mechanisms: the TEMPLATE's own row
 * stays live (a template is soft-deleted, so deleting one does not orphan its
 * images), and the sweep's `isBlobReferencedByContent` backstop refuses to
 * delete a blob any live `body_html` / `body_source` still embeds — which is
 * exactly the draft's case.
 *
 * Follow-up, not closed here: record a draft-side row at first save when the
 * saved body embeds a blob URL whose only live row belongs to a template.
 * Until then the draft's claim on those bytes is a content scan rather than a
 * row, which is weaker (it is a sequential `position()` scan, and it cannot
 * be stamped by an erasure).
 *
 * No per-block authorship, no "from template" marking anywhere.
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
