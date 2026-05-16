/**
 * Shared `role_violation_blocked` audit emitter for `/api/admin/events/**`
 * route handlers (FR-035 surface-disclosure pattern).
 *
 * Extracts the duplicated 50-line try/catch shell that was previously
 * inlined in both `route.ts` + `[eventId]/route.ts`. The only divergence
 * across consumers is the (attemptedRoute, attemptedAction, summary)
 * triple, so they become explicit parameters.
 *
 * Behavioural contract preserved from the prior inline versions:
 *   1. `resolveTenantFromRequest` is called OUTSIDE the audit-emit try so
 *      a host-header / tenant-validation failure surfaces under the
 *      distinct `tenant_resolve_failed_during_role_violation_audit`
 *      discriminator instead of being mislabelled as
 *      `f6_audit_emit_failed` (E5 round-1 hardening).
 *   2. Audit emit failure NEVER blocks the 404 response (F1 round-1) —
 *      caught + logged at `error` level with `event: 'f6_audit_emit_failed'`.
 *   3. `actorUserId` is properly nullable (L-C round-3) — no sentinel UUID.
 *   4. `actorRole` is typed as the narrowed Role union (`'member' | 'manager'`)
 *      so a future role addition surfaces as a COMPILE error at the call
 *      site, not a silent audit mis-labelling (HIGH-1 round-3).
 */
import { type NextRequest, NextResponse } from 'next/server';
import { logger } from '@/lib/logger';
import { getCurrentSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { makeStandaloneAuditDeps } from '@/modules/events';
import { asTenantId } from '@/modules/members';
import { asUserId, type UserId } from '@/modules/auth';

export interface EmitEventsRoleViolationInput {
  readonly actorUserId: string | null;
  readonly actorRole: 'member' | 'manager';
  /** Route path (without protocol/host) for the audit payload. */
  readonly attemptedRoute: string;
  /** Short action identifier (e.g. `'list_events'`, `'load_event_detail'`). */
  readonly attemptedAction: string;
  /**
   * Optional eventId for the detail-route variant — appended to the
   * human-readable `summary` field and used in the discriminator log
   * if tenant resolution throws. Caller passes `null` on the list route.
   */
  readonly eventId: string | null;
}

export async function emitEventsRoleViolation(
  request: NextRequest,
  input: EmitEventsRoleViolationInput,
): Promise<void> {
  let tenantSlug: string;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    logger.error(
      {
        event: 'tenant_resolve_failed_during_role_violation_audit',
        err: e instanceof Error ? e.message : String(e),
        ...(input.eventId !== null ? { eventId: input.eventId } : {}),
      },
      '[F6] tenant resolution failed during role_violation_blocked emit — 404 still served',
    );
    return;
  }
  // R006 (staff-review fix 2026-05-13): differentiate the detail-route
  // branch by appending the eventId — the previous ternary's two arms
  // were byte-identical, which was the original interface lie that
  // the doc-comment + `eventId` parameter implied this helper would
  // surface in the summary. The detail-route eventId is now guaranteed
  // length-capped (≤200 chars) by the R002 fix in [eventId]/route.ts,
  // so appending cannot bloat the audit row.
  const summary =
    input.eventId !== null
      ? `${input.actorRole} attempted GET ${input.attemptedRoute} (${input.attemptedAction}) for event ${input.eventId}`
      : `${input.actorRole} attempted GET ${input.attemptedRoute} (${input.attemptedAction})`;
  try {
    const deps = makeStandaloneAuditDeps();
    // `emitStandalone` returns Result<AuditEventId, AuditEmitError>.
    // Catching only thrown exceptions would silently drop Result.err
    // paths (db_error / audit_emit / etc.) — during a Neon outage the
    // 404 would surface with no `role_violation_blocked` forensic row
    // and zero log signal. Check the Result and log non-ok branches.
    const result = await deps.emitStandalone({
      eventType: 'role_violation_blocked',
      tenantId: asTenantId(tenantSlug),
      actorType: input.actorRole,
      actorUserId: input.actorUserId ? asUserId(input.actorUserId) : null,
      occurredAt: new Date(),
      summary,
      payload: {
        severity: 'warn',
        actorUserId: input.actorUserId ? asUserId(input.actorUserId) : null,
        actorRole: input.actorRole,
        attemptedRoute: input.attemptedRoute,
        attemptedAction: input.attemptedAction,
        blockedAt: 'app_layer',
      },
    });
    if (!result.ok) {
      logger.error(
        {
          event: 'f6_role_violation_audit_emit_failed',
          err: result.error.kind,
          tenantSlug,
          actorRole: input.actorRole,
          attemptedRoute: input.attemptedRoute,
          ...(input.eventId !== null ? { eventId: input.eventId } : {}),
        },
        '[F6] role_violation_blocked audit emit returned Result.err — 404 response still served; forensic row LOST',
      );
    }
  } catch (e) {
    logger.error(
      {
        // Round-1 err-M4 — include route/role/tenant context so a
        // thrown failure can be correlated; the prior shape lost
        // everything outside the inner Result-branch.
        event: 'f6_audit_emit_failed',
        err: e instanceof Error ? e.message : String(e),
        tenantSlug,
        actorRole: input.actorRole,
        attemptedRoute: input.attemptedRoute,
        ...(input.eventId !== null ? { eventId: input.eventId } : {}),
      },
      '[F6] role_violation_blocked audit emit threw — response still served',
    );
  }
}

