/**
 * T077 — GET `/api/broadcasts/[id]`.
 *
 * Member views their own broadcast detail. Cross-member probe → 404
 * (FR-037; matches `enforce-tenant-context` pattern).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import {
  parseBroadcastId,
  enforceTenantContext,
  makeGetBroadcastDeps,
  makeEnforceTenantContextDeps,
} from '@/modules/broadcasts';
import {
  errorResponse,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  const { id } = await context.params;
  const parsed = parseBroadcastId(id);
  if (!parsed.ok) {
    return errorResponse(404, 'broadcast_not_found', correlationId);
  }
  const broadcastId = parsed.value;

  const deps = makeGetBroadcastDeps(ctx.tenant.slug);
  try {
    const broadcast = await deps.broadcastsRepo.findById(
      ctx.tenant.slug,
      broadcastId,
    );
    if (broadcast === null) {
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }

    // Tenant + ownership check
    const tenantCheck = await enforceTenantContext(
      makeEnforceTenantContextDeps(ctx.tenant.slug),
      {
        observedTenantId: broadcast.tenantId,
        broadcastId: broadcastId as string,
        actorUserId: ctx.current.user.id,
        memberId: ctx.member.memberId,
        requestId: ctx.requestId,
      },
    );
    if (!tenantCheck.ok) {
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }

    if (broadcast.requestedByMemberId !== ctx.member.memberId) {
      logger.warn(
        {
          correlationId,
          tenantId: ctx.tenant.slug,
          callerMemberId: ctx.member.memberId,
          broadcastOwnerMemberId: broadcast.requestedByMemberId,
          broadcastId: broadcastId as string,
        },
        'broadcasts.get.cross_member_probe',
      );
      return errorResponse(404, 'broadcast_not_found', correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: broadcast.broadcastId,
        status: broadcast.status,
        subject: broadcast.subject,
        bodyHtml: broadcast.bodyHtml,
        bodySource: broadcast.bodySource,
        segmentType: broadcast.segmentType,
        segmentParams: broadcast.segmentParams,
        // PII-minimisation (W0-15): return only the count, never the raw recipient
        // email list, on this read-back endpoint. The list is owner-gated above, but
        // echoing the full PII batch is needless — a future IDOR/session-compromise
        // would leak it. Compose-form keeps its own client-side copy while editing.
        customRecipientCount: broadcast.customRecipientEmails?.length ?? null,
        estimatedRecipientCount: broadcast.estimatedRecipientCount,
        scheduledFor: broadcast.scheduledFor?.toISOString() ?? null,
        submittedAt: broadcast.submittedAt?.toISOString() ?? null,
        approvedAt: broadcast.approvedAt?.toISOString() ?? null,
        rejectedAt: broadcast.rejectedAt?.toISOString() ?? null,
        rejectionReason: broadcast.rejectionReason,
        cancelledAt: broadcast.cancelledAt?.toISOString() ?? null,
        cancellationReason: broadcast.cancellationReason,
        sentAt: broadcast.sentAt?.toISOString() ?? null,
        deliverySummary: null, // populated post-US4 webhook
        createdAt: broadcast.createdAt.toISOString(),
        updatedAt: broadcast.updatedAt.toISOString(),
      },
      {
        status: 200,
        headers: baseHeaders(correlationId),
      },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: ctx.tenant.slug,
        memberId: ctx.member.memberId,
        broadcastId: id,
      },
      'broadcasts.get.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}
