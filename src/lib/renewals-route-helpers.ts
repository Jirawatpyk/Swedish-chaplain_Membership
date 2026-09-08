/**
 * F8 Phase 3 Wave H3 — shared route-handler helpers for `/api/admin/renewals/*`.
 *
 * Extracts the inline `err()` helper + RBAC + kill-switch boilerplate
 * that was duplicated across 4 routes (verify-run G1). Mirrors F7
 * `broadcasts-route-helpers.ts` shape.
 *
 * `requireRenewalAdminContext` extends `requireAdminContext` with an
 * F8-specific audit emit on the role-deny path (verify-run C1):
 * managers attempting POST cancel / mark-paid-offline get the generic
 * denial row AND the F8-contract-mandated `f8_role_violation_blocked`
 * audit (admin-renewals-api.md § 1). Since the 016 sweep the generic row is
 * `permission_denied` (written by `src/lib/rbac.ts`), not the pre-016
 * `manager_denied_write`.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentSession, type CurrentSession } from '@/lib/auth-session';
import { requireApiPermission } from '@/lib/rbac';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import type { PermissionKey } from '@/modules/auth/domain/permissions/permission-catalogue';
import { makeRenewalsDeps } from '@/modules/renewals';

export interface RenewalsErrorOptions {
  readonly status: number;
  readonly code: string;
  readonly correlationId: string;
  readonly details?: Record<string, unknown>;
  /**
   * Extra response headers merged on top of the standard
   * `X-Correlation-Id` + `Cache-Control` pair. Used by 429 responses
   * to set `Retry-After` (Wave I6+I7 T107) without bypassing the
   * envelope helper.
   */
  readonly headers?: Record<string, string>;
}

/** Standard F8 error envelope: `{ error: { code, …details }, correlationId }`. */
export function errorResponse(opts: RenewalsErrorOptions): NextResponse {
  return NextResponse.json(
    { error: { code: opts.code, ...(opts.details ?? {}) }, correlationId: opts.correlationId },
    {
      status: opts.status,
      headers: {
        'X-Correlation-Id': opts.correlationId,
        'Cache-Control': 'no-store, private',
        ...(opts.headers ?? {}),
      },
    },
  );
}

/** Standard 200 response with F8 cache + correlation headers. */
export function successResponse<T>(
  body: T,
  correlationId: string,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      'X-Correlation-Id': correlationId,
      'Cache-Control': 'no-store, private',
    },
  });
}

export interface RenewalAdminContext {
  readonly response?: never;
  readonly current: CurrentSession;
  readonly sourceIp: string;
  readonly requestId: string;
  readonly correlationId: string;
}

export interface RenewalAdminContextRejection {
  readonly response: NextResponse;
}

/**
 * RBAC action label for renewal admin routes.
 *
 * - `'read'` — pure GET. Both admin AND manager pass.
 * - `'write'` — mutating endpoint. Admin only; manager 403 +
 *   `f8_role_violation_blocked` audit.
 * - `'manager_exception'` — Phase 6 review I5: a mutating endpoint
 *   that FR-052a explicitly permits manager on (currently only the
 *   at-risk outreach POST). Internally maps to `'read'` for the
 *   underlying RBAC check (both admin + manager allowed) but
 *   propagates the `'manager_exception'` label into the
 *   `f8_role_violation_blocked` audit so dashboards distinguish a
 *   true read from a manager-permitted write.
 */
export type RenewalAdminAction = 'read' | 'write' | 'manager_exception';

/**
 * The F8 errorId taxonomy — one entry per route that composes
 * `requireRenewalAdminContext`, documented in
 * `docs/runbooks/audit-emit-loss.md`.
 *
 * A closed union rather than `` `F8.${string}` `` on purpose: this list IS the
 * taxonomy, so the runbook can point at it instead of carrying a hand-written
 * copy that rots. Adding a renewals route is a compile error until its name is
 * added here.
 *
 * It does NOT stop two routes sharing a name — a union of literals is happy to
 * see the same member twice, which is precisely how a copy-pasted route would
 * restore the `F8.ACCEPT_TIER.*` defect. `pnpm check:f8-error-id` enforces
 * uniqueness, and that every declared `ERROR_ID` is a member of this union;
 * an earlier version of this docblock claimed the type system did both.
 *
 * The suffixes are not listed here on purpose: five rounds of review found
 * every enumerated list false as soon as a suffix moved, and then found the
 * behavioural replacement ("every failure line a route logs is prefixed with
 * its entry") false too — a failure logged at WARN is not covered by the
 * gate. What `pnpm check:f8-error-id` actually enforces is narrower and
 * checkable: every 500 a route answers with, and every error-level line
 * inside a catch, carries that route's entry. State that, not more.
 */
