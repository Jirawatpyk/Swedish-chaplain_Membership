/**
 * F119 T062 (version half) + T062a + T152 — `POST | PATCH | GET
 * /api/admin/broadcasts/[id]/version` (contracts/admin-eblast-formatting-api.md).
 *
 *   POST   start a formatted version     `broadcasts.write`   → 201
 *   PATCH  save the working copy         `broadcasts.write`   → 200
 *   GET    the version thread            `broadcasts.read`    → 200 (manager too)
 *
 * Order of checks: gate → id (a malformed id is a 404 before any read) → the
 * 30 / 60 s per-(tenant, actor) staff write bucket, an ATOMIC check consumed
 * BEFORE the body is read (429 `broadcast_rate_limit_exceeded` +
 * `Retry-After`; T166 S-INFO — the PATCH body is up to 2 MB, and parsing it
 * first let an over-limit caller make the route do that work for free) →
 * [PATCH: body shape] → the use case. GET is a read: no bucket.
 *
 * Each state change is ONE `runInTenant` inside the use case, with
 * throw-to-rollback (a `return err()` inside the callback would COMMIT). No
 * `Idempotency-Key` (research R19): the stage and the version id are the key,
 * and POST on a row already in `in_design` returns the existing working copy.
 *
 * **T152 — the flag gate is NOT here.** The route only maps the use case's
 * refusal: `startFormattedVersion` reads `FEATURE_EBLAST_MEMBER_APPROVAL`
 * (handed in by the composition root) against the status it RE-READS under
 * the row lock, and refuses the `submitted` arm alone (research R18). A route
 * that pre-checked the flag would dead-end the `changes_requested` re-entry
 * that FR-034 keeps available (`/speckit.analyze` round 3 H1). The F7 master
 * kill-switch (`matchesF7KillSwitchPath`, `/api/admin/broadcasts` prefix)
 * and read-only mode are enforced upstream in `src/proxy.ts`.
 *
 * Fault arms are named `M119.admin.version.<verb>.<arm>`; deterministic
 * refusals are the use case's to audit or count, not faults to log. Node
 * runtime (Drizzle + Upstash).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { assertNever } from '@/lib/assert-never';
import {
  makeListBroadcastVersionsDeps,
  makeSaveFormattedVersionDeps,
  makeStartFormattedVersionDeps,
} from '@/lib/broadcast-approval-deps';
import { baseHeaders, designBlockErrorResponse, errorResponse, versionChangedResponse } from '@/lib/broadcasts-route-helpers';
import { consumeStaffWriteBucket } from '@/lib/broadcasts-staff-write-bucket';
import { logger } from '@/lib/logger';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  listBroadcastVersions,
  parseBroadcastId,
  saveFormattedVersion,
  stageOf,
  startFormattedVersion,
  type BroadcastVersion,
  type BroadcastVersionThread,
  type SaveFormattedVersionError,
  type StartFormattedVersionError,
  type VersionThreadEntry,
} from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The save body. Audience keys (`segmentType`, …) are not fields here and are
 * stripped (FR-005 — the audience is the member's; the DB trigger refuses a
 * post-draft audience write as well). The string bounds are loose on purpose
 * except `noteToMember`: the subject and body limits are the use case's
 * (so the 422 names the real rule), while the note's 1,000 is FR-006's and
 * lives here so an over-long note is a 422, never the column CHECK's 500.
 */
const PatchSchema = z.object({
  subject: z.string().max(2_000),
  bodyHtml: z.string().max(1_048_576),
  bodySource: z.string().max(2_097_152),
  noteToMember: z.string().max(1_000).nullable(),
  expectedUpdatedAt: z.string().datetime({ offset: true }),
});

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

  const result = await startFormattedVersion(makeStartFormattedVersionDeps(tenantCtx.slug), {
    broadcastId: parsedId.value,
    actorUserId: ctx.current.user.id,
    actorRole: ctx.current.user.role ?? null,
    requestId: ctx.requestId ?? correlationId,
  });
  if (!result.ok) return startErrorResponse(result.error, correlationId);

  const { version, memberOriginal } = result.value;
  return NextResponse.json(
    {
      stage: result.value.stage,
      version: {
        id: version.id,
        versionNo: version.versionNo,
        subject: version.subject,
        bodyHtml: version.bodyHtml,
        bodySource: version.bodySource,
        noteToMember: version.noteToMember,
        updatedAt: version.updatedAt.toISOString(),
      },
      memberOriginal: {
        id: memberOriginal.id,
        versionNo: memberOriginal.versionNo,
        subject: memberOriginal.subject,
        bodyHtml: memberOriginal.bodyHtml,
      },
    },
    { status: 201, headers: baseHeaders(correlationId) },
  );
}

