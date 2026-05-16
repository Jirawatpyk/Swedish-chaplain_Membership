/**
 * POST `/api/admin/events/[eventId]/archive`
 *
 * Phase 6 wave-4 — archives an event (FR-019a). Atomically:
 *   - Sets events.archived_at = NOW()
 *   - Credits back every counted_against_* flag on this event's
 *     matched paid non-pseudonymised registrations
 *   - Emits N × quota_credit_back_archive audits (per previously-
 *     true scope) + the macro event_archived audit
 *
 * See `archiveEvent` use-case for full algorithm.
 *
 * Authz: **admin only** (FR-035 — explicit admin-only action).
 * Manager + member → 404 + `role_violation_blocked` audit.
 *
 * Body: empty (`{}` or omitted; reason text deferred to a future
 * surface).
 *
 * Responses:
 *   200 OK   { registrationsAffected, quotaReversals }
 *   404 NOT  event missing OR caller is not admin OR F6 flag off
 *   409 CON  event already archived
 *   500 ISE  DB / audit failure (rollback applied)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runArchiveEvent } from '@/lib/events-admin-deps';
import { asEventId } from '@/modules/events';
import { adminOnlyWriterGuard } from '../../_lib/role-violation-audit';

/**
 * Phase 6 staff-review-4 PERF-R6-01 — explicitly pin Node runtime + raise
 * function timeout for archive operations.
 *
 * Archive performs O(N) work in the registrations matched to the event
 * (per-row advisory lock + setQuotaEffect UPDATE + queryAllotments
 * SELECT + per-scope audit emit). At the upper-bound N=300 paid+matched
 * registrations, the worst-case wall-clock is ~6s at Neon Singapore
 * RTT — comfortably within `maxDuration = 60` (Vercel Pro plan ceiling).
 *
 * Without this declaration Vercel applies the plan-default timeout
 * (10s on Hobby, 60s on Pro). On Hobby with a 100+ row event the
 * function would silently 504, the tx would roll back, but the client
 * would never receive a structured error — admin sees a generic
 * Vercel timeout page. With `maxDuration = 60` the use-case always
 * gets to complete or return a structured `Result.err` body.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  ctx: { params: Promise<{ eventId: string }> },
) {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  const { eventId } = await ctx.params;
  if (!eventId || eventId.length > 200) {
    return new NextResponse(null, { status: 404 });
  }

  // FR-035 admin-only writer guard: manager → 403 + audit, member → 404
  // + audit. See `adminOnlyWriterGuard`
  // doc-comment for the full behaviour matrix.
  const guard = await adminOnlyWriterGuard(request, {
    attemptedRoute: `/api/admin/events/${eventId}/archive`,
    attemptedAction: 'archive_event',
    eventId,
  });
  if (guard.kind === 'deny') return guard.response;
  const actorUserId = guard.actorUserId;

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_archive_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
      },
      '[F6] resolveTenantFromRequest threw on archive',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  let result: Awaited<ReturnType<typeof runArchiveEvent>>;
  try {
    result = await runArchiveEvent(tenantCtx.slug, {
      // Round-2 types-H1 closure — brand smart constructor (UUID-v4
      // already verified above; `asEventId` is the length-only
      // pre-validated boundary per branded-types.ts trust convention).
      eventId: asEventId(eventId),
      actorUserId,
      occurredAt: new Date(),
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_archive_throw',
        err:
          e instanceof Error
            ? {
                name: e.name,
                message: e.message,
                stack:
                  typeof e.stack === 'string'
                    ? (redactStack(e.stack) ?? null)
                    : null,
              }
            : String(e),
        eventId,
      },
      '[F6] /api/admin/events/[eventId]/archive threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  if (!result.ok) {
    switch (result.error.kind) {
      case 'event_not_found':
        return new NextResponse(null, { status: 404 });
      case 'already_archived':
        return NextResponse.json(
          {
            title: 'Event already archived',
            detail: 'This event was archived in a prior request.',
          },
          { status: 409 },
        );
      default:
        // HIGH-R2-2 fix (wave-6) — surface IMP-5's `cause` discriminator
        // for SRE retry/page classification (see toggle siblings).
        logger.error(
          {
            event: 'admin_event_archive_use_case_error',
            eventId,
            errKind: result.error.kind,
            // pino's `err` key auto-serializes Error → {type, message, stack}.
            // Use `typeof === 'object' && !null` guard before `in` to survive
            // a future primitive-shaped error variant (R3-CRIT-3 + R3-LOW-1).
            err:
              typeof result.error === 'object' &&
              result.error !== null &&
              'cause' in result.error
                ? result.error.cause
                : undefined,
            message:
              typeof result.error === 'object' &&
              result.error !== null &&
              'message' in result.error
                ? result.error.message
                : undefined,
          },
          '[F6] archiveEvent returned use-case error',
        );
        return NextResponse.json(
          { title: 'Internal Server Error' },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    {
      registrationsAffected: result.value.registrationsAffected,
      quotaReversals: result.value.quotaReversals,
    },
    { status: 200 },
  );
}
