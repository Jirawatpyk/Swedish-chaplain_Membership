/**
 * F119 T062 (schedule half) + T062a — `POST /api/admin/broadcasts/[id]/schedule`
 * (contracts/admin-eblast-formatting-api.md § schedule; FR-012a, FR-016,
 * FR-017, FR-018).
 *
 *   `broadcasts.send` (marketing / admin / super_admin) → 200
 *   { stage, confirmedSendAt, proposedSendAt, differs }
 *
 *   { "mode": "keep_proposal" } | { "mode": "schedule", "scheduledFor": ISO }
 *   | { "mode": "send_now" } | { "mode": "cancel" }
 *
 * Order of checks: gate → id → body shape (a malformed body is a 400 that
 * costs no quota) → the 30 / 60 s staff write bucket (ATOMIC, before the use
 * case) → `confirmSchedule` inside the `broadcasts.schedule.confirm` span.
 * From `member_approved` the use case PROMOTES the approved version onto the
 * sending record (the only post-submit content write, trigger exemption E1).
 *
 * ONE `runInTenant` per call inside the use case, throw-to-rollback; no
 * `Idempotency-Key` (research R19 — a replayed promotion finds the row
 * already `approved` and is answered for the mode it carries). No flag read
 * (FR-034: a `member_approved` row stays schedulable with the flag off).
 * Fault arms are named `M119.admin.schedule.<arm>`. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { assertNever } from '@/lib/assert-never';
import { makeConfirmScheduleDeps } from '@/lib/broadcast-approval-deps';
import { inApprovalSpan } from '@/lib/broadcasts-approval-span';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { consumeStaffWriteBucket } from '@/lib/broadcasts-staff-write-bucket';
import { logger } from '@/lib/logger';
import { F119_BROADCASTS_SPANS } from '@/lib/otel-tracer';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  confirmSchedule,
  parseBroadcastId,
  stageOf,
  type ConfirmScheduleError,
  type ScheduleMode,
} from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const BodySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('keep_proposal') }),
  z.object({ mode: z.literal('schedule'), scheduledFor: z.string().datetime({ offset: true }) }),
  z.object({ mode: z.literal('send_now') }),
  z.object({ mode: z.literal('cancel') }),
]);

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.send');
  if ('response' in ctx) return ctx.response;
  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);
  const tenantCtx = resolveTenantFromRequest(request);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  const mode: ScheduleMode =
    parsed.data.mode === 'schedule'
      ? { mode: 'schedule', scheduledFor: new Date(parsed.data.scheduledFor) }
      : { mode: parsed.data.mode };

  const limited = await consumeStaffWriteBucket(tenantCtx.slug, ctx.current.user.id, correlationId);
  if (limited !== null) return limited;

  const result = await inApprovalSpan(
    F119_BROADCASTS_SPANS.scheduleConfirm,
    { tenantSlug: tenantCtx.slug, broadcastId: parsedId.value as string },
    () =>
      confirmSchedule(makeConfirmScheduleDeps(tenantCtx.slug), {
        broadcastId: parsedId.value,
        actorUserId: ctx.current.user.id,
        actorRole: ctx.current.user.role ?? null,
        requestId: ctx.requestId ?? correlationId,
        mode,
      }),
    (confirmed) => ({ stage: stageOf(confirmed.stage), round: confirmed.round }),
  );
  if (!result.ok) return scheduleErrorResponse(result.error, correlationId);

  return NextResponse.json(
    {
      stage: result.value.stage,
      confirmedSendAt: result.value.confirmedSendAt?.toISOString() ?? null,
      proposedSendAt: result.value.proposedSendAt?.toISOString() ?? null,
      differs: result.value.differs,
    },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

function scheduleErrorResponse(error: ConfirmScheduleError, correlationId: string): NextResponse {
  switch (error.kind) {
    case 'not_found':
      return errorResponse(404, 'broadcast_not_found', correlationId);
    case 'stage_changed':
      return errorResponse(409, 'stage_changed', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'mode_not_allowed':
      return errorResponse(409, 'mode_not_allowed', correlationId, {
        details: { stage: stageOf(error.status), status: error.status, mode: error.mode },
      });
    case 'round_zero':
      return errorResponse(409, 'round_zero', correlationId);
    case 'sending_started':
      return errorResponse(409, 'sending_started', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'no_proposal':
      return errorResponse(409, 'no_proposal', correlationId);
    case 'member_halted':
      return errorResponse(409, 'member_halted', correlationId);
    case 'member_not_in_good_standing':
      return errorResponse(409, 'member_not_in_good_standing', correlationId);
    case 'schedule_too_soon':
      return errorResponse(422, 'broadcast_schedule_too_soon', correlationId, {
        details: { scheduledFor: error.scheduledFor.toISOString() },
      });
    case 'image_source_not_allowlisted':
      return errorResponse(422, 'image_source_not_allowlisted', correlationId, {
        details: { images: error.images },
      });
    case 'server_error':
      logger.error(
        { err: error.errKind, correlationId, errorId: 'M119.admin.schedule.server_error' },
        'broadcasts.schedule.failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    default:
      return assertNever(error);
  }
}
