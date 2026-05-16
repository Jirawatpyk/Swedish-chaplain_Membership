/**
 * POST `/api/admin/events/[eventId]/registrations/[registrationId]/erase`
 *
 * Phase 10 T111 — admin PII erasure (FR-032a / GDPR Article 17 / PDPA
 * Section 30). Atomically:
 *   - Loads + validates registration belongs to path's eventId
 *   - Emits `pii_erasure_requested` (severity: error)
 *   - Acquires per-(tenant, member, event) advisory lock + emits
 *     N × `quota_credit_back_archive` audits if was counted
 *   - Hard-deletes the registration row
 *   - Emits `pii_erasure_completed` (with quotaReversals counts)
 *
 * Idempotent — re-invocation on already-erased rows returns 200 with
 * `alreadyErased: true` (instead of 404 / generic error). Discrimination
 * between "previously erased" vs "never existed" uses the audit log as
 * idempotency receipt (`pii_erasure_completed` row presence).
 *
 * See `eraseAttendeePii` use-case for full algorithm.
 *
 * Authz: **admin only** (FR-035 — manager + member → 403/404 via
 * `adminOnlyWriterGuard` with `role_violation_blocked` audit).
 *
 * Body: `{ reasonText: string }` — admin-supplied erasure justification
 * (persisted to `pii_erasure_requested` payload for DPO traceability).
 * Max 500 chars. zod-validated.
 *
 * Responses:
 *   200 OK    { alreadyErased, quotaReversals: {partnership, cultural} }
 *   400 BAD   malformed body / reasonText missing
 *   404 NOT   F6 flag off / registration missing / member role / caller not staff
 *   409 CON   event_path_mismatch (registration belongs to a different event)
 *   500 ISE   DB / audit failure (rollback applied)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runEraseAttendeePii } from '@/lib/events-admin-deps';
import { asEventId, asRegistrationId } from '@/modules/events';
import { adminOnlyWriterGuard } from '../../../../_lib/role-violation-audit';

export const runtime = 'nodejs';
export const maxDuration = 30;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  reasonText: z
    .string()
    .min(1, 'reasonText is required')
    .max(500, 'reasonText must be 500 characters or fewer'),
});

export async function POST(
  request: NextRequest,
  ctx: {
    params: Promise<{ eventId: string; registrationId: string }>;
  },
) {
  if (!env.features.f6EventCreate) {
    return new NextResponse(null, { status: 404 });
  }

  const { eventId, registrationId } = await ctx.params;
  if (
    !eventId ||
    eventId.length > 200 ||
    !registrationId ||
    registrationId.length > 200
  ) {
    return new NextResponse(null, { status: 404 });
  }
  if (!UUID_V4.test(eventId) || !UUID_V4.test(registrationId)) {
    return new NextResponse(null, { status: 404 });
  }

  // FR-035 admin-only writer guard
  const guard = await adminOnlyWriterGuard(request, {
    attemptedRoute: `/api/admin/events/${eventId}/registrations/${registrationId}/erase`,
    attemptedAction: 'erase_attendee_pii',
    eventId,
  });
  if (guard.kind === 'deny') return guard.response;
  const actorUserId = guard.actorUserId;

  // Parse + validate body
  let parsed: z.infer<typeof BodySchema>;
  try {
    const raw = await request.json();
    const parseResult = BodySchema.safeParse(raw);
    if (!parseResult.success) {
      return NextResponse.json(
        {
          title: 'Bad Request',
          detail: parseResult.error.issues[0]?.message ?? 'invalid body',
        },
        { status: 400 },
      );
    }
    parsed = parseResult.data;
  } catch {
    return NextResponse.json(
      { title: 'Bad Request', detail: 'malformed JSON body' },
      { status: 400 },
    );
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_pii_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
        registrationId,
      },
      '[F6] resolveTenantFromRequest threw on erase',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  let result: Awaited<ReturnType<typeof runEraseAttendeePii>>;
  try {
    result = await runEraseAttendeePii(tenantCtx.slug, {
      eventId: asEventId(eventId),
      registrationId: asRegistrationId(registrationId),
      actorUserId,
      reasonText: parsed.reasonText,
      occurredAt: new Date(),
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_erase_pii_throw',
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
        registrationId,
      },
      '[F6] /api/admin/events/[eventId]/registrations/[registrationId]/erase threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error' },
      { status: 500 },
    );
  }

  if (!result.ok) {
    switch (result.error.kind) {
      case 'registration_not_found':
        return new NextResponse(null, { status: 404 });
      case 'event_path_mismatch':
        return NextResponse.json(
          {
            title: 'Event path mismatch',
            detail:
              'The registrationId does not belong to the eventId in the URL path.',
          },
          { status: 409 },
        );
      default:
        logger.error(
          {
            event: 'admin_erase_pii_use_case_error',
            eventId,
            registrationId,
            errKind: result.error.kind,
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
          '[F6] eraseAttendeePii returned use-case error',
        );
        return NextResponse.json(
          { title: 'Internal Server Error' },
          { status: 500 },
        );
    }
  }

  return NextResponse.json(
    {
      alreadyErased: result.value.alreadyErased,
      quotaReversals: result.value.quotaReversals,
    },
    { status: 200 },
  );
}
