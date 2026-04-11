/**
 * Admin route boilerplate helper.
 *
 * Every admin-only mutating route at `/api/auth/users/[id]/{role,
 * enable, disable}` repeats the same six-line prologue:
 *
 *     const requestId = requestIdFromHeaders(request.headers);
 *     const current = await getCurrentSession();
 *     if (!current) return NextResponse.json({...}, 401);
 *     const guard = await requireRole(current, 'auth:user', 'write', {...});
 *     if (!guard.ok) return NextResponse.json({...}, 403);
 *
 * `requireAdminContext()` folds that into a single call:
 *
 *     const ctx = await requireAdminContext(request);
 *     if ('response' in ctx) return ctx.response;  // 401 or 403
 *     // ctx.current, ctx.sourceIp, ctx.requestId are now ready
 *
 * The helper lives in Presentation (`src/lib/`), not Application,
 * because it wires three Presentation concerns (Next response, HTTP
 * status, request headers). Application use cases still take their
 * own `CurrentSession` via injected deps for test-time substitution.
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { CurrentSession } from '@/lib/auth-session';
import { getCurrentSession } from '@/lib/auth-session';
import { requireRole } from '@/lib/rbac-guard';
import { getClientIp } from '@/lib/client-ip';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import type { Action, Resource } from '@/modules/auth/domain/policies';

export interface AdminContext {
  /**
   * Seals the discriminant — `'response' in ctx` narrowing at call
   * sites relies on `AdminContext` NOT having a `response` field.
   * Marking it `?: never` means any future edit that adds a real
   * `response` field becomes a compile-time error instead of a
   * silent runtime regression (every admin route would start
   * returning 403 without any test failure).
   */
  readonly response?: never;
  readonly current: CurrentSession;
  readonly sourceIp: string;
  readonly requestId: string;
}

export interface AdminContextRejection {
  readonly response: NextResponse;
}

/**
 * Load + authorise the current session for an admin-only mutating
 * route. Returns either the `AdminContext` to use for the rest of
 * the handler, or a `{ response }` wrapping a 401/403/500
 * `NextResponse` that the caller should return immediately.
 *
 * Defaults to `auth:user` + `write` — the resource + action used by
 * every current admin lifecycle route. Override via the second
 * argument if a future admin route guards a different resource.
 *
 * NEVER throws across the call boundary. An infrastructure failure
 * (Neon blip during session lookup, rbac audit append throw) is
 * caught here and translated to a 500 `server-error` response so
 * the three admin route handlers don't need their own try/catch.
 */
export async function requireAdminContext(
  request: NextRequest,
  policy: { resource: Resource; action: Action } = {
    resource: 'auth:user',
    action: 'write',
  },
): Promise<AdminContext | AdminContextRejection> {
  const requestId = requestIdFromHeaders(request.headers);
  const sourceIp = getClientIp(request);

  try {
    // Ordering is security-critical: check session presence (→ 401)
    // BEFORE role authorisation (→ 403). An unauthenticated caller
    // MUST NOT be able to infer whether the target resource exists
    // or which role gates it — returning 403 to an anonymous caller
    // would leak that "yes this route exists, and yes some role is
    // forbidden". 401-before-403 keeps anonymous probes on a single
    // code path regardless of the resource being probed
    // (enumeration safety, security.md T-03 class).
    const current = await getCurrentSession();
    if (!current) {
      return {
        response: NextResponse.json({ error: 'no-session' }, { status: 401 }),
      };
    }

    const guard = await requireRole(current, policy.resource, policy.action, {
      sourceIp,
      requestId,
    });
    if (!guard.ok) {
      return {
        response: NextResponse.json({ error: 'forbidden' }, { status: 403 }),
      };
    }

    return { current, sourceIp, requestId };
  } catch (error) {
    // getCurrentSession or requireRole can throw on a DB / repo
    // outage. Translate to a 500 here so callers don't need their
    // own try/catch and the response still carries a requestId for
    // log correlation.
    logger.error(
      { err: error, requestId },
      'admin-context.infrastructure-error',
    );
    return {
      response: NextResponse.json(
        { error: 'server-error' },
        { status: 500 },
      ),
    };
  }
}
