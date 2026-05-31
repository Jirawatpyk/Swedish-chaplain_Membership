/**
 * F9 US6 (FR-031) — GET `/api/admin/members/[id]/data-export/[jobId]/download`.
 *
 * Admin prepare-and-redirect for an on-behalf GDPR archive: mints a fresh
 * single-use token (RBAC inside `prepareExportDownload` — admin may access any
 * same-tenant subject artefact), then 303-redirects to the private proxy.
 * Admin-only (`requireAdminContext` with `members/read` — viewing/downloading a
 * member's archive is a read; the request/produce path is `members/write`).
 *
 * CSRF: same low-impact GET-mints-token posture as the other download routes —
 * unguessable jobId, unreadable cross-origin 303 Location, opaque attachment.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  prepareExportDownload,
  makePrepareExportDownloadDeps,
  type PrepareExportDownloadError,
} from '@/modules/insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS: Record<PrepareExportDownloadError, number> = {
  forbidden: 403,
  not_found: 404,
  not_ready: 409,
  expired: 410,
};

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string; jobId: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const ctx = await requireAdminContext(request, { resource: 'members', action: 'read' });
  if ('response' in ctx) return ctx.response;

  const { jobId } = await context.params;
  const tenant = resolveTenantFromRequest(request);

  try {
    const result = await prepareExportDownload(
      { jobId },
      {
        actorUserId: ctx.current.user.id as string,
        actorRole: ctx.current.user.role,
        actorMemberId: null,
        requestId: ctx.requestId,
      },
      tenant,
      makePrepareExportDownloadDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json({ error: { code: result.error } }, { status: STATUS[result.error] });
    }
    const url = new URL(`/api/internal/exports/${jobId}/download`, request.nextUrl.origin);
    url.searchParams.set('token', result.value.token);
    return NextResponse.redirect(url, 303);
  } catch (e) {
    logger.error(
      { tenantId: tenant.slug, errKind: errKind(e) },
      'admin.members.data_export.download.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }
}
