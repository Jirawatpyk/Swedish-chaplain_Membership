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
import { assertNever } from '@/lib/assert-never';
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

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it with a suffix — `.CONTEXT_RESOLUTION_FAILED` from the
 * admin gate before the try block, `.SERVER_ERROR` from the use-case's own
 * error variant, `.UNEXPECTED` from the outer catch — so
 * an SRE rule keyed on `F8.AT_RISK_OUTREACH.*` matches every 500 this route
 * can produce.
 */
const ERROR_ID = 'F8.AT_RISK_OUTREACH';

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
  const ctx = await requireRenewalAdminContext(
    request,
    'manager_exception',
    'renewals.read',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  // Capture the LITERAL actor role for the audit payload + use-case
  // discrimination (016 T030 — the old ternary ESCALATED any non-manager role
  // to 'admin'). The gate admits the manager_exception population
  // (admin ∪ super_admin ∪ manager); anything else here is a gate bug — fail
  // loudly instead of stamping a coerced role.
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
  const actorRole = sessionRole;

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
          // Round-2 review — this arm returns the 500 this route produces
          // MOST often (the use-case caught something), and it logged no
          // errorId, so the docblock's promise that a rule keyed on
          // `${ERROR_ID}.*` matches every 500 was false for the common case.
          // `accept/route.ts` had done this since R3-S5; nothing else had.
          logger.error(
            {
              errorId: `${ERROR_ID}.SERVER_ERROR`,
              correlationId: ctx.correlationId,
            },
            'admin.renewals.at_risk_outreach_server_error',
          );
          return errorResponse({
            status: 500,
            code: 'server_error',
            correlationId: ctx.correlationId,
          });
      }
      // docs/code-conventions.md § 8 — `return _exhaustive` returned the
      // ERROR OBJECT into a `Response` position and, worse, left the `try`
      // NORMALLY, so the catch below never fired and the 500 carried no
      // correlationId. This catch also had no `errorId` at all until the
      // review of that first fix -
      // so nothing an alert rule keys on matched it either, before or
      // after. `assertNever` throws INSIDE the try; the errorId is now
      // emitted. The message names the KIND only -
      // `assertNever`'s default stringifies the whole error object into a
      // message this catch then logs, and a future error kind's payload is
      // not something we can promise is free of member data.
      return assertNever(
        result.error,
        `record-at-risk-outreach: unhandled error kind '${(result.error as { readonly kind: string }).kind}'`,
      );
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
        // Review of this change - the comment above the assertNever arm
        // promised an `errorId` this catch did not emit. The F8 alert
        // rules are told to key on it (docs/runbooks/audit-emit-loss.md:
        // "Pin SRE alert rules to errorId, NOT to message-text strings"), so
        // without it an unhandled error kind reached a 500 that no rule
        // could match. Added so the comment and docs/code-conventions.md
        // are true of this file, not only of the accept route.
        errorId: `${ERROR_ID}.UNEXPECTED`,
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
