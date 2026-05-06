/**
 * F8 Phase 3 Wave H3 · T064 — GET `/api/admin/renewals/[cycleId]`.
 *
 * Cycle detail endpoint per `contracts/admin-renewals-api.md` § 1.
 * Cross-tenant probes auto-emit `renewal_cross_tenant_probe` audit at
 * the use-case layer.
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { loadCycleDetail, makeRenewalsDeps } from '@/modules/renewals';

export async function GET(
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

  const ctx = await requireRenewalAdminContext(request, 'read');
  if ('response' in ctx) return ctx.response;

  const { cycleId } = await context.params;
  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await loadCycleDetail(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      actorUserId: ctx.current.user.id,
      actorRole: ctx.current.user.role === 'admin' ? 'admin' : 'manager',
      requestId: ctx.requestId,
      correlationId: ctx.correlationId,
    });
    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_cycle_id',
            correlationId: ctx.correlationId,
          });
        case 'cycle_not_found':
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId: ctx.correlationId,
          });
        default: {
          // K1-E1: exhaustiveness pin. Adding a new
          // LoadCycleDetailError variant now produces a TS error rather
          // than silently 200ing with `undefined` value.
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
    const v = result.value;
    return successResponse(
      {
        cycle: {
          cycle_id: v.cycle.cycleId,
          member_id: v.cycle.memberId,
          status: v.cycle.status,
          period_from: v.cycle.periodFrom,
          period_to: v.cycle.periodTo,
          expires_at: v.cycle.expiresAt,
          tier_at_cycle_start: v.cycle.tierAtCycleStart,
          plan_id_at_cycle_start: v.cycle.planIdAtCycleStart,
          frozen_plan_price_thb: v.cycle.frozenPlanPriceThb,
          frozen_plan_term_months: v.cycle.frozenPlanTermMonths,
          frozen_plan_currency: v.cycle.frozenPlanCurrency,
          entered_pending_at: v.cycle.enteredPendingAt,
          linked_invoice_id: v.cycle.linkedInvoiceId,
          linked_credit_note_id: v.cycle.linkedCreditNoteId,
          closed_at: v.cycle.closedAt,
          closed_reason: v.cycle.closedReason,
          created_at: v.cycle.createdAt,
          updated_at: v.cycle.updatedAt,
        },
        reminder_history: v.reminderHistory,
        escalation_tasks: v.escalationTasks,
        linked_invoice: v.linkedInvoice
          ? {
              invoice_id: v.linkedInvoice.invoiceId,
              invoice_number: v.linkedInvoice.invoiceNumber,
              status: v.linkedInvoice.status,
              total_satang: v.linkedInvoice.totalSatang.toString(),
            }
          : null,
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
      'load-cycle-detail route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
