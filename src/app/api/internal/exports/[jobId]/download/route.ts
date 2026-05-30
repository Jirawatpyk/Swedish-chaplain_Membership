/**
 * F9 (T073) — private export-artefact download proxy.
 * GET `/api/internal/exports/[jobId]/download?token=<signed>`.
 *
 * Defence-in-depth (research R6):
 *   1. valid session (else 401),
 *   2. RBAC: subject member (their own GDPR archive) OR same-tenant staff —
 *      admin AND manager for directory artefacts — enforced inside `downloadExport`,
 *   3. short-lived, single-use, job-bound token verified against the stored
 *      HMAC + expiry.
 * On success the PRIVATE Blob is streamed through this route (URL never exposed),
 * the job transitions `ready → delivered`, the token is invalidated (single-use),
 * and `data_export_downloaded` is audited. `Cache-Control: private, no-store`.
 *
 * CSRF convention: `src/proxy.ts` (via `src/lib/csrf.ts` `checkCsrf`) Origin-checks
 * only state-changing methods (POST/PUT/PATCH/DELETE) on `/api/**`; GETs pass as
 * `method-safe`. This GET deliberately mutates state (ready→delivered + token
 * consume), so the single-use HMAC token IS the CSRF defence here — it cannot be
 * forged cross-site, and replay fails because the first use invalidates it. The
 * link is only ever handed to the authenticated subject (member or same-tenant
 * admin), never embedded in a page an attacker could trigger.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { env } from '@/lib/env';
import { downloadExport, makeDownloadExportDeps } from '@/modules/insights';
import { drizzleMemberRepo } from '@/modules/members';
import type { DownloadExportError } from '@/modules/insights';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const STATUS: Record<DownloadExportError, number> = {
  forbidden: 403,
  not_found: 404,
  not_ready: 409,
  expired: 410,
  invalid_token: 403,
};

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'not_found' } }, { status: 404 });
  }

  const session = await getCurrentSession();
  if (!session) {
    return NextResponse.json({ error: { code: 'unauthorized' } }, { status: 401 });
  }

  const { jobId } = await params;
  const token = request.nextUrl.searchParams.get('token') ?? '';
  const tenant = resolveTenantFromRequest(request);
  const requestId = requestIdFromHeaders(request.headers);

  // Resolve the acting member id for a member session (gates subject artefacts).
  let actorMemberId: string | null = null;
  if (session.user.role === 'member') {
    const member = await drizzleMemberRepo.findByLinkedUserId(tenant, session.user.id);
    if (!member.ok) {
      // not_found (no linked member) → proceed with null (authorize() denies a
      // subject artefact). A DB/RLS fault must NOT masquerade as 403 forbidden —
      // surface it as 500 with a log instead.
      if (member.error.code !== 'repo.not_found') {
        logger.error(
          {
            jobId,
            requestId,
            errCode: member.error.code,
            errKind: errKind((member.error as { cause?: unknown }).cause),
          },
          'exports.download.member_lookup_failed',
        );
        return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
      }
    } else {
      actorMemberId = member.value.memberId;
    }
  }

  // `downloadExport` runs `findById` (runInTenant), `blob.download`, and the
  // consume+audit `runInTenant` tx — each can THROW on an infra fault (Neon
  // drop, Blob 5xx). A throw here (the route that streams the GDPR PII archive)
  // must surface as a logged 500, NOT a bodyless framework 500 — mirroring the
  // member-lookup discrimination above and the sibling download routes
  // (admin/portal data-export, dismiss). [code-review max F9 — finding #2]
  try {
    const result = await downloadExport(
      { jobId, token },
      {
        actorUserId: session.user.id,
        actorRole: session.user.role,
        actorMemberId,
        requestId,
      },
      tenant,
      makeDownloadExportDeps(tenant.slug),
    );

    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error } },
        { status: STATUS[result.error] },
      );
    }

    return new NextResponse(result.value.stream, {
      status: 200,
      headers: {
        'Content-Type': result.value.contentType ?? 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${result.value.filename}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (e) {
    logger.error(
      { jobId, requestId, errKind: errKind(e) },
      'exports.download.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'internal_error' } }, { status: 500 });
  }
}
