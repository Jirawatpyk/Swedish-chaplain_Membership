/**
 * T073 + T074 — POST + PUT `/api/broadcasts/draft`.
 *
 * - `POST` creates a fresh draft (multi-draft per member per Ultraplan AD7).
 * - `PUT` updates an existing draft (rejects 409 if status != 'draft').
 *
 * Both routes wrap the Application use-case `saveDraft`. Tenant + auth
 * resolved via `requireMemberContext`; kill-switch is enforced upstream
 * in `src/proxy.ts`.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  saveDraft,
  makeSaveDraftDeps,
  type SaveDraftError,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  resolveTenantDisplayName,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';

const SegmentTypeEnum = z.enum([
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
]);

const DraftBodySchema = z.object({
  draftId: z.string().uuid().optional(),
  subject: z.string().min(1).max(200),
  bodyHtml: z
    .string()
    .min(1)
    .max(200 * 1024),
  bodySource: z.string().max(200 * 1024),
  segmentType: SegmentTypeEnum,
  segmentParams: z.record(z.string(), z.unknown()).nullish(),
  customRecipientEmails: z.array(z.string().email()).max(100).nullish(),
  scheduledFor: z
    .string()
    .datetime({ offset: true })
    .nullish(),
});

async function handle(
  request: NextRequest,
  expectDraftId: boolean,
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireMemberContext(request);
  if ('response' in ctx && ctx.response) {
    return ctx.response;
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = DraftBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    });
  }
  if (expectDraftId && parsed.data.draftId === undefined) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: { draftId: ['draftId is required for PUT'] },
    });
  }

  const deps = makeSaveDraftDeps(ctx.tenant.slug);
  const tenantDisplayName = await resolveTenantDisplayName(ctx.tenant.slug);
  try {
    const result = await saveDraft(deps, {
      memberId: ctx.member.memberId,
      submittedByUserId: ctx.current.user.id,
      actorRole: 'member_self_service',
      memberPlanIdSnapshot: ctx.member.planId,
      tenantDisplayName,
      ...(parsed.data.draftId !== undefined && {
        draftId: parsed.data.draftId,
      }),
      subject: parsed.data.subject,
      bodySource: parsed.data.bodySource,
      bodyHtml: parsed.data.bodyHtml,
      segmentType: parsed.data.segmentType,
      segmentParams: parsed.data.segmentParams ?? null,
      customRecipientEmails: parsed.data.customRecipientEmails ?? null,
      scheduledFor:
        parsed.data.scheduledFor != null
          ? new Date(parsed.data.scheduledFor)
          : null,
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapDraftError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcast.broadcastId,
        status: result.value.broadcast.status,
        createdAt: result.value.broadcast.createdAt.toISOString(),
        updatedAt: result.value.broadcast.updatedAt.toISOString(),
        subject: result.value.broadcast.subject,
        segmentType: result.value.broadcast.segmentType,
        segmentParams: result.value.broadcast.segmentParams,
        customRecipientEmails: result.value.broadcast.customRecipientEmails,
        scheduledFor:
          result.value.broadcast.scheduledFor?.toISOString() ?? null,
      },
      {
        status: result.value.created ? 201 : 200,
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
      },
      'broadcasts.draft.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapDraftError(
  error: SaveDraftError,
  correlationId: string,
): NextResponse {
  if (
    error.kind === 'sanitizer_unavailable' ||
    error.kind === 'save_draft.server_error'
  ) {
    return errorResponse(500, 'internal_error', correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  if (error.kind === 'broadcast_subject_too_long' && 'length' in error) {
    details['submittedLength'] = error.length;
  } else if (error.kind === 'broadcast_body_too_large' && 'bytes' in error) {
    details['submittedSize'] = error.bytes;
  } else if (error.kind === 'broadcast_body_unsafe_html' && 'reason' in error) {
    details['reason'] = error.reason;
  } else if (
    error.kind === 'broadcast_member_missing_primary_contact_email' &&
    'memberId' in error
  ) {
    details['memberId'] = error.memberId;
  } else if (error.kind === 'broadcast_immutable_after_submit') {
    details['broadcastId'] = error.broadcastId;
    details['currentStatus'] = error.currentStatus;
  } else if (error.kind === 'broadcast_not_found') {
    details['broadcastId'] = error.broadcastId;
  }
  return errorResponse(status, code, correlationId, {
    ...(Object.keys(details).length > 0 && { details }),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request, false);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return handle(request, true);
}
