/**
 * F119 T079 — `POST /api/broadcasts/[id]/decision` (contracts/portal-eblast-
 * approval-api.md § decision; US1-AS4, US2, FR-009, FR-010, FR-013, FR-015a).
 *
 *   `requireMemberContext` (a member session only — a STAFF session is
 *   refused 403 here, which is how FR-013 "a staff user can never give the
 *   member-side approval" is enforced structurally) → 200
 *   { stage, whoseTurn, round, decision }
 *
 * Order of checks: the session gate → id (a malformed id is a 404 before any
 * read, with no audit row) → the 60 / minute per-(tenant, user) member write
 * bucket, an ATOMIC check consumed BEFORE the body is read or the use case
 * runs (T077) → the body → `recordMemberDecision` inside the
 * `broadcasts.member.decide` span, which re-reads the row under its lock and
 * owns the owning-member rule (another member's E-Blast → 404 +
 * `broadcast_cross_member_probe`; unknown / another tenant's → 404 +
 * `broadcast_cross_tenant_probe` — never 403, no existence leak).
 *
 * Nothing here reads `FEATURE_EBLAST_MEMBER_APPROVAL`: a row already awaiting
 * the member stays decidable with the flag off (FR-034, T150). Nothing here
 * checks membership standing: deciding is not a benefit action (spec § Edge
 * Cases). No `Idempotency-Key` (research R19): a repeat answers 409
 * `stage_changed` carrying the decision already recorded. The F7 master
 * kill-switch and read-only mode are enforced upstream in `src/proxy.ts`
 * (`/api/broadcasts/**`).
 *
 * Fault arms are named `M119.portal.decision.<arm>`. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { assertNever } from '@/lib/assert-never';
import { makeRecordMemberDecisionDeps } from '@/lib/broadcast-approval-deps';
import { inApprovalSpan } from '@/lib/broadcasts-approval-span';
import { consumeMemberWriteBucket } from '@/lib/broadcasts-member-write-bucket';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { broadcastsMetrics } from '@/lib/metrics';
import { F119_BROADCASTS_SPANS } from '@/lib/otel-tracer';
import {
  parseBroadcastId,
  recordMemberDecision,
  stageOf,
  turnOf,
  type RecordMemberDecisionError,
} from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The reason's bounds are the Domain's (`reasonBounds`) — refused by the use
 * case as 422 `reason_required` / `validation_error`, never as a 400 here, so
 * the schema carries no length cap of its own (any over-long reason is the
 * contract's 422, whatever its length).
 */
const DecisionBodySchema = z.object({
  versionId: z.string().uuid(),
  decision: z.enum(['approved', 'changes_requested', 'approval_withdrawn']),
  reason: z.string().nullable().optional(),
});

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);

  const limited = await consumeMemberWriteBucket(ctx.tenant.slug, ctx.current.user.id, correlationId);
  if (limited !== null) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const body = DecisionBodySchema.safeParse(raw);
  if (!body.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: body.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const started = performance.now();
  const result = await inApprovalSpan(
    F119_BROADCASTS_SPANS.memberDecide,
    { tenantSlug: ctx.tenant.slug, broadcastId: parsedId.value as string },
    () =>
      recordMemberDecision(makeRecordMemberDecisionDeps(ctx.tenant.slug), {
        broadcastId: parsedId.value,
        memberId: ctx.memberId as string,
        actorUserId: ctx.current.user.id,
        actorRole: ctx.current.user.role ?? null,
        contactId: ctx.ownContactId as string,
        versionId: body.data.versionId,
        decision: body.data.decision,
        reason: body.data.reason ?? null,
        requestId: ctx.requestId ?? correlationId,
      }),
    (decided) => ({ stage: stageOf(decided.stage), round: decided.round }),
  );
  broadcastsMetrics.memberDecideMs(ctx.tenant.slug, performance.now() - started);
  if (!result.ok) return decisionErrorResponse(result.error, ctx.current.user.id, correlationId);

  const { stage, round, decision } = result.value;
  return NextResponse.json(
    {
      stage,
      whoseTurn: turnOf(stage),
      round,
      decision: {
        id: decision.id,
        versionId: decision.versionId,
        decision: decision.decision,
        decidedAt: decision.decidedAt.toISOString(),
      },
    },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

/**
 * `callerUserId` — the session user. A 409 `stage_changed` says whether THEY
 * recorded the decision on file (`byCaller`, PR #392 review D6): a colleague at
 * the same member may have recorded the same decision on the same version, and
 * that is not this user's retry succeeding. The colleague's id never leaves.
 */
function decisionErrorResponse(error: RecordMemberDecisionError, callerUserId: string, correlationId: string): NextResponse {
  switch (error.kind) {
    case 'reason_required':
      return errorResponse(422, 'reason_required', correlationId, { fieldErrors: { reason: ['reason_required'] } });
    case 'reason_too_long':
      return errorResponse(422, 'validation_error', correlationId, {
        fieldErrors: { reason: ['too_long'] },
        details: { max: error.max },
      });
    case 'not_found':
      return errorResponse(404, 'broadcast_not_found', correlationId);
    case 'sending_started':
      return errorResponse(409, 'sending_started', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'stage_changed':
      return errorResponse(409, 'stage_changed', correlationId, {
        details: {
          stage: stageOf(error.status),
          status: error.status,
          recordedDecision:
            error.recorded === null
              ? null
              : {
                  id: error.recorded.id,
                  versionId: error.recorded.versionId,
                  decision: error.recorded.decision,
                  decidedAt: error.recorded.decidedAt.toISOString(),
                  byCaller: error.recorded.decidedByUserId === callerUserId,
                },
        },
      });
    case 'stale_version':
      return errorResponse(409, 'stale_version', correlationId, { details: { currentVersion: error.current } });
    case 'server_error':
      logger.error(
        { err: error.errKind, correlationId, errorId: 'M119.portal.decision.server_error' },
        'broadcasts.member_decision.failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    default:
      return assertNever(error);
  }
}
