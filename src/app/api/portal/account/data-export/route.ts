/**
 * F9 US6 (T093) — POST `/api/portal/account/data-export`.
 *
 * Member self-service GDPR data-export request (FR-029): enqueues a
 * `gdpr_member_archive` job for the caller's OWN data. The member is resolved
 * from the session (`findByLinkedUserId`), never the body — `requestDataExport`
 * enforces own-only. The requester's current UI locale is captured for the
 * README (FR-029). CSRF Origin + session enforced by the proxy for `/api/**`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestDataExport, makeRequestDataExportDeps } from '@/modules/insights';
import { buildMembersDeps } from '@/modules/members/members-deps';

export const runtime = 'nodejs';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  if (!env.features.f9Dashboard) {
    return NextResponse.json(
      { error: { code: 'feature_disabled' }, correlationId },
      { status: 503 },
    );
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' }, correlationId }, { status: 401 });
  }
  if (current.user.role !== 'member') {
    // Self-service route is for members; an admin uses the admin-on-behalf path.
    return NextResponse.json({ error: { code: 'forbidden' }, correlationId }, { status: 403 });
  }

  const tenant = resolveTenantFromRequest(request);
  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(
    tenant,
    current.user.id,
  );
  if (!memberResult.ok) {
    return NextResponse.json(
      { error: { code: 'no_member_profile' }, correlationId },
      { status: 404 },
    );
  }
  const memberId = memberResult.value.memberId;
  const requesterLocale = await getLocale();

  try {
    const result = await requestDataExport(
      { subjectMemberId: memberId },
      {
        actorUserId: current.user.id as string,
        actorRole: 'member',
        actorMemberId: memberId,
        requesterLocale,
        requestId: correlationId,
      },
      tenant,
      makeRequestDataExportDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error }, correlationId },
        { status: result.error === 'forbidden' ? 403 : 400 },
      );
    }
    return NextResponse.json(
      { ok: true, jobId: result.value.jobId, created: result.value.created, correlationId },
      { status: 202 },
    );
  } catch (e) {
    logger.error(
      { correlationId, tenantId: tenant.slug, errKind: errKind(e) },
      'portal.data_export.request.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}