export type F8ErrorId =
  // cycle-level actions
  | 'F8.CYCLE_LIST'
  | 'F8.CYCLE_DETAIL'
  | 'F8.CYCLE_CANCEL'
  | 'F8.CYCLE_REJECT'
  | 'F8.CYCLE_REACTIVATE'
  | 'F8.CYCLE_MARK_PAID_OFFLINE'
  | 'F8.CYCLE_SEND_REMINDER'
  | 'F8.SETTLEMENT_PREVIEW'
  // at-risk
  | 'F8.AT_RISK_LIST'
  | 'F8.AT_RISK_SNOOZE'
  | 'F8.AT_RISK_OUTREACH'
  // escalation tasks
  | 'F8.TASK_LIST'
  | 'F8.TASK_DONE'
  | 'F8.TASK_SKIP'
  | 'F8.TASK_REASSIGN'
  // tier upgrades
  | 'F8.TIER_UPGRADE_LIST'
  | 'F8.ACCEPT_TIER'
  | 'F8.DISMISS_TIER'
  | 'F8.ESCALATE_TIER'
  // reminder-schedule settings
  | 'F8.SCHEDULES_READ'
  | 'F8.SCHEDULES_WRITE'
  // member-scoped renewal actions (admin/members/**, not admin/renewals/**)
  | 'F8.MEMBER_RENEW'
  | 'F8.MEMBER_BLOCK_AUTO_REACTIVATION'
  | 'F8.MEMBER_UNBLOCK_AUTO_REACTIVATION'
  // member-facing portal routes. These do NOT compose this helper — they run
  // the member's own session, not an admin gate — and emit their own lines
  // directly. The taxonomy covers them because an alert rule keyed on `F8.*`
  // has to match them too.
  //
  // This said they "never emit `.CONTEXT_RESOLUTION_FAILED`" and used their
  // entry "five times". The commit that added `confirm`'s pass-through guard
  // falsified both in one move. Saying what a file does NOT do is as fragile
  // as saying what it does — so this now says neither.
  | 'F8.PORTAL_CONFIRM'
  | 'F8.PORTAL_REDEEM_LINK';

/**
 * F8-aware admin gate. Drop-in replacement for `requireAdminContext`
 * that adds an F8 audit emit on the manager-deny path.
 *
 * 016 T028: composes `requireApiPermission` (the canonical RBAC v2 gate — the
 * `permission_denied` trail + metric + both flag legs live there) and keeps the
 * three F8-contract behaviours layered on top: the F8 error ENVELOPE
 * (`{ error: { code }, correlationId }` + `X-Correlation-Id`, admin-renewals-api.md
 * § 1), the `f8_role_violation_blocked` audit on the 403 path, and the
 * `<errorId>.CONTEXT_RESOLUTION_FAILED` taxonomy log line on the 500 path —
 * `<errorId>` being the CALLER's entry, passed in; it was hardcoded to this
 * one route's name until 2026-09-07. `key` is the surface's
 * permission (single leg since PR 5 removed the shim row this helper used to
 * derive from the action).
 *
 * Caller should always check `'response' in result` and return early
 * on rejection. The 401 path (no session) does NOT emit the F8 audit
 * because anonymous probes have no actor identity to record.
 */
