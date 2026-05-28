/**
 * F9 US5 (T082) — GET `/api/admin/directory/exports/[jobId]/download`.
 *
 * Staff prepare-and-redirect: mints a fresh single-use download token for a
 * `ready|delivered` directory artefact (RBAC inside `prepareExportDownload`),
 * then 303-redirects to the private proxy with the token. Keeps the recent-
 * exports "Download" a plain link while preserving the single-use token model.
 *
 * CSRF note: like the proxy route, this is a state-mutating GET (it mints + stores
 * a token) that `src/proxy.ts` (via `src/lib/csrf.ts`) does NOT Origin-check — the
 * CSRF allow-list covers unsafe methods only, and this route has no token gate of
 * its own (session cookie only). So a low-impact CSRF vector DOES exist: a page the
 * logged-in admin visits could force this GET and burn a single-use token. We accept
 * it because (a) `jobId` is an unguessable UUID, so an attacker cannot target a known
 * job; (b) the cross-origin response is an opaque attachment the attacker cannot read
 * (no data exfiltration); and (c) the worst outcome is a forced one-shot download /
 * `ready→delivered` churn on an already staff-visible artefact, recoverable by
 * re-preparing. If this surface ever returns readable data or gains a non-idempotent
 * effect, convert it to POST behind the CSRF Origin check.
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
