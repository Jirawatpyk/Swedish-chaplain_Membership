/**
 * F119 T087 — `GET /api/broadcasts/[id]/versions` (contracts/portal-eblast-
 * approval-api.md § versions; FR-008, FR-032, FR-007, FR-013).
 *
 *   `requireMemberContext` (a member session only — a STAFF session is
 *   refused 403) → 200 { broadcast, versions, decisions, approvedAsSubmitted }
 *
 * The history both sides see, from the member's side: the workflow summary,
 * the versions the member was SHOWN (never marketing's unsent working copy),
 * every decision, and `approvedAsSubmitted` on the no-formatting path. The
 * author is `"member"` | `"organisation"` — never a staff user.
 *
 * Order of checks: the session gate → id (a malformed id is a 404 before any
 * read, with no audit row) → `getMemberVersionThread`, which owns the
 * owning-member rule (another member's E-Blast → 404 +
 * `broadcast_cross_member_probe`; unknown / another tenant's → 404 +
 * `broadcast_cross_tenant_probe` — never 403, no existence leak).
 *
 * A read: no rate-limit bucket (the contract names none), read-only mode
 * never applies (GET), nothing reads `FEATURE_EBLAST_MEMBER_APPROVAL` (an
 * in-flight E-Blast stays readable with the flag off — FR-034), and a lapsed
 * member may still read (`LAPSED_EBLAST_SIGNOFF_ROUTES`). The F7 master
 * kill-switch is enforced upstream in `src/proxy.ts`.
 *
 * Fault arms are named `M119.portal.versions.<arm>`. Node runtime.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { assertNever } from '@/lib/assert-never';
import { makeGetMemberVersionThreadDeps } from '@/lib/broadcast-approval-deps';
import { baseHeaders, errorResponse } from '@/lib/broadcasts-route-helpers';
import { logger } from '@/lib/logger';
import { requireMemberContext } from '@/lib/member-context';
import { getMemberVersionThread, parseBroadcastId, type GetMemberVersionThreadError } from '@/modules/broadcasts';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ id: string }> };

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

export async function GET(request: NextRequest, context: RouteContext): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) return ctx.response;

  const { id } = await context.params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) return errorResponse(404, 'broadcast_not_found', correlationId);

  const result = await getMemberVersionThread(makeGetMemberVersionThreadDeps(ctx.tenant.slug), {
    broadcastId: parsedId.value,
    memberId: ctx.memberId as string,
    actorUserId: ctx.current.user.id,
    requestId: ctx.requestId ?? correlationId,
  });
  if (!result.ok) return threadErrorResponse(result.error, correlationId);

  const { broadcastId, summary, versions, decisions, approvedAsSubmitted } = result.value;
  return NextResponse.json(
    {
      broadcast: {
        id: broadcastId,
        stage: summary.stage,
        whoseTurn: summary.whoseTurn,
        round: summary.round,
        proposedSendAt: iso(summary.proposedSendAt),
        confirmedSendAt: iso(summary.confirmedSendAt),
        approvedVersionId: summary.approvedVersionId,
        stageEnteredAt: summary.stageEnteredAt.toISOString(),
        expiresAt: iso(summary.expiresAt),
      },
      versions: versions.map((v) => ({
        id: v.id,
        versionNo: v.versionNo,
        authoredBy: v.authoredBy,
        subject: v.subject,
        bodyHtml: v.bodyHtml,
        noteToMember: v.noteToMember,
        sentToMemberAt: iso(v.sentToMemberAt),
        createdAt: v.createdAt.toISOString(),
      })),
      decisions: decisions.map((d) => ({
        id: d.id,
        versionId: d.versionId,
        round: d.round,
        decision: d.decision,
        reason: d.reason,
        decidedAt: d.decidedAt.toISOString(),
        decidedByMe: d.decidedByMe,
      })),
      approvedAsSubmitted:
        approvedAsSubmitted === null ? null : { at: approvedAsSubmitted.at.toISOString(), by: approvedAsSubmitted.by },
    },
    { status: 200, headers: baseHeaders(correlationId) },
  );
}

function threadErrorResponse(error: GetMemberVersionThreadError, correlationId: string): NextResponse {
  switch (error.kind) {
    case 'not_found':
      return errorResponse(404, 'broadcast_not_found', correlationId);
    case 'server_error':
      logger.error(
        { err: error.errKind, correlationId, errorId: 'M119.portal.versions.server_error' },
        'broadcasts.member_version_thread.failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    default:
      return assertNever(error);
  }
}
