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

const URGENCY_VALUES = [
  't-90',
  't-60',
  't-30',
  't-14',
  't-7',
  't-0',
  'grace',
  'lapsed',
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
          actorRole: 'admin',
          correlationId,
          requestId: null,
        },
      );
    } catch (e) {
      // Audit emit failure must NOT block the 404 response. Log loudly
      // so ops can detect a sustained failure pattern.
      logger.error(
        {
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

  const ctx = await requireRenewalAdminContext(request, 'read');
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
    const result = await loadPipeline(deps, input);
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
        err: e instanceof Error ? e.message : String(e),
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
