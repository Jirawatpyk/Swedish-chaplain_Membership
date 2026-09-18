/**
 * F119 T145 (US6-AS5, FR-039) — POST + PUT `/api/admin/broadcasts/draft`.
 *
 * The staff compose-on-behalf DRAFT route. It is the mirror of the member's
 * `/api/broadcasts/draft` (T073/T074) — same body, same envelope, same error
 * mapping (`broadcasts-draft-response.ts`) — differing only in how the actor
 * and the member are resolved:
 *
 *   - `requireApiPermission(request, 'broadcasts.write')`. NOT `broadcasts.send`
 *     (which `proxy-submit` names): saving a draft is not sending, and a
 *     `manager` must still be refused. A member session is refused by the gate.
 *   - the member is NAMED in the body and resolved through the same single read
 *     `proxy-submit` uses — unknown in this tenant → 404, erased → 409, never a
 *     leak of which ids exist.
 *   - `actorRole: 'admin_proxy'` and the staff user as `submittedByUserId`, so
 *     the `broadcast_drafted` audit `saveDraft` already emits records who acted
 *     (no new event type, no use-case change).
 *   - the staff 30 / 60 s write bucket, consumed ABOVE the member read and the
 *     save, so a refused call reads nothing and stores nothing.
 *
 * PUT is scoped by `saveDraft` to a `draft` row of the NAMED member (its own
 * ownership + status guards), so a staff user may resume a draft they did not
 * create — staff act for the chamber — while a row past `draft` answers 409
 * exactly as the member route's does. Read-only mode and the F7 master
 * kill-switch are enforced upstream in `src/proxy.ts`, as on every sibling
 * admin broadcast route.
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  broadcastsRateLimiter,
  makeSaveDraftDeps,
  saveDraft,
} from '@/modules/broadcasts';
import { asMemberId, drizzleMemberRepo } from '@/modules/members';
import {
  baseHeaders,
  errorResponse,
  resolveTenantDisplayName,
} from '@/lib/broadcasts-route-helpers';
import {
  draftResponseBody,
  mapSaveDraftError,
} from '@/lib/broadcasts-draft-response';
import {
  STAFF_WRITE_RATE_MAX,
  STAFF_WRITE_RATE_WINDOW_SECONDS,
  staffWriteRateKey,
} from '@/lib/broadcasts-write-rate-limit';
import { requireApiPermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { errKind } from '@/lib/log-id';
import { logger } from '@/lib/logger';

const SegmentTypeEnum = z.enum([
  'all_members',
  'tier',
  'event_attendees_last_90d',
  'custom',
]);

/** The member route's schema plus the member the staff user is acting for. */
const AdminDraftBodySchema = z.object({
  memberId: z.string().uuid(),
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
  scheduledFor: z.string().datetime({ offset: true }).nullish(),
});

async function handle(
  request: NextRequest,
  expectDraftId: boolean,
): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireApiPermission(request, 'broadcasts.write');
  if ('response' in ctx) return ctx.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = AdminDraftBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }
  if (expectDraftId && parsed.data.draftId === undefined) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: { draftId: ['draftId is required for PUT'] },
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);

  const limit = await broadcastsRateLimiter.checkLimit(
    staffWriteRateKey(tenantCtx.slug, ctx.current.user.id),
    STAFF_WRITE_RATE_MAX,
    STAFF_WRITE_RATE_WINDOW_SECONDS,
  );
  if (!limit.ok) {
    return errorResponse(429, 'broadcast_rate_limit_exceeded', correlationId, {
      retryAfterSeconds: limit.error.retryAfterSeconds,
      details: { retryAfterSeconds: limit.error.retryAfterSeconds },
    });
  }

  try {
    // The proxy-submit read, verbatim in intent: `findById` does NOT filter
    // `erased_at`, so a GDPR-Art.17 / PDPA-§33-erased member resolves as found.
    // A staff draft for an erased member would stamp their scrubbed company
    // name on a fresh row the erase cascade already ran past — refuse it here.
    const memberId = asMemberId(parsed.data.memberId);
    const memberRead = await drizzleMemberRepo.findById(tenantCtx, memberId);
    if (!memberRead.ok) {
      if (memberRead.error.code === 'repo.not_found') {
        return errorResponse(404, 'broadcast_member_not_found', correlationId, {
          details: { memberId: parsed.data.memberId },
        });
      }
      logger.error(
        {
          err: memberRead.error.code,
          correlationId,
          tenantId: tenantCtx.slug,
          errorId: 'M119.admin.draft.member_read',
        },
        'admin.broadcasts.draft.member_read_failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    }
    const erasedRead = await drizzleMemberRepo.findErasedAtById(tenantCtx, memberId);
    if (!erasedRead.ok) {
      logger.error(
        {
          err: erasedRead.error.code,
          correlationId,
          tenantId: tenantCtx.slug,
          errorId: 'M119.admin.draft.erasure_read',
        },
        'admin.broadcasts.draft.erasure_read_failed',
      );
      return errorResponse(500, 'internal_error', correlationId);
    }
    if (erasedRead.value.erasedAt != null) {
      return errorResponse(409, 'broadcast_member_erased', correlationId, {
        details: { memberId: parsed.data.memberId },
      });
    }

    const deps = makeSaveDraftDeps(tenantCtx.slug);
    const tenantDisplayName = await resolveTenantDisplayName(tenantCtx.slug);
    const result = await saveDraft(deps, {
      memberId: parsed.data.memberId,
      submittedByUserId: ctx.current.user.id,
      actorRole: 'admin_proxy',
      memberPlanIdSnapshot: memberRead.value.planId,
      tenantDisplayName,
      // DV-17 — Resend From stays "<member> via <tenant>": the e-blast is the
      // member's, whoever typed it.
      memberDisplayName: memberRead.value.companyName,
      ...(parsed.data.draftId !== undefined && { draftId: parsed.data.draftId }),
      subject: parsed.data.subject,
      bodySource: parsed.data.bodySource,
      bodyHtml: parsed.data.bodyHtml,
      segmentType: parsed.data.segmentType,
      segmentParams: parsed.data.segmentParams ?? null,
      customRecipientEmails: parsed.data.customRecipientEmails ?? null,
      scheduledFor:
        parsed.data.scheduledFor != null ? new Date(parsed.data.scheduledFor) : null,
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapSaveDraftError(result.error, correlationId);
    }

    return NextResponse.json(draftResponseBody(result.value.broadcast), {
      status: result.value.created ? 201 : 200,
      headers: baseHeaders(correlationId),
    });
  } catch (e) {
    logger.error(
      {
        err: errKind(e),
        correlationId,
        tenantId: tenantCtx.slug,
        errorId: 'M119.admin.draft.unexpected',
      },
      'admin.broadcasts.draft.unexpected_error',
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
