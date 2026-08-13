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
 * F8-aware admin gate. Drop-in replacement for `requireAdminContext`
 * that adds an F8 audit emit on the manager-deny path.
 *
 * 016 T028: composes `requireApiPermission` (the canonical RBAC v2 gate — the
 * `permission_denied` trail + metric + both flag legs live there) and keeps the
 * three F8-contract behaviours layered on top: the F8 error ENVELOPE
 * (`{ error: { code }, correlationId }` + `X-Correlation-Id`, admin-renewals-api.md
 * § 1), the `f8_role_violation_blocked` audit on the 403 path, and the
 * `F8.ACCEPT_TIER.*` taxonomy log line on the 500 path. `key` is the surface's
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
      await emitF8RoleViolationBlocked(request, action, correlationId, requestId);
    }
    if (status === 500) {
      // Attach the F8 errorId taxonomy entry so SRE alert rules keyed on
      // `F8.ACCEPT_TIER.*` catch infrastructure errors that escape BEFORE the
      // route's outer try/catch (which attaches F8.ACCEPT_TIER.UNEXPECTED).
      // The underlying cause is already logged by `requireApiPermission`
      // (`rbac.session-lookup-failed`) with the same requestId.
      logger.error(
        {
          errorId: 'F8.ACCEPT_TIER.CONTEXT_RESOLUTION_FAILED',
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
    logger.warn(
      {
        err: auditErr instanceof Error ? auditErr.message : String(auditErr),
        correlationId,
      },
      'f8_role_violation_blocked audit emit failed',
    );
  }
}
