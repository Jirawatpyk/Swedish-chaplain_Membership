/**
 * F8 Phase 3 Wave H3 · T065 — POST `/api/admin/renewals/[cycleId]/cancel`.
 *
 * Admin-only manual cycle cancel per `contracts/admin-renewals-api.md` § 2.
 * Manager 403 emits `f8_role_violation_blocked` audit (verify-run C1)
 * via `requireRenewalAdminContext`.
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
import { cancelCycle, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  reason: z.string().min(1).max(500),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ cycleId: string }> },
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

  const { cycleId } = await context.params;

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
    const result = await cancelCycle(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      reason: parsed.data.reason,
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
        case 'cycle_not_found':
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId: ctx.correlationId,
          });
        case 'cycle_not_cancellable':
          return errorResponse({
            status: 409,
            code: 'cycle_not_cancellable',
            correlationId: ctx.correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'server_error':
          // K1-C7: server_error variant from Application use-case.
          // The use-case already logged via pino with full stack; here
          // we surface a generic 500 envelope (no message echo to avoid
          // leaking internals to admin UI).
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin. New error variants now cause a
          // TS error here instead of silently falling through to
          // successResponse with `undefined` value.
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
      {
        status: result.value.status,
        closed_at: result.value.closedAt,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId: ctx.correlationId,
        cycleId,
        tenantId: tenantCtx.slug,
      },
      'cancel-cycle route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
