/**
 * F9 US6 (FR-031) — POST `/api/admin/members/[id]/data-export`.
 *
 * Admin produces a GDPR data export on a member's BEHALF for a data-subject
 * request. Admin-only (`requireAdminContext` with `members/write` blocks the
 * read-only manager — mirroring `requestDataExport`'s manager-forbidden rule);
 * the `data_export_requested` audit is attributed to the admin with
 * `on_behalf=true`. The artefact is built later by the async worker.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { tryMemberId } from '@/modules/members';
import { requestDataExport, makeRequestDataExportDeps } from '@/modules/insights';

export const runtime = 'nodejs';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'feature_disabled' } }, { status: 503 });
  }
  const ctx = await requireAdminContext(request, { resource: 'members', action: 'write' });
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const memberIdResult = tryMemberId(id);
  if (!memberIdResult.ok) {
    return NextResponse.json({ error: { code: 'member_not_found' } }, { status: 404 });
  }

  const tenant = resolveTenantFromRequest(request);
  const requesterLocale = await getLocale();

  try {
    const result = await requestDataExport(
      { subjectMemberId: memberIdResult.value },
      {
        actorUserId: ctx.current.user.id as string,
        actorRole: ctx.current.user.role,
        actorMemberId: null,
        requesterLocale,
        requestId: ctx.requestId,
      },
      tenant,
      makeRequestDataExportDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error } },
        { status: result.error === 'forbidden' ? 403 : 400 },
      );
    }
    return NextResponse.json(
      { ok: true, jobId: result.value.jobId, created: result.value.created },
      { status: 202 },
    );
  } catch (e) {
    logger.error(
      { tenantId: tenant.slug, memberId: id, errKind: errKind(e) },
      'admin.members.data_export.request.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }
}
