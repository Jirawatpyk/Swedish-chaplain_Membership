/**
 * F119 T062 (send half) + T062a — `POST /api/admin/broadcasts/[id]/version/send`
 * (contracts/admin-eblast-formatting-api.md § send; FR-003, FR-004).
 *
 *   `broadcasts.write` (marketing / admin / super_admin; a manager and a member
 *   session are refused by the gate) → 200
 *   { status, whoseTurn, round, expiresAt }
 *
 * Order of checks is the contract: gate → id (a malformed id is a 404 before
 * any read) → the 30 / 60 s per-(tenant, actor) staff write bucket, an
 * ATOMIC check consumed BEFORE the body is read → the optional body
 * `{ expectedUpdatedAt? }` → `sendVersionToMember` inside the
 * `broadcasts.version.send` span. The body carries ONLY the save's
 * concurrency token (FR-033, round-4 B1): with it, a working copy another
 * marketing user saved since this screen loaded is refused `version_changed`
 * and nothing is sent. Every other key is ignored — an audience key
 * (`segmentType`, …) has nowhere to go (FR-005). A body that is not JSON, or a
 * token that is not an ISO date-time, is 400 `invalid_body`.
 *
 * The state change is ONE `runInTenant` inside the use case, with
 * throw-to-rollback. No `Idempotency-Key` (research R19): once sent, the row
 * is no longer `in_design` and a replay is a 409 `stage_changed`. Nothing
 * here reads `FEATURE_EBLAST_MEMBER_APPROVAL` — a row already in `in_design`
 * stays completable with the flag off (FR-034); the F7 master kill-switch
 * and read-only mode are enforced upstream in `src/proxy.ts`.
 *
 * Fault arms are named `M119.admin.version_send.<arm>`; deterministic
 * refusals are the use case's to audit or count. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { assertNever } from '@/lib/assert-never';
import { makeSendVersionToMemberDeps } from '@/lib/broadcast-approval-deps';
import { inApprovalSpan } from '@/lib/broadcasts-approval-span';
import { baseHeaders, designBlockErrorResponse, errorResponse, versionChangedResponse } from '@/lib/broadcasts-route-helpers';
import { consumeStaffWriteBucket } from '@/lib/broadcasts-staff-write-bucket';
import { logger } from '@/lib/logger';
import { F119_BROADCASTS_SPANS } from '@/lib/otel-tracer';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  parseBroadcastId,
  sendVersionToMember,
  stageOf,
  type SendVersionToMemberError,
} from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;
  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);
  const tenantCtx = resolveTenantFromRequest(request);

  const limited = await consumeStaffWriteBucket(tenantCtx.slug, ctx.current.user.id, correlationId);
  if (limited !== null) return limited;

  const body = await readSendBody(request);
  if (!body.ok) {
    return errorResponse(400, 'invalid_body', correlationId, body.fieldErrors === null ? undefined : { fieldErrors: body.fieldErrors });
  }
  const expected = body.expectedUpdatedAt;

  const result = await inApprovalSpan(
    F119_BROADCASTS_SPANS.versionSend,
    { tenantSlug: tenantCtx.slug, broadcastId: parsedId.value as string },
    () =>
      sendVersionToMember(makeSendVersionToMemberDeps(tenantCtx.slug), {
        broadcastId: parsedId.value,
        actorUserId: ctx.current.user.id,
        actorRole: ctx.current.user.role ?? null,
        requestId: ctx.requestId ?? correlationId,
        ...(expected !== undefined && { expectedUpdatedAt: new Date(expected) }),
      }),
    (sent) => ({ stage: stageOf(sent.status), round: sent.round }),
  );
  if (!result.ok) return sendErrorResponse(result.error, correlationId);

  return NextResponse.json(
    {
      status: result.value.status,
      whoseTurn: result.value.whoseTurn,
      round: result.value.round,
      expiresAt: result.value.expiresAt.toISOString(),
    },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

/**
 * The send body — the save's concurrency token and nothing else. Non-strict:
 * unknown keys (an audience key included) are stripped, never an error.
 */
const SendSchema = z.object({ expectedUpdatedAt: z.string().datetime({ offset: true }).optional() });

type SendBody =
  | { readonly ok: true; readonly expectedUpdatedAt: string | undefined }
  /** `fieldErrors` null = the body is not JSON at all. */
  | { readonly ok: false; readonly fieldErrors: Record<string, string[]> | null };

/** An absent or empty body is "no token"; anything present must parse. */
async function readSendBody(request: NextRequest): Promise<SendBody> {
  const text = await request.text();
  if (text.trim() === '') return { ok: true, expectedUpdatedAt: undefined };
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, fieldErrors: null };
  }
  const parsed = SendSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]> };
  return { ok: true, expectedUpdatedAt: parsed.data.expectedUpdatedAt };
}

function sendErrorResponse(error: SendVersionToMemberError, correlationId: string): NextResponse {
  switch (error.kind) {
    case 'not_found':
      return errorResponse(404, 'broadcast_not_found', correlationId);
    case 'stage_changed':
      return errorResponse(409, 'stage_changed', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'no_working_copy':
      return errorResponse(409, 'no_working_copy', correlationId);
    case 'version_changed':
      return versionChangedResponse(error.current, correlationId);
    case 'no_portal_user':
      return errorResponse(409, 'no_portal_user', correlationId);
    case 'subject_invalid':
      return errorResponse(422, 'validation_error', correlationId, { fieldErrors: { subject: [error.reason] } });
    case 'body_too_large':
      return errorResponse(422, 'validation_error', correlationId, { fieldErrors: { bodyHtml: ['too_large'] } });
    case 'unsafe_content':
      return errorResponse(422, 'unsafe_content', correlationId);
    case 'content_rules':
      return designBlockErrorResponse(error.violations, correlationId);
    case 'image_source_not_allowlisted':
      return errorResponse(422, 'image_source_not_allowlisted', correlationId, {
        details: { images: error.images },
      });
    case 'server_error':
      logger.error(
        { err: error.errKind, correlationId, errorId: 'M119.admin.version_send.server_error' },
        'broadcasts.version_send.failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    default:
      return assertNever(error);
  }
}