/**
 * Common admin-only guard for the F6 `/admin/events/**` **write** routes
 * (relink, archive, partner/cultural toggle, CSV import, manual event
 * create) per **spec.md FR-035** (lines 248-251).
 *
 * Behaviour matrix (spec-canonical, distinct from the
 * `/admin/integrations/eventcreate/**` sibling guard which is 404-for-all):
 *
 *   - `admin`               → `{kind:'allow', actorUserId}` (caller continues)
 *   - `manager`             → 403 Forbidden + RFC 7807 body + audit
 *     emit. Action-level deny: "manager sees the surface, just cannot
 *     perform the mutation" (spec.md:250). The 403 body is intentionally
 *     generic — manager already knows their role, so signalling
 *     "admin-only action" leaks zero new information.
 *   - `member`              → 404 Not Found + audit emit. Surface-
 *     disclosure: members have no read OR write access to events at
 *     all, so the route looks like any other 404 to them.
 *   - unknown role string   → 404 (defensive — never expected, no
 *     audit because the actor cannot be attributed to a real role).
 *   - no session            → 404 (no audit — no actor to attribute).
 *
 * Returns the same `{allow|deny}` discriminator shape as the
 * `/admin/integrations/eventcreate/_lib` `adminOnlyGuard`, but adds
 * (a) a typed 500 deny-path on `getCurrentSession()` throw (Round-1
 * err-M5 closure — the integration sibling lets the throw escape),
 * and (b) returns branded `UserId` not raw `string` (Round-2 types-H2
 * closure). Call sites remain symmetrical for the allow/deny branch
 * handling but the two helpers are NOT signature-identical anymore.
 *
 * Spec rationale (from spec.md:248-251): the F6 admin surface
 * distinguishes between (a) write actions on a manager-readable
 * surface (`/admin/events/**`) where 403 communicates "you see the
 * page but cannot mutate" and (b) entire surfaces hidden from
 * managers (`/admin/integrations/eventcreate/**`) where 404 prevents
 * confirmation that a secret-bearing endpoint exists. Conflating the
 * two with a uniform 404 (the pre-Phase-9 implementation drift this
 * helper closes) gave managers a confusing UX — they could see the
 * events list but every mutation appeared to be a missing endpoint.
 */
export async function adminOnlyWriterGuard(
  request: NextRequest,
  input: {
    readonly attemptedRoute: string;
    readonly attemptedAction: string;
    /**
     * Optional eventId for the per-event variants — appended to the
     * audit summary so forensic queries can correlate by event. Pass
     * `null` for the list-route variant (POST /api/admin/events).
     */
    readonly eventId: string | null;
    /**
     * Round-2 err-M5 / log polish — optional caller-supplied
     * requestId for log/response correlation. When omitted, the
     * guard mints one for any 500 response it generates (e.g.,
     * `getCurrentSession()` throw). Routes that already issue a
     * requestId at the top SHOULD pass it through so a single
     * trace-id correlates the route's pino log lines with the guard's.
     */
    readonly requestId?: string;
  },
): Promise<
  // Round-2 types-H2 closure — return branded `UserId` so call sites
  // get type-safe actor IDs without re-applying `asUserId` at every
  // dispatch point. Single source of truth for the brand boundary.
  | { kind: 'allow'; actorUserId: UserId }
  | { kind: 'deny'; response: Response }
