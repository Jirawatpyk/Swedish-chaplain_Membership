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
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runArchiveEvent } from '@/lib/events-admin-deps';
import { asUserId } from '@/modules/auth';
import { emitEventsRoleViolation } from '../../_lib/role-violation-audit';

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

  const session = await getCurrentSession();
  if (!session) return new NextResponse(null, { status: 404 });
  const role = session.user.role;
  if (role !== 'admin') {
    if (role === 'manager' || role === 'member') {
      await emitEventsRoleViolation(request, {
        actorUserId: session.user.id,
        actorRole: role,
        attemptedRoute: `/api/admin/events/${eventId}/archive`,
        attemptedAction: 'archive_event',
        eventId,
      });
    }
    return new NextResponse(null, { status: 404 });
  }

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
      eventId: eventId as never,
      actorUserId: asUserId(session.user.id),
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
            cause: 'cause' in result.error ? result.error.cause : undefined,
            message: 'message' in result.error ? result.error.message : undefined,
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
