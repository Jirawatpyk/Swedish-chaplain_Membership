/**
 * F8 Phase 3 Wave H3 · T066 — POST `/api/admin/renewals/[cycleId]/mark-paid-offline`.
 *
 * Admin-only out-of-band payment per `contracts/admin-renewals-api.md` § 2.
 * Manager 403 emits `f8_role_violation_blocked` audit (verify-run C1).
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
import { markPaidOffline, makeRenewalsDeps } from '@/modules/renewals';

const BodySchema = z.object({
  payment_method: z.enum(['bank_transfer', 'cash', 'cheque']),
  payment_reference: z.string().min(1).max(100),
  payment_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
    const result = await markPaidOffline(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      paymentMethod: parsed.data.payment_method,
      paymentReference: parsed.data.payment_reference,
      paymentDate: parsed.data.payment_date,
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
        case 'cycle_not_payable':
          return errorResponse({
            status: 409,
            code: 'cycle_not_payable',
            correlationId: ctx.correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'f4_failure':
          return errorResponse({
            status: 502,
            code: 'f4_failure',
            correlationId: ctx.correlationId,
            details: {
              stage: result.error.stage,
              reason: result.error.reason,
            },
          });
      }
    }
    return successResponse(
      {
        cycle_status: result.value.cycleStatus,
        invoice_id: result.value.invoiceId,
        new_expires_at: result.value.newExpiresAt,
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
      'mark-paid-offline route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
