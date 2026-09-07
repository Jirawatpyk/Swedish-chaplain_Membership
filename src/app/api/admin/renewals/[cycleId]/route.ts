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
import { assertNever } from '@/lib/assert-never';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.CYCLE_DETAIL.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
 */
const ERROR_ID = 'F8.CYCLE_DETAIL';

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

  const ctx = await requireRenewalAdminContext(
    request,
    'read',
    'renewals.read',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  // 016 T030 — the LITERAL role (the old ternary demoted a promoted
  // super_admin to 'manager'). The gate admits exactly the schema's
  // population; anything else here is a gate bug — fail loudly.
  // rbac-narrow-ok: a TYPE narrow onto the use-case's zod population, not an
  // authorization decision — it admits exactly what the gate above admits, so
  // it can only fire if the gate itself regressed.
  const sessionRole = ctx.current.user.role;
  if (sessionRole !== 'admin' && sessionRole !== 'manager' && sessionRole !== 'super_admin') {
    return errorResponse({
      status: 403,
      code: 'forbidden',
      correlationId: ctx.correlationId,
    });
  }

  const { cycleId } = await context.params;
  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await loadCycleDetail(deps, {
      tenantId: tenantCtx.slug,
      cycleId,
      actorUserId: ctx.current.user.id,
      actorRole: sessionRole,
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
          // Review of this branch — this arm RETURNED the 500, so the one
          // failure mode that means "two deploys disagree" produced a 500
          // with no log line at all, while the docblock above promised an
          // SRE rule keyed on `${ERROR_ID}.*` matches every 500 this route
          // can produce. Throwing lands it in the outer catch, which does
          // carry that id.
          return assertNever(
            result.error,
            `${ERROR_ID}: unhandled error kind '${
              (result.error as { readonly kind: string }).kind
            }'`,
          );
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
        errorId: `${ERROR_ID}.UNEXPECTED`,
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type.
        err: e instanceof Error ? e : new Error(String(e)),
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
