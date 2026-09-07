/**
 * 059-membership-suspension Task 9 — GET
 * `/api/admin/renewals/settlement-preview`.
 *
 * Read-only per-cycle THB settlement-preview join, backing the future bulk
 * "Mark paid" confirm dialog (⑨). Given a comma-separated `cycle_ids` list
 * (1..100), returns each cycle's live linked-bill total (or a
 * non-previewable stub) plus the batch total — so an operator sees the
 * EXACT amount to expect on a bulk bank-transfer BEFORE confirming, never
 * an inflated or stale figure (see `loadSettlementPreview` /
 * `SettlementPreviewRow.previewable`).
 *
 * Authz: admin OR manager (read-only surface — mirrors GET
 * /api/admin/renewals).
 * Kill-switch: 404 `feature_disabled` + `renewal_kill_switch_blocked` audit
 * when `FEATURE_F8_RENEWALS=false` (FR-052b pattern — mirrors the pipeline
 * list route's kill-switch behaviour, not the older 503 on the
 * cycle-detail route).
 */
import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  errorResponse,
  successResponse,
  requireRenewalAdminContext,
} from '@/lib/renewals-route-helpers';
import { loadSettlementPreview, makeRenewalsDeps } from '@/modules/renewals';

/**
 * This route's entry in the F8 errorId taxonomy (`F8ErrorId` in
 * `src/lib/renewals-route-helpers.ts`, documented in
 * `docs/runbooks/audit-emit-loss.md`). Every line this route logs about a
 * failure carries it with a suffix — `.CONTEXT_RESOLUTION_FAILED` from the
 * admin gate before the try block, `.SERVER_ERROR` from the use-case's own
 * error variant, `.UNEXPECTED` from the outer catch — so
 * an SRE rule keyed on `F8.SETTLEMENT_PREVIEW.*` matches every 500 this route
 * can produce.
 */
const ERROR_ID = 'F8.SETTLEMENT_PREVIEW';

const MAX_CYCLE_IDS = 100;

const QuerySchema = z.object({
  cycle_ids: z.string().min(1),
});

// Review round 1 fix A — every id in the comma-list must be a well-formed
// UUID. Without this, `?cycle_ids=not-a-uuid` sailed past the old
// count-only guard, reached Postgres, and threw `22P02 invalid input
// syntax for type uuid` — surfacing as a 500 `server_error` instead of a
// 400 `invalid_query`.
const CycleIdSchema = z.string().uuid();

export async function GET(request: NextRequest) {
  if (!env.features.f8Renewals) {
    // Mirrors GET /api/admin/renewals (FR-052b): 404 (not 503) + a
    // `renewal_kill_switch_blocked` audit so ops has a forensic trail of
    // an admin hitting a dark-launched route.
    const correlationId = randomUUID();
    try {
      const tenantCtx = resolveTenantFromRequest(request);
      const deps = makeRenewalsDeps(tenantCtx.slug);
      await deps.auditEmitter.emit(
        {
          type: 'renewal_kill_switch_blocked',
          payload: { route: '/api/admin/renewals/settlement-preview' },
        },
        {
          tenantId: tenantCtx.slug,
          actorUserId: null,
          // 'system' — pre-auth kill-switch emit, no session exists yet;
          // see the twin comment in ../route.ts (016 post-ship, B-1 tail).
          actorRole: 'system',
          correlationId,
          requestId: null,
        },
      );
    } catch (e) {
      // Audit emit failure must NOT block the 404 response.
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
          route: '/api/admin/renewals/settlement-preview',
        },
        'load-settlement-preview route: kill_switch_blocked audit emit failed',
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

  const url = new URL(request.url);
  const rawParams = Object.fromEntries(url.searchParams);
  const parsed = QuerySchema.safeParse(rawParams);
  if (!parsed.success) {
    return errorResponse({
      status: 400,
      code: 'invalid_query',
      correlationId: ctx.correlationId,
      details: { fieldErrors: parsed.error.flatten().fieldErrors },
    });
  }

  const rawCycleIds = parsed.data.cycle_ids
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  // De-dupe BEFORE validating/querying — a repeated id is not an error, it
  // is just redundant work (and would otherwise double-count nothing today,
  // but a future caller must not be able to inflate `items.length` by
  // repetition).
  const cycleIds = [...new Set(rawCycleIds)];
  const allValidUuids = cycleIds.every(
    (id) => CycleIdSchema.safeParse(id).success,
  );
  if (
    cycleIds.length === 0 ||
    cycleIds.length > MAX_CYCLE_IDS ||
    !allValidUuids
  ) {
    return errorResponse({
      status: 400,
      code: 'invalid_query',
      correlationId: ctx.correlationId,
      details: {
        message: `cycle_ids must be 1..${MAX_CYCLE_IDS} unique, well-formed UUIDs`,
      },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeRenewalsDeps(tenantCtx.slug);

  try {
    const result = await loadSettlementPreview(
      { renewalCycleRepo: deps.cyclesRepo },
      { tenantId: tenantCtx.slug, cycleIds },
    );
    if (!result.ok) {
      return errorResponse({
        status: 400,
        code: 'invalid_input',
        correlationId: ctx.correlationId,
        details: { message: result.error.message },
      });
    }
    const { items, totalThbMinor } = result.value;
    return successResponse(
      {
        items: items.map((r) => ({
          cycle_id: r.cycleId,
          company_name: r.companyName,
          invoice_id: r.invoiceId,
          amount_thb_minor: r.amountThbMinor,
          currency: r.currency,
          previewable: r.previewable,
        })),
        total_thb_minor: totalThbMinor,
      },
      ctx.correlationId,
    );
  } catch (e) {
    logger.error(
      {
        errorId: `${ERROR_ID}.UNEXPECTED`,
        err: e instanceof Error ? e : new Error(String(e)),
        correlationId: ctx.correlationId,
        tenantId: tenantCtx.slug,
      },
      'load-settlement-preview route unexpected error',
    );
    return errorResponse({
      status: 500,
      code: 'server_error',
      correlationId: ctx.correlationId,
    });
  }
}
