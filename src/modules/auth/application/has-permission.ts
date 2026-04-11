/**
 * has-permission — RBAC check for server components and server actions
 * (T086, spec FR-003 / Q4).
 *
 * Thin boolean wrapper around the Domain policy `canAccess()`. Use this
 * from server components to decide whether to render a mutating UI
 * affordance (invite button, disable button, edit form):
 *
 *   const session = await requireSession('staff');
 *   if (hasPermission(session.user.role, 'auth:user', 'write')) {
 *     // render <InviteButton />
 *   }
 *
 * For HARD gating (API routes, destructive actions that must 403 +
 * emit an audit event), use `requireRole()` from `src/lib/rbac-guard.ts`
 * instead. `hasPermission()` is boolean-only and NEVER audits — it is
 * safe to call many times per render without polluting the audit log.
 *
 * Pure function, zero side effects. Application layer (no framework
 * imports, no DB).
 */
import {
  canAccess,
  type Action,
  type Resource,
} from '@/modules/auth/domain/policies';
import type { Role } from '@/modules/auth/domain/role';

export function hasPermission(role: Role, resource: Resource, action: Action): boolean {
  return canAccess(role, resource, action);
}
