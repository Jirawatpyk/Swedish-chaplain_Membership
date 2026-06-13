/**
 * F8-completion Slice 3 · Task 3.2 —
 * POST `/api/admin/members/[id]/renew`.
 *
 * Admin "renew / reactivate a lapsed member" reachable path. Creates a
 * fresh `awaiting_payment` renewal cycle for a lapsed member + issues a
 * §86/4 renewal invoice (at the member's frozen plan price) the member
 * then pays. Wraps the `adminRenewLapsedMember` use-case (Task 3.1).
 *
 * Slug name `[id]` matches the existing F3 admin route family
 * (`/api/admin/members/[id]/block-auto-reactivation` etc.) — Next.js
 * requires consistent dynamic-segment slug names within the same path
 * tree.
 *
 * Auth: admin role only (`action='write'`). Manager 403 emits
 * `f8_role_violation_blocked` audit via `requireRenewalAdminContext`
 * (mirrors block-auto-reactivation + cancel-cycle routes). NOT a
 * manager-exception surface — issuing a §86/4 tax document is a
 * write-class admin action.
 *
 * Body: `{ plan_year }`. The frozen §86/4 price is server-derived from
 * the member's current plan inside the use-case — there is NO price
 * field on the request body (a renewal §86/4 is a price-tampering
 * surface on a tax document).
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
import { adminRenewLapsedMember, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  plan_year: z.number().int().min(2000).max(2100),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
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

  const { id: memberId } = await context.params;

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
    const result = await adminRenewLapsedMember(deps, {
      tenantId: tenantCtx.slug,
      memberId,
      planYear: parsed.data.plan_year,
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
        case 'member_has_active_cycle':
          return errorResponse({
            status: 409,
            code: 'member_has_active_cycle',
            correlationId: ctx.correlationId,
          });
        case 'plan_not_found':
          return errorResponse({
            status: 422,
            code: 'plan_not_found',
            correlationId: ctx.correlationId,
          });
        case 'invoice_issue_failed':
          return errorResponse({
            status: 502,
            code: 'invoice_issue_failed',
            correlationId: ctx.correlationId,
            details: { stage: result.error.stage },
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
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
      {
        cycle_id: result.value.cycleId,
        invoice_id: result.value.invoiceId,
        cycle_status: result.value.cycleStatus,
      },
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
      'admin-renew-lapsed-member route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
