/**
 * F9 US6 (FR-031) — POST `/api/admin/members/[id]/data-export`.
 *
 * Admin produces a GDPR data export on a member's BEHALF for a data-subject
 * request. Admin-only (`requireAdminContext` with `members/write` blocks the
 * read-only manager — mirroring `requestDataExport`'s manager-forbidden rule);
 * the `data_export_requested` audit is attributed to the admin with
 * `on_behalf=true`. The artefact is built later by the async worker.
 *
 * PDPA §30 / GDPR Art. 15 — an optional `{ subjectContactId }` body answers ONE
 * contact's access request: the archive is built for that contact (their own
 * record in full, colleagues by name and role). The contact must belong to the
 * member (a former contact counts — the right of access outlives the
 * membership); an empty body keeps the company-level archive.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { getLocale } from 'next-intl/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { requireApiPermission } from '@/lib/rbac';
import { rateLimiter } from '@/lib/auth-deps';
import { retryAfterSecondsFromRl } from '@/lib/rate-limit-helpers';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { isLocale } from '@/i18n/config';
import { tryMemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { requestDataExport, makeRequestDataExportDeps } from '@/modules/insights';

export const runtime = 'nodejs';

const BodySchema = z.object({ subjectContactId: z.string().uuid().optional() });

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'feature_disabled' } }, { status: 503 });
  }
  const ctx = await requireApiPermission(request, 'members.bulk');
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const memberIdResult = tryMemberId(id);
  if (!memberIdResult.ok) {
    return NextResponse.json({ error: { code: 'member_not_found' } }, { status: 404 });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    raw = {};
  }
  const parsed = BodySchema.safeParse(raw ?? {});
  if (!parsed.success) {
    return NextResponse.json({ error: { code: 'invalid_body' } }, { status: 400 });
  }
  const subjectContactId = parsed.data.subjectContactId ?? null;

  const tenant = resolveTenantFromRequest(request);

  // Rate-limit per admin actor (W0-18): the on-behalf export drives the same
  // ZIP+PDF+Neon archive build as the self-service path. 20/hour bounds a runaway
  // script while leaving ample headroom for an admin processing a batch of DSARs.
  const rl = await rateLimiter.check(
    `gdpr-export-admin:${tenant.slug}:${ctx.current.user.id}`,
    20,
    3600,
  );
  if (!rl.success) {
    return NextResponse.json(
      { error: { code: 'rate_limited' } },
      {
        status: 429,
        headers: { 'Retry-After': retryAfterSecondsFromRl({ reset: rl.reset }).toString() },
      },
    );
  }

  if (subjectContactId !== null) {
    const contactsResult = await buildMembersDeps(tenant).contactRepo.listByMember(
      tenant,
      memberIdResult.value,
      { includeRemoved: true },
    );
    if (!contactsResult.ok) {
      logger.error(
        { tenantId: tenant.slug, memberId: id, errCode: contactsResult.error.code },
        'admin.members.data_export.contact_lookup_failed',
      );
      return NextResponse.json({ error: { code: 'server_error' } }, { status: 500 });
    }
    if (!contactsResult.value.some((c) => String(c.contactId) === subjectContactId)) {
      return NextResponse.json({ error: { code: 'contact_not_found' } }, { status: 404 });
    }
  }

  const activeLocale = await getLocale();
  const requesterLocale = isLocale(activeLocale) ? activeLocale : 'en';

  try {
    const result = await requestDataExport(
      { subjectMemberId: memberIdResult.value, subjectContactId },
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