export async function PATCH(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;
  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);
  const tenantCtx = resolveTenantFromRequest(request);

  // T166 S-INFO — the bucket is consumed BEFORE the (up to 2 MB) body is
  // read and parsed, as cancel / reject do: an over-limit caller must not be
  // able to make this route parse 2 MB per request for free. A malformed body
  // therefore spends one of the 30.
  const limited = await consumeStaffWriteBucket(tenantCtx.slug, ctx.current.user.id, correlationId);
  if (limited !== null) return limited;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = PatchSchema.safeParse(raw);
  if (!parsed.success) {
    const fieldErrors = parsed.error.flatten().fieldErrors as Record<string, string[]>;
    // A value outside its bound is a rule (422); a wrong shape is a bad request (400).
    const onlyBounds = parsed.error.issues.every((issue) => issue.code === 'too_big');
    return onlyBounds
      ? errorResponse(422, 'validation_error', correlationId, { fieldErrors })
      : errorResponse(400, 'invalid_body', correlationId, { fieldErrors });
  }

  const result = await saveFormattedVersion(makeSaveFormattedVersionDeps(tenantCtx.slug), {
    broadcastId: parsedId.value,
    actorUserId: ctx.current.user.id,
    requestId: ctx.requestId ?? correlationId,
    subject: parsed.data.subject,
    bodyHtml: parsed.data.bodyHtml,
    bodySource: parsed.data.bodySource,
    noteToMember: parsed.data.noteToMember,
    expectedUpdatedAt: new Date(parsed.data.expectedUpdatedAt),
  });
  if (!result.ok) return saveErrorResponse(result.error, correlationId);

  const { version } = result.value;
  return NextResponse.json(
    {
      version: { id: version.id, versionNo: version.versionNo, updatedAt: version.updatedAt.toISOString() },
      unsafeImageSources: [],
    },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.read');
  if ('response' in ctx) return ctx.response;
  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);
  const tenantCtx = resolveTenantFromRequest(request);

  const result = await listBroadcastVersions(makeListBroadcastVersionsDeps(tenantCtx.slug), {
    broadcastId: parsedId.value,
    actorUserId: ctx.current.user.id,
    requestId: ctx.requestId ?? correlationId,
  });
  if (!result.ok) {
    switch (result.error.kind) {
      case 'not_found':
        return errorResponse(404, 'broadcast_not_found', correlationId);
      case 'server_error':
        return serverError(result.error.errKind, 'M119.admin.version.get.server_error', correlationId);
      default:
        return assertNever(result.error);
    }
  }
  return NextResponse.json(threadBody(result.value), { status: 200, headers: baseHeaders(correlationId) });
}

// ---------------------------------------------------------------------------

function serverError(kind: string, errorId: string, correlationId: string): NextResponse {
  logger.error({ err: kind, correlationId, errorId }, 'broadcasts.version.failed');
  return errorResponse(500, 'internal_error', correlationId);
}

function startErrorResponse(error: StartFormattedVersionError, correlationId: string): NextResponse {
  switch (error.kind) {
    case 'not_found':
      // `flag_off` is deliberately indistinguishable from an unknown id (404).
      return errorResponse(404, 'broadcast_not_found', correlationId);
    case 'stage_changed':
      return errorResponse(409, 'stage_changed', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'round_zero':
      return errorResponse(409, 'round_zero', correlationId);
    case 'sending_started':
      return errorResponse(409, 'sending_started', correlationId, {
        details: { stage: stageOf(error.status), status: error.status },
      });
    case 'server_error':
      return serverError(error.errKind, 'M119.admin.version.post.server_error', correlationId);
    default:
      return assertNever(error);
  }
}

function saveErrorResponse(error: SaveFormattedVersionError, correlationId: string): NextResponse {
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
        details: { images: error.unsafeImageSources },
      });
    case 'server_error':
      return serverError(error.errKind, 'M119.admin.version.patch.server_error', correlationId);
    default:
      return assertNever(error);
  }
}

function versionBody(entry: VersionThreadEntry) {
  const v: BroadcastVersion = entry.version;
  return {
    id: v.id,
    versionNo: v.versionNo,
    subject: v.subject,
    bodyHtml: v.bodyHtml,
    bodySource: v.bodySource,
    noteToMember: v.noteToMember,
    authoredByUserId: v.authoredByUserId,
    authoredByName: entry.authoredByName,
    sentToMemberAt: v.sentToMemberAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    updatedAt: v.updatedAt.toISOString(),
  };
}

function threadBody(thread: BroadcastVersionThread) {
  return {
    broadcastId: thread.broadcastId,
    status: thread.status,
    stage: thread.stage,
    round: thread.round,
    approvedVersionId: thread.approvedVersionId,
    memberOriginal: thread.memberOriginal === null ? null : versionBody(thread.memberOriginal),
    sentVersions: thread.sentVersions.map(versionBody),
    workingCopy: thread.workingCopy === null ? null : versionBody(thread.workingCopy),
    decisions: thread.decisions.map((d) => ({
      id: d.id,
      versionId: d.versionId,
      round: d.round,
      decision: d.decision,
      reason: d.reason,
      decidedByUserId: d.decidedByUserId,
      decidedAt: d.decidedAt.toISOString(),
    })),
    approvedAsSubmitted:
      thread.approvedAsSubmitted === null
        ? null
        : {
            at: thread.approvedAsSubmitted.at.toISOString(),
            byUserId: thread.approvedAsSubmitted.byUserId,
            byUserName: thread.approvedAsSubmitted.byUserName,
          },
  };
}
