/**
 * F8 Phase 6 Wave D · T164 — `POST /api/admin/renewals/at-risk/[memberId]/snooze`.
 *
 * Admin-only at-risk member snooze per FR-032 + contracts/admin-
 * renewals-api.md § 3. Sets `members.risk_snoozed_until = NOW() +
 * duration_days * INTERVAL '1 day'` so the at-risk widget hides the
 * member until the timestamp falls behind NOW().
 *
 * RBAC: admin only (use-case-layer 403 for manager — defence-in-depth
 * on top of route-helper 'write' role gate).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { snoozeAtRiskMember, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  duration_days: z.union([z.literal(7), z.literal(30), z.literal(90)]),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }
  if (env.features.f8AtRiskDisabled) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const { memberId } = await context.params;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await snoozeAtRiskMember(deps, {
      tenantId: tenantCtx.slug,
      memberId,
      durationDays: parsed.data.duration_days,
      actorUserId: ctx.current.user.id,
      actorRole: 'admin',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId: ctx.correlationId,
            details: { message: result.error.message },
          });
        case 'member_not_found':
          return errorResponse({
            status: 404,
            code: 'member_not_found',
            correlationId: ctx.correlationId,
          });
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        }
      }
    }
    return successResponse(
      { snoozed_until: result.value.snoozedUntil },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        memberId,
        tenantId: tenantCtx.slug,
      },
      'admin.renewals.at-risk.snooze_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
