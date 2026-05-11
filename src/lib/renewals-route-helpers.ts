/**
 * F8 Phase 3 Wave H3 — shared route-handler helpers for `/api/admin/renewals/*`.
 *
 * Extracts the inline `err()` helper + RBAC + kill-switch boilerplate
 * that was duplicated across 4 routes (verify-run G1). Mirrors F7
 * `broadcasts-route-helpers.ts` shape.
 *
 * `requireRenewalAdminContext` extends `requireAdminContext` with an
 * F8-specific audit emit on the role-deny path (verify-run C1):
 * managers attempting POST cancel / mark-paid-offline get the F1
 * generic `manager_denied_write` AND the F8-contract-mandated
 * `f8_role_violation_blocked` audit (admin-renewals-api.md § 1).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { getCurrentSession, type CurrentSession } from '@/lib/auth-session';
import { requireRole } from '@/lib/rbac-guard';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
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
 * On 403 for resource='renewal', action='write': emits
 * `f8_role_violation_blocked` (in addition to F1's `manager_denied_write`
 * via rbac-guard) per admin-renewals-api.md § 1 contract.
 *
 * Caller should always check `'response' in result` and return early
 * on rejection. The 401 path (no session) does NOT emit the F8 audit
 * because anonymous probes have no actor identity to record.
 */
export async function requireRenewalAdminContext(
  request: NextRequest,
  action: RenewalAdminAction,
): Promise<RenewalAdminContext | RenewalAdminContextRejection> {
  const correlationId = randomUUID();
  const requestId = requestIdFromHeaders(request.headers);
  const sourceIp = getClientIp(request);

  try {
    const current = await getCurrentSession();
    if (!current) {
      return {
        response: errorResponse({
          status: 401,
          code: 'no_session',
          correlationId,
        }),
      };
    }

    // 'manager_exception' allows both admin + manager (mirrors 'read'
    // at the RBAC layer); the label is preserved for the audit emit
    // path below so dashboards see the actual semantic.
    const rbacAction = action === 'manager_exception' ? 'read' : action;
    const guard = await requireRole(current, 'renewal', rbacAction, {
      sourceIp,
      requestId,
    });
    if (!guard.ok) {
      // F8 contract audit (verify-run C1). Fire-and-forget — never
      // blocks the 403 response. Emits via the F8 audit emitter
      // (drizzle-renewal-audit-emitter) which writes to audit_log.
      try {
        const tenantCtx = resolveTenantFromRequest(request);
        const deps = makeRenewalsDeps(tenantCtx.slug);
        await deps.auditEmitter.emit(
          {
            type: 'f8_role_violation_blocked',
            payload: {
              resource: 'renewal',
              action,
              attempted_role: current.user.role,
              route: new URL(request.url).pathname,
            },
          },
          {
            tenantId: tenantCtx.slug,
            actorUserId: current.user.id,
            actorRole:
              current.user.role === 'manager'
                ? 'manager'
                : current.user.role === 'admin'
                  ? 'admin'
                  : 'member',
            correlationId,
            requestId,
            summary: `Role ${current.user.role} blocked from ${action} on renewal route ${new URL(request.url).pathname}`,
          },
        );
      } catch (auditErr) {
        // Audit failure must NOT block the 403 — log + continue.
        logger.warn(
          {
            err:
              auditErr instanceof Error ? auditErr.message : String(auditErr),
            correlationId,
            actorRole: current.user.role,
          },
          'f8_role_violation_blocked audit emit failed',
        );
      }
      return {
        response: errorResponse({
          status: 403,
          code: 'forbidden',
          correlationId,
        }),
      };
    }

    return { current, sourceIp, requestId, correlationId };
  } catch (error) {
    logger.error(
      {
        err: error instanceof Error ? error.message : String(error),
        requestId,
        correlationId,
      },
      'renewals-route-helpers.infrastructure-error',
    );
    return {
      response: errorResponse({
        status: 500,
        code: 'server_error',
        correlationId,
      }),
    };
  }
}
