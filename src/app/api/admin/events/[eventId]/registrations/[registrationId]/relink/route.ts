/**
 * POST `/api/admin/events/[eventId]/registrations/[registrationId]/relink`
 *
 * F6 Phase 9 / US6 / T105 — admin manual relink per FR-014. Atomically:
 *   - Credits back the OLD member's counted_against_* flags (if any)
 *   - Re-evaluates the NEW member's quota effect on this event
 *   - UPDATEs the registration's matched_member_id + match_type
 *   - Emits per-scope quota audit rows + the macro registration_relinked
 *
 * Mirrors the archive + toggle route shape so a future reviewer can
 * pattern-match between the three admin write surfaces. See
 * `relink-registration.ts` use-case for the full algorithm.
 *
 * Authz: **admin only** (FR-035). Manager + member → 404 +
 * `role_violation_blocked` audit (surface-disclosure prevention — the
 * existence of a write endpoint is not leaked to non-admins).
 *
 * Body: `{ newMatchedMemberId: string }` — UUID of the member to relink
 * the registration to.
 *
 * Responses:
 *   200 OK   { noop:true, matchedMemberId } | { noop:false, … }
 *   400 BAD  body malformed (missing/non-UUID newMatchedMemberId)
 *   404 NOT  registration / event / new-member missing OR caller not admin OR F6 flag off
 *   409 CON  event already archived OR row PII pseudonymised (FR-014 round-2 R4)
 *   500 ISE  DB / audit failure (tx rolled back)
 */
