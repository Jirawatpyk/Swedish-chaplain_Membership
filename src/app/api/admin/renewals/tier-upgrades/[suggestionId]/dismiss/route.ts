/**
 * F8 Phase 7 T195 — `POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss`.
 *
 * Admin Dismiss transitions suggestion `open` → `dismissed`, sets
 * `suppressed_until` to today + 90d, optionally captures a free-text
 * reason (≤500 chars).
 *
 * RBAC: admin only.
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
import { dismissTierUpgrade, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ suggestionId: string }> },
) {
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'write');
  if ('response' in ctx) return ctx.response;

  const { suggestionId } = await context.params;
  let raw: unknown = {};
  try {
    raw = await request.json();
  } catch {
    // Empty body is acceptable — reason is optional.
    raw = {};
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
    const result = await dismissTierUpgrade(deps, {
      tenantId: tenantCtx.slug,
      suggestionId,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
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
        case 'suggestion_not_found':
          return errorResponse({
            status: 404,
            code: 'suggestion_not_found',
            correlationId: ctx.correlationId,
          });
        case 'suggestion_not_open':
          return errorResponse({
            status: 409,
            code: 'suggestion_not_open',
            correlationId: ctx.correlationId,
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
      }
      const _exhaustive: never = result.error;
      return _exhaustive;
    }
    return successResponse(
      {
        suggestion_id: result.value.suggestionId,
        suppressed_until: result.value.suppressedUntil,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        suggestionId,
      },
      'admin.renewals.tier-upgrades.dismiss_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
