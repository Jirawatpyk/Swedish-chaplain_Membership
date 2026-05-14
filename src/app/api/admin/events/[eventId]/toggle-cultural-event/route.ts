/**
 * POST `/api/admin/events/[eventId]/toggle-cultural-event`
 *
 * Phase 6 T088 — sibling of `toggle-partner-benefit/route.ts`. Flips
 * `is_cultural_event` instead of `is_partner_benefit`. Shares
 * `runToggleEventCategory` deps; differs only in the `flag` arg.
 *
 * Authz: admin-only (FR-035). See sibling for full doc.
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runToggleEventCategory } from '@/lib/events-admin-deps';
import { asUserId } from '@/modules/auth';
import { emitEventsRoleViolation } from '../../_lib/role-violation-audit';

/**
 * Phase 6 staff-review-4 PERF-R6-01 — pin Node runtime + raise function
 * timeout for toggle re-evaluation. Same rationale as the partner-benefit
 * toggle route. `maxDuration = 60` ensures the O(N) per-row work
 * completes or returns a structured Result.err instead of a Vercel
 * default-timeout 504 page.
 */
export const runtime = 'nodejs';
export const maxDuration = 60;

const BodySchema = z.object({
  newValue: z.boolean(),
});

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
        attemptedRoute: `/api/admin/events/${eventId}/toggle-cultural-event`,
        attemptedAction: 'toggle_cultural_event',
        eventId,
      });
    }
    return new NextResponse(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { title: 'Invalid JSON body' },
      { status: 400 },
    );
  }
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { title: 'Invalid body', detail: parsed.error.issues },
      { status: 400 },
    );
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_toggle_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
      },
      '[F6] resolveTenantFromRequest threw on toggle-cultural-event',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  let result: Awaited<ReturnType<typeof runToggleEventCategory>>;
  try {
    result = await runToggleEventCategory(tenantCtx.slug, {
      eventId: eventId as never,
      flag: 'is_cultural_event',
      newValue: parsed.data.newValue,
      actorUserId: asUserId(session.user.id),
      occurredAt: new Date(),
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_toggle_cultural_event_throw',
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
      '[F6] /api/admin/events/[eventId]/toggle-cultural-event threw',
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
      case 'event_archived':
        return NextResponse.json(
          {
            title: 'Event archived',
            detail: 'Cannot toggle category flags on an archived event.',
          },
          { status: 409 },
        );
      default:
        // HIGH-R2-2 fix (wave-6) — see toggle-partner-benefit sibling.
        logger.error(
          {
            event: 'admin_event_toggle_cultural_event_use_case_error',
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
          '[F6] toggleEventCategory returned use-case error',
        );
        return NextResponse.json(
          { title: 'Internal Server Error' },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    {
      registrationsReevaluated: result.value.registrationsReevaluated,
      previousValue: result.value.previousValue,
      nextValue: result.value.nextValue,
    },
    { status: 200 },
  );
}
