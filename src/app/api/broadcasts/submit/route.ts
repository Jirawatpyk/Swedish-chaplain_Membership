/**
 * T076 — POST `/api/broadcasts/submit`.
 *
 * Wraps the Application use-case `submitBroadcast`. The body shape
 * accepts BOTH:
 *   - `{ broadcastId }` — submit an existing draft as-is (contract spec § 1.3)
 *   - `{ subject, bodyHtml, bodySource, segmentType, ... }` — compose-and-submit
 *     in a single round-trip (UI optimisation; no separate draft step)
 *
 * Both modes flow through the same use-case which enforces all 11
 * FR-002 preconditions a–k + audit emission + atomic insert/transition.
 *
 * Tests turning GREEN: T037 (contract) + T045 + T047–T056 (integration + e2e).
 */
import { randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import {
  submitBroadcast,
  makeSubmitBroadcastDeps,
  type SubmitBroadcastError,
  type SubmitBroadcastInput,
} from '@/modules/broadcasts';
import {
  errorResponse,
  httpStatusForBroadcastError,
  resolveTenantDisplayName,
  baseHeaders,
} from '@/lib/broadcasts-route-helpers';
import { requireMemberContext } from '@/lib/member-context';
import { logger } from '@/lib/logger';
import { broadcastsMetrics } from '@/lib/metrics';
import { broadcastsTracer } from '@/lib/otel-tracer';
import { SpanStatusCode } from '@opentelemetry/api';

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

const SubmitBodySchema = z.object({
  draftId: z.string().uuid().optional(),
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
  const parsed = SubmitBodySchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse(400, 'invalid_body', correlationId, {
      fieldErrors: parsed.error.flatten().fieldErrors as Record<
        string,
        string[]
      >,
    });
  }

  const deps = makeSubmitBroadcastDeps(ctx.tenant.slug);
  const tenantDisplayName = await resolveTenantDisplayName(ctx.tenant.slug);
  const input: SubmitBroadcastInput = {
    memberId: ctx.member.memberId,
    submittedByUserId: ctx.current.user.id,
    actorRole: 'member_self_service',
    ...(parsed.data.draftId !== undefined && {
      draftId: parsed.data.draftId,
    }),
    tenantDisplayName,
    subject: parsed.data.subject,
    bodySource: parsed.data.bodySource,
    bodyHtml: parsed.data.bodyHtml,
    segment: parsed.data.segment,
    scheduledFor:
      parsed.data.scheduledFor != null
        ? new Date(parsed.data.scheduledFor)
        : null,
    requestId: ctx.requestId,
  };

  // T174 — root span `member_submit_broadcast` (docs/observability.md
  // § 22). Wraps the use-case so traces show named hops + duration
  // histogram for SLO-F7-002. Drizzle + Resend fetch sub-spans are
  // auto-instrumented by @vercel/otel.
  const startedAtMs = Date.now();
  try {
    const result = await broadcastsTracer().startActiveSpan(
      'member_submit_broadcast',
      {
        attributes: {
          'tenant.id': ctx.tenant.slug,
          'actor.role': 'member_self_service',
          'segment.type': parsed.data.segment.kind,
        },
      },
      async (span) => {
        try {
          const r = await submitBroadcast(deps, input);
          span.setAttribute(
            'broadcasts.outcome',
            r.ok ? 'submitted' : `err:${r.error.kind}`,
          );
          if (r.ok) {
            span.setAttribute('broadcast.id', r.value.broadcastId);
          }
          return r;
        } catch (e) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: e instanceof Error ? e.message : 'submit_threw',
          });
          throw e;
        } finally {
          span.end();
        }
      },
    );
    broadcastsMetrics.submitDurationMs(
      ctx.tenant.slug,
      'member_self_service',
      Date.now() - startedAtMs,
    );
    if (!result.ok) {
      return mapSubmitError(result.error, correlationId);
    }

    return NextResponse.json(
      {
        broadcastId: result.value.broadcastId,
        status: 'submitted' as const,
        submittedAt: result.value.submittedAt.toISOString(),
        estimatedRecipientCount: result.value.estimatedRecipientCount,
        reservedQuotaSlot: true as const,
        reviewSlaTargetHours: result.value.reviewSlaTargetHours,
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
      },
      'broadcasts.submit.unexpected_error',
    );
    return errorResponse(500, 'internal_error', correlationId);
  }
}

function mapSubmitError(
  error: SubmitBroadcastError,
  correlationId: string,
): NextResponse {
  // submit.server_error → 500 generic
  if (error.kind === 'submit.server_error') {
    return errorResponse(500, 'internal_error', correlationId);
  }

  const { status, code } = httpStatusForBroadcastError(error.kind);
  const details: Record<string, unknown> = {};
  let retryAfterSeconds: number | undefined;

  switch (error.kind) {
    case 'broadcast_member_halted_pending_review':
      details['memberId'] = error.memberId;
      break;
    case 'broadcast_rate_limit_exceeded':
      retryAfterSeconds = error.retryAfterSeconds;
      details['retryAfterSeconds'] = error.retryAfterSeconds;
      break;
    case 'broadcast_not_in_plan':
      details['memberId'] = error.memberId;
      break;
    case 'broadcast_quota_blocked':
      details['used'] = error.used;
      details['reserved'] = error.reserved;
      details['cap'] = error.cap;
      break;
    case 'broadcast_member_missing_primary_contact_email':
      details['memberId'] = error.memberId;
      details['profileEditDeepLink'] = '/portal/profile';
      break;
    case 'broadcast_subject_too_long':
      details['submittedLength'] = error.length;
      break;
    case 'broadcast_body_too_large':
      details['submittedSize'] = error.bytes;
      break;
    case 'broadcast_body_unsafe_html':
      details['reason'] = error.reason;
      break;
    case 'broadcast_custom_recipient_unknown':
      details['unresolvedEntries'] = error.unresolved;
      break;
    case 'broadcast_custom_recipient_invalid_format':
      details['invalid'] = error.invalid;
      break;
    case 'broadcast_custom_recipient_too_many':
      details['count'] = error.count;
      break;
    case 'broadcast_audience_too_large':
      details['count'] = error.count;
      details['cap'] = error.cap;
      break;
    case 'broadcast_subject_empty':
    case 'broadcast_custom_recipient_empty':
    case 'broadcast_empty_segment_blocked':
      // No additional structured details
      break;
  }

  return errorResponse(status, code, correlationId, {
    ...(retryAfterSeconds !== undefined && { retryAfterSeconds }),
    ...(Object.keys(details).length > 0 && { details }),
  });
}
