/**
 * F8 Phase 6 Wave D · T165 — `POST /api/admin/renewals/at-risk/[memberId]/outreach`.
 *
 * Records an at-risk outreach event per FR-033 + FR-052a manager
 * exception (the ONLY F8 mutating endpoint manager can invoke).
 * Inserts a row into `at_risk_outreach` (data-model.md § 2.5) +
 * emits `at_risk_outreach_recorded` audit. Existing
 * `pause-reminders-after-outreach` use-case (Phase 4 T092) auto-picks
 * up the FR-033 7-day reminder pause cascade.
 *
 * RBAC: admin OR manager (FR-052a manager exception). Uses the
 * dedicated `'manager_exception'` action label (Phase 6 review I5) so
 * the route helper allows both roles via the RBAC layer AND the
 * `f8_role_violation_blocked` audit emit captures the semantic
 * (mutating endpoint that admin+manager are both permitted on, NOT a
 * pure read). Member role 403 + audit emitted as before.
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
import {
  recordAtRiskOutreach,
  makeRenewalsDeps,
} from '@/modules/renewals';

const BodySchema = z.object({
  channel: z.enum(['email', 'phone', 'meeting']),
  template_id: z.string().min(1).max(100).optional(),
  outcome_note: z.string().trim().max(500).optional(),
});

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ memberId: string }> },
) {
  if (!env.features.f8Renewals || env.features.f8AtRiskDisabled) {
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  // 'manager_exception' label (Phase 6 review I5) — admin + manager
  // both pass via the RBAC layer; member rejected with
  // f8_role_violation_blocked audit carrying action='manager_exception'
  // so dashboards can distinguish a manager-permitted write from a
  // pure read.
  const ctx = await requireRenewalAdminContext(request, 'manager_exception');
  if ('response' in ctx) return ctx.response;

  // Capture actor role for the audit payload + use-case discrimination.
  // FR-052a: only 'admin' and 'manager' should reach this point; the
  // helper above rejects 'member'. We re-narrow to the allowed union.
  const actorRole = ctx.current.user.role === 'manager' ? 'manager' : 'admin';

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
    const result = await recordAtRiskOutreach(deps, {
      tenantId: tenantCtx.slug,
      memberId,
      channel: parsed.data.channel,
      ...(parsed.data.template_id !== undefined
        ? { templateId: parsed.data.template_id }
        : {}),
      ...(parsed.data.outcome_note !== undefined
        ? { outcomeNote: parsed.data.outcome_note }
        : {}),
      actorUserId: ctx.current.user.id,
      actorRole,
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
        case 'server_error':
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
      }
      // TS exhaustiveness guard — a new error kind added without a
      // case arm fails the build at this never-assertion.
      const _exhaustive: never = result.error;
      return _exhaustive;
    }
    return successResponse(
      {
        outreach_id: result.value.outreachId,
        created_at: result.value.createdAt,
      },
      ctx.correlationId,
      201,
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        memberId,
        tenantId: tenantCtx.slug,
      },
      'admin.renewals.at-risk.outreach_unexpected_error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
