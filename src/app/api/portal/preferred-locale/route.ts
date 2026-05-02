/**
 * R4 verify-fix Types-#6 (2026-05-02) — member self-service write
 * path for `members.preferred_locale`.
 *
 * PATCH `/api/portal/preferred-locale`
 *
 * Body: `{ preferredLocale: 'en' | 'th' | 'sv' | null }`
 *
 * Authz: member-only (admin/manager 403). The caller can ONLY set
 * their OWN linked member's preference — `requireMemberContext`
 * resolves the member from the session user via the
 * `contacts.linked_user_id → member_id` join. No `memberId` in the
 * URL → no IDOR risk.
 *
 * Idempotent: same value → 200 OK + `{outcome: 'unchanged'}`.
 *
 * GET also supported for portal UI initial render.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  setMemberPreferredLocale,
  getMemberPreferredLocale,
  f3DrizzleMemberRepo,
  f3DrizzleAuditAdapter,
} from '@/modules/members';
import { asTenantContext } from '@/modules/tenants';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

const PreferredLocaleSchema = z.object({
  preferredLocale: z.union([
    z.literal('en'),
    z.literal('th'),
    z.literal('sv'),
    z.null(),
  ]),
});

export async function GET(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  try {
    const result = await getMemberPreferredLocale(
      {
        tenant: asTenantContext(ctx.tenant.slug),
        memberRepo: f3DrizzleMemberRepo,
      },
      ctx.memberId,
    );
    if (!result.ok) {
      logger.error(
        { err: result.error, correlationId, tenantId: ctx.tenant.slug },
        'portal.preferred_locale.read_error',
      );
      return NextResponse.json(
        { error: { code: 'internal_error' }, correlationId },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { preferredLocale: result.value, correlationId },
      { status: 200 },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
      },
      'portal.preferred_locale.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' }, correlationId },
      { status: 500 },
    );
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

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

  try {
    const result = await setMemberPreferredLocale(
      {
        tenant: asTenantContext(ctx.tenant.slug),
        memberRepo: f3DrizzleMemberRepo,
        audit: f3DrizzleAuditAdapter,
      },
      {
        memberId: ctx.memberId,
        nextValue: parsed.data.preferredLocale,
        actor: {
          kind: 'member_self_service',
          userId: ctx.current.user.id,
        },
        requestId: ctx.requestId,
      },
    );
    if (!result.ok) {
      logger.error(
        { err: result.error, correlationId, tenantId: ctx.tenant.slug },
        'portal.preferred_locale.repo_error',
      );
      return NextResponse.json(
        { error: { code: 'internal_error' }, correlationId },
        { status: 500 },
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
        tenantId: ctx.tenant.slug,
      },
      'portal.preferred_locale.unexpected_error',
    );
    return NextResponse.json(
      { error: { code: 'internal_error' }, correlationId },
      { status: 500 },
    );
  }
}
