/**
 * F9 US2 — batch actor-identity resolver (display name / email for an actor id).
 *
 * The audit viewer (FR-011) shows actor identity verbatim — but a raw UUID is
 * opaque to staff, so the presentation layer resolves UUID actors to their
 * display name / email. `audit_log.actor_user_id` is also a string column that
 * can hold `system:*` / `anonymous` sentinels; callers pass only UUID-shaped
 * ids here and render sentinels as-is.
 *
 * `users` is a global (cross-tenant) table in the F1 model, so this is a plain
 * `db` lookup by id — no `runInTenant` (mirrors `userRepo.findById`). Returns a
 * Map keyed by user id; ids with no matching row are simply absent.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from './schema';

export interface ActorIdentity {
  readonly displayName: string | null;
  readonly email: string;
}

export async function resolveActorIdentities(
  ids: readonly string[],
): Promise<ReadonlyMap<string, ActorIdentity>> {
  const out = new Map<string, ActorIdentity>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName, email: users.email })
    .from(users)
    .where(inArray(users.id, [...ids]));
  for (const r of rows) {
    out.set(r.id, { displayName: r.displayName, email: r.email });
  }
  return out;
}