> {
  // Round-2 err-M5 polish — best-effort tenantSlug resolve so the
  // 500 log carries enough context for SRE triage. Wrapped in its
  // own try/catch because `resolveTenantFromRequest` itself can
  // throw (e.g., malformed Host header).
  let tenantSlug: string | null = null;
  try {
    tenantSlug = resolveTenantFromRequest(request).slug;
  } catch (e) {
    // Round-3 errors-M closure — surface best-effort failures at
    // `debug` level so a sustained spike (e.g., misconfigured host
    // allowlist in a new deployment env) is observable as a metric
    // delta on the `f6_admin_writer_guard_tenant_resolve_failed_best_effort`
    // log event. Without this, silent discards would leave SRE with
    // no signal — every 500 would show `tenantSlug: null`
    // indistinguishably from legitimately-unresolvable requests.
    // `debug` keeps noise low in normal operation; turn on at the
    // pino-level filter when investigating.
    logger.debug(
      {
        event: 'f6_admin_writer_guard_tenant_resolve_failed_best_effort',
        err: e instanceof Error ? e.message : String(e),
        attemptedRoute: input.attemptedRoute,
      },
      '[F6] tenantSlug resolve failed in writer-guard (best-effort, continuing without tenant context)',
    );
  }

  // Round-1 err-M5 — wrap session lookup so a DB / Redis blip during
  // session resolution surfaces as a typed 500 + structured log line,
  // not an unhandled rejection that escapes the route handler.
  let session: Awaited<ReturnType<typeof getCurrentSession>>;
  try {
    session = await getCurrentSession();
  } catch (e) {
    const requestId = input.requestId ?? crypto.randomUUID();
    logger.error(
      {
        event: 'f6_admin_writer_guard_session_lookup_failed',
        err: e instanceof Error ? e.message : String(e),
        attemptedRoute: input.attemptedRoute,
        tenantSlug,
        requestId,
      },
      '[F6] admin-writer guard: getCurrentSession threw — serving 500',
    );
    return {
      kind: 'deny',
      response: NextResponse.json(
        { title: 'Internal Server Error', requestId },
        { status: 500 },
      ),
    };
  }
  if (!session) {
    return {
      kind: 'deny',
      response: new NextResponse(null, { status: 404 }),
    };
  }
  const role = session.user.role;
  if (role === 'admin') {
    // Brand at the trust boundary — session.user.id is a plain string
    // post-deserialization; the smart constructor pins the brand for
    // every downstream consumer.
    return { kind: 'allow', actorUserId: asUserId(session.user.id) };
  }
  if (role === 'manager') {
    await emitEventsRoleViolation(request, {
      actorUserId: session.user.id,
      actorRole: 'manager',
      attemptedRoute: input.attemptedRoute,
      attemptedAction: input.attemptedAction,
      eventId: input.eventId,
    });
    return {
      kind: 'deny',
      response: NextResponse.json(
        {
          title: 'Forbidden',
          detail:
            'This action requires admin privileges. Managers have read-only access to /admin/events.',
        },
        { status: 403 },
      ),
    };
  }
  if (role === 'member') {
    await emitEventsRoleViolation(request, {
      actorUserId: session.user.id,
      actorRole: 'member',
      attemptedRoute: input.attemptedRoute,
      attemptedAction: input.attemptedAction,
      eventId: input.eventId,
    });
    return {
      kind: 'deny',
      response: new NextResponse(null, { status: 404 }),
    };
  }
  // Unknown role — return 404 without audit. The audit port's
  // `actorRole` enum only accepts `'member' | 'manager'`, so an
  // unexpected role string would fail enum validation at the emit
  // boundary. Logging at warn level makes the regression observable.
  logger.warn(
    {
      event: 'f6_admin_writer_guard_unknown_role',
      role,
      attemptedRoute: input.attemptedRoute,
    },
    '[F6] admin-writer guard rejected unknown role — 404 served',
  );
  return {
    kind: 'deny',
    response: new NextResponse(null, { status: 404 }),
  };
}
