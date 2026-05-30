/**
 * F9 US6 (T093) — GET `/api/portal/account/data-export/[jobId]/download`.
 *
 * Member prepare-and-redirect: mints a fresh single-use download token for the
 * caller's OWN ready GDPR archive, then 303-redirects to the private proxy with
 * the token. `prepareExportDownload`'s authorise() restricts a subject artefact
 * to the subject member (or a same-tenant admin), so a member can never mint a
 * token for another member's archive — the member id is resolved from the
 * session, and a cross-tenant/foreign job id resolves to not_found via RLS.
 *
 * CSRF: same low-impact GET-mints-token posture as the admin download route —
 * the jobId is an unguessable UUID, the 303 Location is unreadable cross-origin,
 * and the attachment is opaque; worst case is a forced one-shot download churn.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  prepareExportDownload,
  makePrepareExportDownloadDeps,
  type PrepareExportDownloadError,
} from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';

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
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }
  if (current.user.role !== 'member') {
    return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
  }

  const { jobId } = await params;
  const tenant = resolveTenantFromRequest(request);
  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(
    tenant,
    current.user.id,
  );
  if (!memberResult.ok) {
    // not_found → 404; a DB/RLS fault must surface as 500 (logged), not be
    // masked as "no profile" on a download the subject is entitled to.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        {
          jobId,
          tenantId: tenant.slug,
          errCode: memberResult.error.code,
          errKind: errKind((memberResult.error as { cause?: unknown }).cause),
        },
        'portal.data_export.download.member_lookup_failed',
      );
      return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
    }
    return NextResponse.json({ error: { code: 'no_member_profile' } }, { status: 404 });
  }

  try {
    const result = await prepareExportDownload(
      { jobId },
      {
        actorUserId: current.user.id as string,
        actorRole: 'member',
        actorMemberId: memberResult.value.memberId,
        requestId: randomUUID(),
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
      'portal.data_export.download.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
  }
}