export async function requireRenewalAdminContext(
  request: NextRequest,
  action: RenewalAdminAction,
  key: PermissionKey,
  errorId: F8ErrorId,
): Promise<RenewalAdminContext | RenewalAdminContextRejection> {
  const correlationId = randomUUID();
  const requestId = requestIdFromHeaders(request.headers);
  const sourceIp = getClientIp(request);

  // 'manager_exception' allows both admin + manager (mirrors 'read'
  // at the RBAC layer); the label is preserved for the audit emit
  // path below so dashboards see the actual semantic.
  const gate = await requireApiPermission(
    request,
    key,
  );

  if ('response' in gate) {
    const status = gate.response.status;
    if (status === 403) {
      await emitF8RoleViolationBlocked(
        request,
        action,
        correlationId,
        requestId,
        errorId,
      );
    }
    if (status === 500) {
      // Attach the F8 errorId taxonomy entry so SRE alert rules keyed on
      // `<errorId>.*` catch infrastructure errors that escape BEFORE the
      // route's outer try/catch (which attaches `<errorId>.UNEXPECTED`).
      // The underlying cause is already logged by `requireApiPermission`
      // (`rbac.session-lookup-failed`) with the same requestId.
      //
      // This used to be the hardcoded literal
      // `'F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED'`, which meant all 24
      // callers — including three `admin/members/**` routes that are not
      // renewals at all — reported a failure under the name of the ONE route
      // this helper was originally written for. `errorId` is required so a
      // new caller cannot omit it and silently inherit somebody else's name.
      logger.error(
        {
          errorId: `${errorId}.CONTEXT_RESOLUTION_FAILED`,
          requestId,
          correlationId,
        },
        'renewals-route-helpers.infrastructure-error',
      );
    }
    return {
      response: errorResponse({
        status,
        code:
          status === 401 ? 'no_session' : status === 403 ? 'forbidden' : 'server_error',
        correlationId,
      }),
    };
  }

  return { current: gate.current, sourceIp, requestId, correlationId };
}

/**
 * F8 contract audit (verify-run C1). Fire-and-forget — never blocks the 403
 * response. Emits via the F8 audit emitter (drizzle-renewal-audit-emitter)
 * which writes to audit_log. Re-reads the session for the actor identity;
 * a 403 implies one existed moments ago, and if it vanished in between the
 * `permission_denied` trail from `requireApiPermission` still holds the actor.
 */
async function emitF8RoleViolationBlocked(
  request: NextRequest,
  action: RenewalAdminAction,
  correlationId: string,
  requestId: string,
  // Threaded in so a lost audit row names the route it was lost on. The
  // review that found this said the helper "already receives it" — `tsc`
  // disagreed, which is why the claim was checked instead of taken.
  errorId: F8ErrorId,
): Promise<void> {
  try {
    const current = await getCurrentSession();
    if (!current) return;
    const tenantCtx = resolveTenantFromRequest(request);
    const deps = makeRenewalsDeps(tenantCtx.slug);
    await deps.auditEmitter.emit(
      {
        type: 'f8_role_violation_blocked',
        payload: {
          resource: 'renewal',
          action,
          // 016 T033 — the LITERAL denied role (the port union now carries
          // the RBAC v2 roles; a coerced trail misleads the investigator).
          attempted_role: current.user.role,
          route: new URL(request.url).pathname,
        },
      },
      {
        tenantId: tenantCtx.slug,
        actorUserId: current.user.id,
        actorRole: current.user.role,
        correlationId,
        requestId,
        summary: `Role ${current.user.role} blocked from ${action} on renewal route ${new URL(request.url).pathname}`,
      },
    );
  } catch (auditErr) {
    // Audit failure must NOT block the 403 — log + continue.
    //
    // The id was missing here until round 5, which is the sharpest instance
    // of this branch's own subject: an F8-contract audit row silently lost,
    // on the 403 path shared by all 24 admin routes, in the file that owns
    // the taxonomy, on the branch whose runbook is `audit-emit-loss.md`. The
    // sibling audit-loss path in `admin/renewals/route.ts` got
    // `.KILL_SWITCH_AUDIT_EMIT_FAILED`; this one did not.
    logger.warn(
      {
        errorId: `${errorId}.ROLE_VIOLATION_AUDIT_EMIT_FAILED`,
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        correlationId,
      },
      'f8_role_violation_blocked audit emit failed',
    );
  }
}
