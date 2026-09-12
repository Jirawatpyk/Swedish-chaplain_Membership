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
import { db } from '@/lib/db';
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
