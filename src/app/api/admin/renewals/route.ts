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
    return errorResponse({
      status: 503,
      code: 'feature_disabled',
      correlationId: randomUUID(),
    });
  }

  const ctx = await requireRenewalAdminContext(request, 'read');
  if ('response' in ctx) return ctx.response;

  const url = new URL(request.url);
  const rawParams: Record<string, unknown> = {};
  for (const [k, v] of url.searchParams.entries()) {
    rawParams[k] = v;
  }
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
