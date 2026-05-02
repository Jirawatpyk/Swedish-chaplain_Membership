/**
 * R4 verify-fix Types-#6 (2026-05-02) — admin write path for
 * `members.preferred_locale`.
 *
 * PATCH `/api/admin/members/[id]/preferred-locale`
 *
 * Body: `{ preferredLocale: 'en' | 'th' | 'sv' | null }`
 *
 * Authz: admin only (manager 403 on `members` write).
 * Idempotent: same value → 200 OK + `{outcome: 'unchanged'}` (no
 * audit emit).
 *
 * The member sees their next email notification (broadcast or other
 * F3+F4+F7 transactional surface) in the new locale.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  setMemberPreferredLocale,
  tryMemberId,
  f3DrizzleMemberRepo,
  f3DrizzleAuditAdapter,
} from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const PreferredLocaleSchema = z.object({
  preferredLocale: z.union([
    z.literal('en'),
    z.literal('th'),
    z.literal('sv'),
    z.null(),
  ]),
});

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'members',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  const { id } = await context.params;
  const memberIdResult = tryMemberId(id);
  if (!memberIdResult.ok) {
    return NextResponse.json(
      { error: { code: 'member_not_found' }, correlationId },
      { status: 404 },
    );
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: 'invalid_body' }, correlationId },
      { status: 400 },
    );
  }
  const parsed = PreferredLocaleSchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: {
          code: 'invalid_body',
          details: parsed.error.flatten().fieldErrors,
        },
        correlationId,
      },
      { status: 400 },
    );
  }

  const tenantCtx = resolveTenantFromRequest(request);
  try {
    const result = await setMemberPreferredLocale(
      {
        tenant: asTenantContext(tenantCtx.slug),
        memberRepo: f3DrizzleMemberRepo,
        audit: f3DrizzleAuditAdapter,
      },
      {
        memberId: memberIdResult.value,
        nextValue: parsed.data.preferredLocale,
        actor: { kind: 'admin', userId: ctx.current.user.id },
        requestId: ctx.requestId,
      },
    );
    if (!result.ok) {
      logger.error(
        {
          err: result.error,
          correlationId,
          tenantId: tenantCtx.slug,
          memberId: id,
        },
        'admin.members.preferred_locale.repo_error',
      );
      return NextResponse.json(
        { error: { code: 'internal_error' }, correlationId },
        { status: 500 },
      );
    }
    if (result.value.kind === 'not_found') {
      return NextResponse.json(
        { error: { code: 'member_not_found' }, correlationId },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { outcome: result.value, correlationId },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
        memberId: id,
      },
      'admin.members.preferred_locale.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' }, correlationId },
      { status: 500 },
    );
  }
}
