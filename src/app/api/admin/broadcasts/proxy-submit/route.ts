/**
 * T112 — POST `/api/admin/broadcasts/proxy-submit`.
 *
 * Q12 admin-on-behalf-of-member submission. Wraps `proxySubmitBroadcast`
 * use-case which delegates to `submitBroadcast` with admin actor.
 *
 * Authz: admin only (manager 403). Quota check is BYPASSED for
 * `actor_role='admin_proxy'` (Q12 emergency correction).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  proxySubmitBroadcast,
  makeProxySubmitBroadcastDeps,
  type ProxySubmitBroadcastError,
} from '@/modules/broadcasts';
import { drizzleMemberRepo, asMemberId } from '@/modules/members';
import {
  errorResponse,
  httpStatusForBroadcastError,
  resolveTenantDisplayName,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireAdminContext } from '@/lib/admin-context';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';

const SegmentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all_members') }),
  z.object({
    kind: z.literal('tier'),
    tierCodes: z.array(z.string().min(1)).min(1),
  }),
  z.object({ kind: z.literal('event_attendees_last_90d') }),
  z.object({
    kind: z.literal('custom'),
    emails: z.array(z.string()).min(1).max(100),
  }),
]);

const ProxySubmitBodySchema = z.object({
  requestedByMemberId: z.string().uuid(),
  subject: z.string().min(1).max(200),
  bodyHtml: z
    .string()
    .min(1)
    .max(200 * 1024),
  bodySource: z.string().max(200 * 1024),
  segment: SegmentSchema,
  scheduledFor: z.string().datetime({ offset: true }).nullish(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  const correlationId = randomUUID();
  const ctx = await requireAdminContext(request, {
    resource: 'broadcast',
    action: 'write',
  });
  if ('response' in ctx) return ctx.response;

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorResponse(400, 'invalid_body', correlationId);
  }
  const parsed = ProxySubmitBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const tenantCtx = resolveTenantFromRequest(request);
  const deps = makeProxySubmitBroadcastDeps(tenantCtx.slug);
  const tenantDisplayName = await resolveTenantDisplayName(tenantCtx.slug);

  try {
    // DV-17 — resolve the proxied member's display name (F3 `companyName`)
    // to compose the Resend From as "<member> via <tenant>". The admin
    // context does not load a member, so read it here via the F3 barrel.
    // A not-found member yields `''`; the canonical not-found rejection is
    // still produced inside `proxySubmitBroadcast` (its `memberExistsInTenant`
    // probe runs BEFORE from-name composition, so the placeholder is never
    // persisted — `broadcast_member_not_found` behaviour is preserved). Inside
    // the try so any unexpected repo throw maps to the route's 500 handler.
    const memberLookup = await drizzleMemberRepo.findById(
      tenantCtx,
      asMemberId(parsed.data.requestedByMemberId),
    );
    const memberDisplayName = memberLookup.ok
      ? memberLookup.value.companyName
      : '';

    const result = await proxySubmitBroadcast(deps, {
      proxiedMemberId: parsed.data.requestedByMemberId,
      adminUserId: ctx.current.user.id,
      tenantDisplayName,
      memberDisplayName,
      subject: parsed.data.subject,
      bodySource: parsed.data.bodySource,
      bodyHtml: parsed.data.bodyHtml,
      segment: parsed.data.segment,
      scheduledFor:
        parsed.data.scheduledFor != null
          ? new Date(parsed.data.scheduledFor)
          : null,
      requestId: ctx.requestId,
    });

    if (!result.ok) {
      return mapProxySubmitError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcastId,
        status: 'submitted' as const,
        submittedAt: result.value.submittedAt.toISOString(),
        estimatedRecipientCount: result.value.estimatedRecipientCount,
        actorRole: 'admin_proxy' as const,
        reservedQuotaSlot: true as const,
        reviewSlaTargetHours: result.value.reviewSlaTargetHours,
      },
      { status: 200, headers: baseHeaders(correlationId) },
    );
  } catch (e) {
    logger.error(
      {
        err: e instanceof Error ? e.message : String(e),
        correlationId,
        tenantId: tenantCtx.slug,
      },
      'admin.broadcasts.proxy_submit.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapProxySubmitError(
  error: ProxySubmitBroadcastError,
  correlationId: string,
): NextResponse {
  if (error.kind === 'broadcast_member_not_found') {
    return errorResponse(404, 'broadcast_member_not_found', correlationId, {
      details: { memberId: error.memberId },
    });
  }
  if (error.kind === 'submit.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }
  const { status, code } = httpStatusForBroadcastError(error.kind);
  return errorResponse(status, code, correlationId);
}
