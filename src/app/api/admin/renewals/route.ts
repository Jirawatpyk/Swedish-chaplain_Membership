/**
 * F8 Phase 3 Wave H3 · T063 — GET `/api/admin/renewals`.
 *
 * Pipeline dashboard list endpoint per `contracts/admin-renewals-api.md` § 1.
 *
 * Authz: admin OR manager (manager is read-only on renewal surfaces).
 * Kill-switch: returns 503 `feature_disabled` when `FEATURE_F8_RENEWALS=false`.
 * Response shape: snake_case per contract; the use-case returns camelCase
 * which is mapped at the boundary.
 */
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { renewalsTracer, withActiveSpan } from '@/lib/otel-tracer';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import {
  loadPipeline,
  makeRenewalsDeps,
  TIER_BUCKETS,
  type LoadPipelineInput,
} from '@/modules/renewals';
import { randomUUID } from 'node:crypto';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it, so an SRE rule keyed on `F8.CYCLE_LIST.*` matches every failure
 * this route can produce.
 *
 * Which suffixes exist here is whatever the code below emits — deliberately
 * NOT listed. Four rounds of review found an enumerated list false as soon as
 * a suffix moved: naming two was wrong once `.SERVER_ERROR` landed, and naming
 * `.SERVER_ERROR` was wrong for the routes that have no `server_error` arm.
 * `pnpm check:f8-error-id` is what holds the claim above true.
 */
const ERROR_ID = 'F8.CYCLE_LIST';

const URGENCY_VALUES = [
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'suspended',
  'terminated',
] as const;

const ListQuerySchema = z.object({
  tier: z.enum(TIER_BUCKETS).optional(),
  urgency: z.enum(URGENCY_VALUES).optional(),
  cursor: z.string().min(1).max(2000).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    // K2 / FR-052(b): dashboard route MUST return 404 (not 503) when
    // kill-switch is off and emit a `renewal_kill_switch_blocked`
    // audit event. The 404 (rather than 503) hides the feature's
    // existence from operators who shouldn't know F8 is dark-launched
    // — matches "feature does not exist on this tenant" UX. The audit
    // emit captures forensic intent ("an admin tried to load the
    // pipeline while F8 was disabled") which is operationally valuable
    // when ops triages a flag-flip incident.
    //
    // Per spec.md FR-052: "(b) the dashboard route (return 404 with
    // audit event `renewal_kill_switch_blocked`)".
    const correlationId = randomUUID();
    try {
      const tenantCtx = resolveTenantFromRequest(request);
      const deps = makeRenewalsDeps(tenantCtx.slug);
      await deps.auditEmitter.emit(
        {
          type: 'renewal_kill_switch_blocked',
          payload: { route: '/api/admin/renewals' },
        },
        {
          tenantId: tenantCtx.slug,
          actorUserId: null,
          // 'system' — this emit fires BEFORE any session lookup (the
          // kill-switch check precedes auth), so there is no actor to
          // attribute: the SYSTEM records that a dark-launched route was
          // probed. The old 'admin' placeholder was the last dishonest
          // actor_role stamp left after the B-1 sweep (016 post-ship).
          actorRole: 'system',
          correlationId,
          requestId: null,
        },
      );
    } catch (e) {
      // Audit emit failure must NOT block the 404 response. Log loudly
      // so ops can detect a sustained failure pattern.
      logger.error(
        {
          // NOT `.UNEXPECTED`: this catch sits on the kill-switch path,
          // which answers 404. The alertable fact is that the
          // `kill_switch_blocked` audit row was lost, not that a request
          // 500ed — a rule keyed on `.UNEXPECTED` firing here would send
          // the on-call looking for an outage that did not happen.
          errorId: `${ERROR_ID}.KILL_SWITCH_AUDIT_EMIT_FAILED`,
          err: e instanceof Error ? e : new Error(String(e)),
          correlationId,
          route: '/api/admin/renewals',
        },
        'load-pipeline route: kill_switch_blocked audit emit failed',
      );
    }
    return errorResponse({
      status: 404,
      code: 'feature_disabled',
      correlationId,
    });
  }

  const ctx = await requireRenewalAdminContext(
    request,
    'read',
    'renewals.read',
    ERROR_ID,
  );
  if ('response' in ctx) return ctx.response;

  // K8-L6: `Object.fromEntries` reads the URLSearchParams iterable
  // in one expression — replaced the 4-line for-loop accumulator.
  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams);
  const parsed = ListQuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_query',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);
  const input: LoadPipelineInput = {
    tenantId: tenantCtx.slug,
    ...(parsed.data.tier !== undefined ? { tier: parsed.data.tier } : {}),
    ...(parsed.data.urgency !== undefined
      ? { urgency: parsed.data.urgency }
      : {}),
    ...(parsed.data.cursor !== undefined
      ? { cursor: parsed.data.cursor }
      : {}),
    ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
  };

  try {
    // Phase 9 / T232 — `admin_pipeline_load` OTel root span. Wraps the
    // `loadPipeline` use-case so the SC-003 p95 < 500ms budget is
    // measurable per-tenant on the OTel histogram bound to this span.
    const result = await withActiveSpan(
      renewalsTracer(),
      'admin_pipeline_load',
      {
        'admin.renewals.tier': parsed.data.tier ?? 'all',
        'admin.renewals.urgency': parsed.data.urgency ?? 'all',
        'admin.renewals.tenant_id': tenantCtx.slug,
      },
      () => loadPipeline(deps, input),
    );
    if (!result.ok) {
      return errorResponse({
        status: 400,
        code: 'invalid_input',
        correlationId: ctx.correlationId,
        details: { issues: result.error.issues },
      });
    }
    const { rows, nextCursor, summary } = result.value;
    const items = rows.map((r) => ({
      cycle_id: r.cycleId,
      member_id: r.memberId,
      company_name: r.companyName,
      tier_bucket: r.tierBucket,
      expires_at: r.expiresAt,
      urgency: r.urgency,
      status: r.status,
      last_reminder_at: r.lastReminderAt,
      last_reminder_step_id: r.lastReminderStepId,
      linked_invoice_id: r.linkedInvoiceId,
    }));
    return successResponse(
      {
        items,
        next_cursor: nextCursor,
        summary: {
          total_in_window: summary.totalInWindow,
          by_urgency: summary.byUrgency,
          lapsed_count: summary.lapsedCount,
        },
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        // K12-3 (REL-K-1): pass the Error instance so pino's `err`
        // serializer captures stack + type. Passing the bare message
        // string drops the stack trace and breaks Sentry/Grafana
        // `err.type` filters.
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        tenantId: tenantCtx.slug,
      },
      'load-pipeline route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
