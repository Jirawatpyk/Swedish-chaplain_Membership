/**
 * F9 US5 (T082b) — POST/DELETE `/api/portal/directory/logo`.
 *
 * Member self-service logo upload (POST, multipart) + removal (DELETE) for the
 * member's OWN listing (FR-025a). The member is resolved from the session, never
 * the body. The safe-image pipeline (re-encode + EXIF strip, ≤2 MB, PNG/JPEG/
 * WebP) lives in `setDirectoryLogo`; only the re-encoded bytes are stored.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { getCurrentSession, type CurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { setDirectoryLogo, removeDirectoryLogo, MAX_LOGO_UPLOAD_BYTES } from '@/modules/insights';
import {
  makeSetDirectoryLogoDeps,
  makeRemoveDirectoryLogoDeps,
} from '@/modules/insights/infrastructure/set-directory-logo-deps';
import { buildMembersDeps } from '@/modules/members/members-deps';
import type { TenantContext } from '@/modules/tenants';

export const runtime = 'nodejs';

const ERROR_STATUS: Record<string, number> = {
  forbidden: 403,
  member_not_found: 404,
  too_large: 413,
  unsupported_format: 415,
  invalid_image: 422,
};

/** Shared guard: feature flag + member session + own-member resolution. */
async function gate(
  request: NextRequest,
  correlationId: string,
): Promise<{ tenant: TenantContext; memberId: string; current: CurrentSession } | NextResponse> {
  if (!env.features.f9Dashboard) {
    return NextResponse.json({ error: { code: 'feature_disabled' }, correlationId }, { status: 503 });
  }
  const current = await getCurrentSession();
  if (!current) {
    return NextResponse.json({ error: { code: 'unauthorized' }, correlationId }, { status: 401 });
  }
  if (current.user.role !== 'member') {
    return NextResponse.json({ error: { code: 'forbidden' }, correlationId }, { status: 403 });
  }
  const tenant = resolveTenantFromRequest(request);
  const memberResult = await buildMembersDeps(tenant).memberRepo.findByLinkedUserId(
    tenant,
    current.user.id,
  );
  if (!memberResult.ok) {
    // not_found → 404; a DB/RLS fault must surface as 500 (logged), not 404.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.error(
        {
          correlationId,
          tenantId: tenant.slug,
          errCode: memberResult.error.code,
          errKind: errKind((memberResult.error as { cause?: unknown }).cause),
        },
        'portal.directory.logo.member_lookup_failed',
      );
      return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
    }
    return NextResponse.json({ error: { code: 'no_member_profile' }, correlationId }, { status: 404 });
  }
  return { tenant, memberId: memberResult.value.memberId, current };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const gated = await gate(request, correlationId);
  if (gated instanceof NextResponse) return gated;
  const { tenant, memberId, current } = gated;

  // Reject oversize before buffering the whole body (defence-in-depth; the
  // use-case re-checks the actual byte length too).
  const declaredLength = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declaredLength) && declaredLength > MAX_LOGO_UPLOAD_BYTES + 4096) {
    return NextResponse.json({ error: { code: 'too_large' }, correlationId }, { status: 413 });
  }

  let file: File | null = null;
  try {
    const form = await request.formData();
    const f = form.get('file');
    if (f instanceof File) file = f;
  } catch {
    file = null;
  }
  if (file === null) {
    return NextResponse.json({ error: { code: 'invalid_body' }, correlationId }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  try {
    const result = await setDirectoryLogo(
      { memberId, bytes, declaredMime: file.type },
      {
        actorUserId: current.user.id as string,
        actorRole: 'member',
        actorMemberId: memberId,
        requestId: correlationId,
      },
      tenant,
      makeSetDirectoryLogoDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error }, correlationId },
        { status: ERROR_STATUS[result.error] ?? 400 },
      );
    }
    return NextResponse.json({ ok: true, logoUrl: result.value.logoUrl, correlationId }, { status: 200 });
  } catch (e) {
    logger.error(
      { correlationId, tenantId: tenant.slug, errKind: errKind(e) },
      'portal.directory.logo.upload.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const gated = await gate(request, correlationId);
  if (gated instanceof NextResponse) return gated;
  const { tenant, memberId, current } = gated;

  try {
    const result = await removeDirectoryLogo(
      { memberId },
      {
        actorUserId: current.user.id as string,
        actorRole: 'member',
        actorMemberId: memberId,
        requestId: correlationId,
      },
      tenant,
      makeRemoveDirectoryLogoDeps(tenant.slug),
    );
    if (!result.ok) {
      return NextResponse.json(
        { error: { code: result.error }, correlationId },
        { status: ERROR_STATUS[result.error] ?? 400 },
      );
    }
    return NextResponse.json({ ok: true, correlationId }, { status: 200 });
  } catch (e) {
    logger.error(
      { correlationId, tenantId: tenant.slug, errKind: errKind(e) },
      'portal.directory.logo.remove.unexpected_error',
    );
    return NextResponse.json({ error: { code: 'server_error' }, correlationId }, { status: 500 });
  }
}
