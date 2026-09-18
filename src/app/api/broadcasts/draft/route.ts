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
import { saveDraft, makeSaveDraftDeps } from '@/modules/broadcasts';
import {
  errorResponse,
  resolveTenantDisplayName,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import {
  draftResponseBody,
  mapSaveDraftError,
} from '@/lib/broadcasts-draft-response';
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
      // DV-17 — compose Resend From as "<member> via <tenant>".
      memberDisplayName: ctx.member.companyName,
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
      return mapSaveDraftError(result.error, correlationId);
    }

    // F119 T145 — shared with the staff `/api/admin/broadcasts/draft`, which
    // runs the SAME `saveDraft` for a member named in the body. Both forms
    // save through one client helper, so both routes answer in one shape.
    return NextResponse.json(draftResponseBody(result.value.broadcast), {
      status: result.value.created ? 201 : 200,
      headers: baseHeaders(correlationId),
    });
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  return handle(request, false);
}

export async function PUT(request: NextRequest): Promise<NextResponse> {
  return handle(request, true);
}
