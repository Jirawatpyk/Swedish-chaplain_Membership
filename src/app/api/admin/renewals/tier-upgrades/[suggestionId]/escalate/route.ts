/**
 * F8 Phase 7 T196 — `POST /api/admin/renewals/tier-upgrades/[suggestionId]/escalate`.
 *
 * Admin Escalate drafts a pre-filled outreach record in
 * `at_risk_outreach` linked to the suggestion's member. Suggestion
 * stays in current state (NOT transitioned to terminal); admin can
 * still Accept or Dismiss after the outreach.
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
import { escalateTierUpgrade, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  outcome_note: z.string().trim().max(500).optional(),
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
    const result = await escalateTierUpgrade(deps, {
      tenantId: tenantCtx.slug,
      suggestionId,
      ...(parsed.data.outcome_note !== undefined
        ? { outcomeNote: parsed.data.outcome_note }
        : {}),
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
        outreach_id: result.value.outreachId,
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
      'admin.renewals.tier-upgrades.escalate_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
