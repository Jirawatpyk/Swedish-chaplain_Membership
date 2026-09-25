/**
 * F114 FR-011 — the narrow cross-tenant read behind the members
 * `ReviewerDirectoryPort`: every ACTIVE user whose role is in `roles`
 * (the caller derives the role set from the permission evaluator —
 * `ROLES.filter(r => hasPermission(r, 'members.write'))` — never a literal).
 *
 * Lives in auth Infrastructure and is exported through the auth barrel so the
 * `src/lib` composition root does not deep-import the `users` table (the
 * pre-016 non-Domain deep-import baseline is pinned at 42 files and must not
 * grow). The `users` table is cross-tenant by design (F1 — no tenant_id, no
 * RLS), so this reads through the plain client; F10's `user_tenants` scopes it.
 * Ids + addresses only — the caller renders the staff email to the address.
 */
import { and, eq, inArray } from 'drizzle-orm';
import { db, type TenantTx } from '@/lib/db';
import type { Role } from '../../domain/role';
import { users } from './schema';

export interface ActiveUserByRole {
  readonly id: string;
  readonly email: string;
}

export async function listActiveUsersByRole(roles: readonly Role[]): Promise<readonly ActiveUserByRole[]> {
  if (roles.length === 0) return [];
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(and(eq(users.status, 'active'), inArray(users.role, [...roles])))
    .orderBy(users.email);
}

/**
 * F119 T059 — which of `ids` are ACTIVE users holding `role`. The E-Blast
 * send-to-member precondition asks it of the portal logins linked to a
 * member's contacts (`role = 'member'`): a linked login that is still only
 * invited, or disabled, cannot sign in to approve, so it does not count.
 * Same cross-tenant read as `listActiveUsersByRole`, bounded by the caller's
 * id list.
 *
 * T166 follow-up — `tx`, when given, carries the read: its callers run inside
 * a transaction that holds a broadcast row's `FOR UPDATE` lock, and a second
 * pool connection taken per call while that one sits locked starves the pool
 * under concurrency. `users` has no `tenant_id` and no RLS, and `chamber_app`
 * holds `SELECT` on it (0006), so a tenant tx reads it the same way.
 */
export async function listActiveUserIdsWithRole(
  ids: readonly string[],
  role: Role,
  tx?: TenantTx,
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  const rows = await (tx ?? db)
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.status, 'active'), eq(users.role, role), inArray(users.id, [...ids])));
  return new Set(rows.map((r) => r.id));
}