import { type NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { redactStack } from '@/lib/redact-stack';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { runRelinkRegistration } from '@/lib/events-admin-deps';
import { asMemberId } from '@/modules/members';
import { asRegistrationId, asEventId } from '@/modules/events';
import { adminOnlyWriterGuard } from '../../../../_lib/role-violation-audit';

// Mirror archive route — Node runtime (advisory locks + audit emits
// require it) + 60s ceiling. Relink is bounded work O(2 members × 2
// scopes) but the 60s ceiling defends against pathological Neon-RTT
// spikes — no measured SLO claim implied. Phase 10 T136-T139 perf
// benches will establish the real p95.
export const runtime = 'nodejs';
export const maxDuration = 60;

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const BodySchema = z.object({
  newMatchedMemberId: z
    .string()
    .min(1)
    .max(200)
    .refine((v) => UUID_V4.test(v), {
      message: 'newMatchedMemberId must be a UUID v4',
    }),
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
  // Length-cap path params to bound audit / log row sizes; UUID-v4
  // regex ensures the path actually identifies a registration row +
  // event row (any non-UUID is a probe attempt). Same defensive
  // posture as the archive route.
  if (
    !eventId ||
    eventId.length > 200 ||
    !UUID_V4.test(eventId) ||
    !registrationId ||
    registrationId.length > 200 ||
    !UUID_V4.test(registrationId)
  ) {
    return new NextResponse(null, { status: 404 });
  }

  // Round-1 review fix (M-1 / requestId correlation) — generate a
  // requestId at the top so every 500 path can correlate logs ↔
  // response body via `requestId`. Mirrors the create-event route's
  // `requestId` block (see `src/app/api/admin/events/route.ts` § POST
  // handler init — section-anchor citation instead of line number per
  // Round-2 comments-M2).
  const requestId = crypto.randomUUID();

  // FR-035 admin-only writer guard: manager → 403 + audit, member → 404
  // + audit, no-session/unknown → 404. See `adminOnlyWriterGuard`
  // doc-comment for the full FR-035 matrix. `requestId` threaded for
  // log/response correlation across guard + route 500 paths
  // (Round-2 err-M5 polish).
  const guard = await adminOnlyWriterGuard(request, {
    attemptedRoute: `/api/admin/events/${eventId}/registrations/${registrationId}/relink`,
    attemptedAction: 'relink_registration',
    eventId,
    requestId,
  });
  if (guard.kind === 'deny') return guard.response;
  const actorUserId = guard.actorUserId;

  // Parse + validate body
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
      {
        title: 'Invalid request body',
        detail: parsed.error.issues,
      },
      { status: 400 },
    );
  }

  let tenantCtx: ReturnType<typeof resolveTenantFromRequest>;
  try {
    tenantCtx = resolveTenantFromRequest(request);
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_relink_tenant_resolve_failed',
        err: e instanceof Error ? e.message : String(e),
        eventId,
        registrationId,
        requestId,
      },
      '[F6] resolveTenantFromRequest threw on relink',
    );
    return NextResponse.json(
      { title: 'Internal Server Error', requestId },
      { status: 500 },
    );
  }

  let result: Awaited<ReturnType<typeof runRelinkRegistration>>;
  try {
    result = await runRelinkRegistration(tenantCtx.slug, {
      // Round-1 type-H1 + Round-2 type-H1 — use brand smart
      // constructors (already-UUID-validated above + by zod on body).
      registrationId: asRegistrationId(registrationId),
      newMatchedMemberId: asMemberId(parsed.data.newMatchedMemberId),
      // Round-2 code-H1 closure — thread the URL-path eventId into
      // the use-case so it can verify it matches the registration's
      // stored event_id BEFORE any mutation. Without this, a
      // misrouted URL would silently relink the registration
      // server-side while the route returned 404 to the admin.
      eventIdFromPath: asEventId(eventId),
      // Round-2 types-H2 — guard now returns branded UserId; no
      // re-wrap needed.
      actorUserId,
      occurredAt: new Date(),
    });
  } catch (e) {
    logger.error(
      {
        event: 'admin_event_relink_throw',
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
        requestId,
      },
      '[F6] /api/admin/events/[eventId]/registrations/[registrationId]/relink threw',
    );
    return NextResponse.json(
      { title: 'Internal Server Error', requestId },
      { status: 500 },
    );
  }

  // Round-2 code-H1 closure — the path-eventId check now lives INSIDE
  // the use-case (`relinkRegistration` step 1b) and returns
  // `event_path_mismatch` BEFORE any mutation. The Round-1 post-commit
  // check that lived here previously was a silent-success bug: the
  // relink had already mutated the DB by the time the route detected
  // the mismatch. The use-case error variant is handled in the switch
  // below; no post-commit guard is needed here.

  if (!result.ok) {
    switch (result.error.kind) {
      case 'registration_not_found':
      case 'event_not_found':
      case 'event_path_mismatch':
        // Round-2 code-H1 — surface-disclosure 404 (same shape as
        // not-found cases; do not leak which discriminator fired).
        // The use-case (pure Application) cannot log directly — this
        // route is the SOLE log source for path-mismatch events.
        // Structured warn log enables SRE triage of misrouted URLs
        // (typically a client-bug indicator) without exposing the
        // discriminator to the admin.
        if (result.error.kind === 'event_path_mismatch') {
          logger.warn(
            {
              event: 'admin_event_relink_eventid_path_mismatch',
              requestId,
              eventIdInPath: result.error.eventIdInPath,
              eventIdOnRegistration: result.error.eventIdOnRegistration,
              registrationId: result.error.registrationId,
            },
            '[F6] relink path-param eventId did not match registration.eventId — refused before mutation',
          );
        }
        return new NextResponse(null, { status: 404 });
      case 'new_member_not_found':
        return NextResponse.json(
          {
            title: 'Target member not found',
            detail:
              'The member you selected no longer exists or has no active plan in this chamber.',
            reason: 'new_member_not_found',
          },
          { status: 404 },
        );
      case 'event_archived':
        return NextResponse.json(
          {
            title: 'Event is archived',
            detail:
              'Archived events are quota-neutral; relink is disabled. Unarchive the event before re-linking.',
            // Round-1 review fix (ux-H3) — discriminator so the client
            // can render a localised toast via the `errorToastConflict`
            // i18n key instead of surfacing the server's EN detail
            // directly. Mirrors the `pseudonymised_row_rejected` pattern.
            reason: 'event_archived',
          },
          { status: 409 },
        );
      case 'pseudonymised_row_rejected':
        // FR-014 round-2 R4 — surface a discrete 409 with the canonical
        // UX-message constant so the client can display the localised
        // "Cannot relink — attendee PII has been retention-purged…"
        // copy without round-tripping a magic string.
        return NextResponse.json(
          {
            title: 'Cannot relink — attendee PII has been retention-purged',
            detail:
              'The original attendee identity is no longer recoverable. Manually re-import the registration via CSV if you have the original data.',
            reason: 'pseudonymised_row_rejected',
          },
          { status: 409 },
        );
      case 'events_repo_error':
      case 'registrations_repo_error':
      case 'lock_acquisition_failed':
      case 'lock_key_invariant_violation':
      case 'quota_lookup_failed':
      case 'audit_emit_failed':
        // Round-1 review fix (type-H2 + err-M1) — explicit exhaustive
        // listing of the remaining variants so a future `kind`
        // addition becomes a compile error (the trailing `never` check
        // below enforces it). Plus depth-bounded log fields — only
        // `cause.kind` + `cause.message` to avoid leaking nested
        // pg/error context (e.g., raw SQL fragments) into pino logs.
        logger.error(
          {
            event: 'admin_event_relink_use_case_error',
            requestId,
            eventId,
            registrationId,
            errKind: result.error.kind,
            errMessage:
              'message' in result.error ? result.error.message : undefined,
            // Round-2 err-M1 + Round-3 — fallback chain:
            //   1. `.kind` (discriminated repo/quota/audit errors)
            //   2. `.name` (InvalidLockKeyError, generic Error)
            //   3. `null` (last resort)
            // Plus surface `.code` for pg-driver errors (SQLSTATE
            // like '57P01' admin-shutdown, '40P01' deadlock_detected)
            // — gives SRE a queryable filter label even when
            // `.kind`/`.name` resolve to generic 'Error'.
            causeKind:
              (result.error as { cause?: { kind?: string; name?: string } })
                .cause?.kind ??
              (result.error as { cause?: { name?: string } }).cause?.name ??
              null,
            causeMessage:
              (result.error as { cause?: { message?: string } }).cause
                ?.message ?? null,
            causeCode:
              (result.error as { cause?: { code?: string } }).cause?.code ??
              null,
          },
          '[F6] relinkRegistration returned use-case error',
        );
        return NextResponse.json(
          { title: 'Internal Server Error', requestId },
          { status: 500 },
        );
      default: {
        // Exhaustiveness check — compile error here on a future error
        // variant added without a matching `case`.
        const _exhaustive: never = result.error;
        logger.error(
          {
            event: 'admin_event_relink_use_case_error_unhandled',
            requestId,
            eventId,
            registrationId,
            errKind: (_exhaustive as { kind?: string }).kind ?? 'unknown',
          },
          '[F6] relinkRegistration returned unrecognised error variant — switch is not exhaustive',
        );
        return NextResponse.json(
          { title: 'Internal Server Error', requestId },
          { status: 500 },
        );
      }
    }
  }

  // 200 OK — noop and full-relink share the same surface but with
  // different payloads. The client uses `noop` to pick the right toast.
  if (result.value.noop) {
    return NextResponse.json(
      {
        noop: true,
        registrationId: result.value.registrationId,
        matchedMemberId: result.value.matchedMemberId,
      },
      { status: 200 },
    );
  }
  return NextResponse.json(
    {
      noop: false,
      registrationId: result.value.registrationId,
      previousMatchedMemberId: result.value.previousMatchedMemberId,
      newMatchedMemberId: result.value.newMatchedMemberId,
      previousMatchType: result.value.previousMatchType,
      newMatchType: result.value.newMatchType,
      quotaImpact: result.value.quotaImpact,
    },
    { status: 200 },
  );
}
