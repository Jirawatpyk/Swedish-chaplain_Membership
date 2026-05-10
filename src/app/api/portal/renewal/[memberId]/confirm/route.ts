/**
 * F8 Phase 5 Wave C · T130 — POST `/api/portal/renewal/[memberId]/confirm`.
 *
 * Member confirms their renewal via the public portal page. Wraps the
 * `confirmRenewal` use-case (T122) which optionally updates the cycle's
 * frozen-plan fields (FR-021b atomic), composes F4 createInvoiceDraft +
 * issueInvoice via the F4 invoicing bridge, links the issued invoice to
 * the cycle, and emits the audit chain.
 *
 * Auth: member role only via `requireMemberContext`. The session-member
 * MUST match URL [memberId] — cross-member attempts emit
 * `renewal_cross_member_probe` audit (handled inside the use-case) and
 * return 404 (no oracle per FR-027 generic-error policy).
 *
 * Rate-limit: 10/1h per member per FR-027 (deferred — wired alongside
 * existing rate-limit infra in a follow-on; the portal page rate-
 * limits the verify-token path which is the actual abuse vector).
 */
import { type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { renewalsMetrics } from '@/lib/metrics';
import { requireMemberContext } from '@/lib/member-context';
import { errorResponse, successResponse } from '@/lib/renewals-route-helpers';
import {
  confirmRenewal,
  makeRenewalsDeps,
  selfServiceFailureReason,
} from '@/modules/renewals';

const BodySchema = z.object({
  cycleId: z.string().uuid(),
  /** Optional — when present + differs from cycle.planIdAtCycleStart triggers FR-025 plan-change branch. */
  newPlanId: z.string().min(1).optional(),
  planYear: z.number().int().min(2000).max(2100),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
) {
  const correlationId = randomUUID();
  if (!env.features.f8Renewals) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId,
    });
  }

  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  const { memberId: urlMemberId } = await context.params;

  // C1 review-fix (2026-05-07): session-vs-URL guard. Without this,
  // member A could POST to `/api/portal/renewal/<memberB_id>/confirm`
  // with member B's cycleId and trigger F4 invoice issuance against
  // member B's renewal cycle. The use-case below checks cycle-vs-URL
  // (cross-member-probe), but URL is attacker-controlled — only the
  // session-bound `ctx.memberId` is trusted. Generic 404 per FR-027
  // (no oracle).
  if (urlMemberId !== ctx.memberId) {
    return errorResponse({
      status: 404,
      code: 'cycle_not_found',
      correlationId,
    });
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
    });
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_body',
      correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const deps = makeRenewalsDeps(ctx.tenant.slug);

  try {
    // Phase 9 / T232 — `member_self_service_renewal` OTel root span
    // wrapping the confirm-renewal use-case. The TTFB < 600ms +
    // confirm p95 < 1.2s budgets per spec.md FR-046 / SC are bound
    // to this span's histogram.
    const result = await withActiveSpan(
      renewalsTracer(),
      'member_self_service_renewal',
      {
        'portal.renewal.tenant_id': ctx.tenant.slug,
        'portal.renewal.has_plan_change':
          parsed.data.newPlanId !== undefined,
      },
      () =>
        confirmRenewal(deps, {
          tenantId: ctx.tenant.slug,
          cycleId: parsed.data.cycleId,
          memberId: urlMemberId,
          ...(parsed.data.newPlanId !== undefined
            ? { newPlanId: parsed.data.newPlanId }
            : {}),
          planYear: parsed.data.planYear,
          actorUserId: ctx.current.user.id,
          actorRole: 'member',
          requestId: ctx.requestId,
          correlationId,
        }),
    );

    // Phase 9 / T231 — emit per-tenant failure counter for FR-046
    // conversion-funnel dashboard. The success counter is emitted
    // inside confirm-renewal use-case (post-tx); the failure counter
    // lives at the route boundary because the use-case does not
    // have a "global try/catch -> failure metric" path.
    if (!result.ok) {
      renewalsMetrics.selfServiceFailed(
        ctx.tenant.slug,
        selfServiceFailureReason(result.error),
      );
    }

    if (!result.ok) {
      switch (result.error.kind) {
        case 'invalid_input':
          return errorResponse({
            status: 400,
            code: 'invalid_input',
            correlationId,
            details: { message: result.error.message },
          });
        case 'cycle_not_found':
        case 'cross_member_probe':
          // FR-027 generic-error — no oracle leaking which case fired.
          return errorResponse({
            status: 404,
            code: 'cycle_not_found',
            correlationId,
          });
        case 'cycle_not_payable':
          return errorResponse({
            status: 409,
            code: 'cycle_not_payable',
            correlationId,
            details: { current_status: result.error.currentStatus },
          });
        case 'plan_not_found':
        case 'plan_inactive':
          return errorResponse({
            status: 400,
            code: result.error.kind,
            correlationId,
          });
        case 'invoice_creation_failed':
          return errorResponse({
            status: 502,
            code: 'invoice_creation_failed',
            correlationId,
            details: { stage: result.error.stage },
          });
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId,
          });
        default: {
          const _exhaustive: never = result.error;
          void _exhaustive;
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId,
          });
        }
      }
    }

    return successResponse(
      {
        invoice_id: result.value.invoiceId,
        invoice_number: result.value.invoiceNumber,
        pay_url: result.value.payUrl,
        plan_changed: result.value.planChanged,
      },
      correlationId,
    );
  } catch (e) {
    // Phase 9 verify-fix C1 — emit selfServiceFailed counter on the
    // outer-catch path BEFORE the 500 response. Without this, an
    // unexpected throw (runInTenant connection drop, F4-bridge
    // TypeError, OTel adapter throw) would log + 500 but the
    // FR-046 conversion-funnel dashboard would record ZERO failures
    // → green-flagged broken portal.
    renewalsMetrics.selfServiceFailed(ctx.tenant.slug, 'unexpected_error');
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId,
        urlMemberId,
        tenantId: ctx.tenant.slug,
      },
      'confirm-renewal route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId,
    });
  }
}
