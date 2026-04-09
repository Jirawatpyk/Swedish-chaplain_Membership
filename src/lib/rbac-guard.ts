/**
 * RBAC guard for API routes + server actions (T084, spec FR-003 / US2).
 *
 * Call AFTER `getCurrentSession()` / `requireSession()`. Validates the
 * authenticated user's role against the Domain policy `canAccess()`
 * and, on denial, emits a `manager_denied_write` audit event and
 * returns a typed denial result.
 *
 * Typical use inside an API route handler:
 *
 *   const current = await getCurrentSession();
 *   if (!current) return unauthorizedJson();
 *
 *   const decision = await requireRole(current, 'auth:user', 'write', {
 *     sourceIp: getSourceIp(request),
 *     requestId: requestIdFromHeaders(request.headers),
 *   });
 *   if (!decision.ok) return forbiddenJson('role-denied');
 *   // …mutating logic…
 *
 * **Deviation from plan.md / tasks.md T084**: the original task put
 * RBAC enforcement in `middleware.ts`. Edge middleware cannot do
 * `postgres-js` reads (Node APIs) or audit writes, so the check lives
 * in the Node runtime alongside `getCurrentSession()`. Calling this
 * function adds ZERO extra DB round-trips on the happy path
 * (`canAccess` is pure), and exactly ONE on the denial path (the
 * audit insert). Rate-limiting mitigates DoS against the denial path.
 */
import type { CurrentSession } from './auth-session';
import { logger } from './logger';
import {
  canAccess,
  type Action,
  type Resource,
} from '@/modules/auth/domain/policies';
import {
  auditRepo,
  type AuditRepo,
} from '@/modules/auth/infrastructure/db/audit-repo';

export interface RbacContext {
  readonly sourceIp: string | null;
  readonly requestId: string;
}

export type RbacResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'role-denied' };

export interface RequireRoleDeps {
  readonly audit: AuditRepo;
}

const defaultDeps: RequireRoleDeps = {
  audit: auditRepo,
};

/**
 * Check whether `current.user` may perform `action` on `resource`.
 *
 * On ALLOW: returns `{ ok: true }` immediately, no side effects.
 *
 * On DENY for a `manager`: emits a `manager_denied_write` audit event
 * (spec FR-003 audit trail requirement) and returns
 * `{ ok: false, reason: 'role-denied' }`.
 *
 * On DENY for any other role (`admin` shouldn't land here by
 * definition; `member` trying to touch staff resources): returns
 * `{ ok: false }` WITHOUT emitting an audit event — those are noise,
 * not governance-relevant actions. Members hitting staff routes are
 * normally caught at the layout level with a redirect.
 *
 * The audit append is wrapped in try/catch so a downstream DB glitch
 * never flips the decision back to ok=true. Deny still denies even if
 * the audit write fails.
 */
export async function requireRole(
  current: CurrentSession,
  resource: Resource,
  action: Action,
  context: RbacContext,
  deps: RequireRoleDeps = defaultDeps,
): Promise<RbacResult> {
  const { role } = current.user;

  if (canAccess(role, resource, action)) {
    return { ok: true };
  }

  if (role === 'manager') {
    try {
      await deps.audit.append({
        eventType: 'manager_denied_write',
        actorUserId: current.user.id,
        targetUserId: current.user.id,
        sourceIp: context.sourceIp,
        summary: `manager denied ${action} on ${resource}`,
        requestId: context.requestId,
      });
    } catch (error) {
      logger.error(
        { err: error, requestId: context.requestId },
        'rbac.audit-append-failed',
      );
    }
  }

  logger.warn(
    {
      role,
      resource,
      action,
      userId: current.user.id,
      requestId: context.requestId,
    },
    'rbac.denied',
  );

  return { ok: false, reason: 'role-denied' };
}
