/**
 * F9 US5 (T082) — GET `/api/admin/directory/exports/[jobId]/download`.
 *
 * Staff prepare-and-redirect: mints a fresh single-use download token for a
 * `ready|delivered` directory artefact (RBAC inside `prepareExportDownload`),
 * then 303-redirects to the private proxy with the token. Keeps the recent-
 * exports "Download" a plain link while preserving the single-use token model.
 *
 * CSRF convention: like the proxy route, this is a state-mutating GET (it mints a
 * fresh token) that `middleware.ts` does NOT Origin-check (CSRF allow-list covers
 * unsafe methods only). The minted token is single-use + short-lived + bound to
 * the authenticated staff session's tenant — forging one cross-site is infeasible,
 * and the token grants nothing beyond a one-shot read of an already staff-visible
 * artefact, so the GET-mutates-state shortcut carries no additional CSRF risk.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { getCurrentSession } from '@/lib/auth-session';
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
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }
  if (current.user.role === 'member') {
    return NextResponse.json({ error: { code: 'forbidden' } }, { status: 403 });
  }

  const { jobId } = await params;
  const tenant = resolveTenantFromRequest(request);
  const result = await prepareExportDownload(
    { jobId },
    {
      actorUserId: current.user.id as string,
      actorRole: current.user.role,
      actorMemberId: null,
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
}
