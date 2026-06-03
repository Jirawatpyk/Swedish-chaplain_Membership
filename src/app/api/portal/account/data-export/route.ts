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
import { errKind, rootCause } from '@/lib/log-id';
import { getCurrentSession } from '@/lib/auth-session';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { isLocale } from '@/i18n/config';
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
    // Distinguish a benign "session user isn't a member" (404) from a DB/RLS
    // fault (500) — conflating them silently fails a GDPR portability request
    // as "no profile" with no log. Mirrors portal/timeline/route.ts.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        {
          correlationId,
          tenantId: tenant.slug,
          errCode: memberResult.error.code,
          // The Result error is a plain `{code, cause}` object, not an Error —
          // errKind must read the wrapped DB error in `.cause` (errKind(error)
          // would always log 'unknown').
          errKind: errKind(rootCause(memberResult.error)),
        },
        'portal.data_export.member_lookup_failed',
      );
      return NextResponse.json(
        { error: { code: 'server_error' }, correlationId },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { error: { code: 'no_member_profile' }, correlationId },
      { status: 404 },
    );
  }
  const memberId = memberResult.value.memberId;

  // Rate-limit per member (W0-18): each accepted request enqueues a job that drives a
  // ZIP + react-pdf invoice render + full GDPR archive read against Neon. The use-case
  // only dedupes within a single UTC minute, so without this a member could queue ~60
  // archive builds/hour — a resource-exhaustion vector. 3/hour is ample for legitimate
  // self-service. Runs AFTER own-member resolution so the key is the data subject.
  const rl = await rateLimiter.check(`gdpr-export-request:${tenant.slug}:${memberId}`, 3, 3600);
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' }, correlationId },
      {
        status: 429,
        headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() },
      },
    );
  }

  const activeLocale = await getLocale();
  const requesterLocale = isLocale(activeLocale) ? activeLocale : 'en';

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
