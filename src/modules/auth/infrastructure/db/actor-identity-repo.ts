/**
 * F9 US2 — batch actor-identity resolver (display name / email for an actor id).
 *
 * The audit viewer (FR-011) shows actor identity verbatim — but a raw UUID is
 * opaque to staff, so the presentation layer resolves UUID actors to their
 * display name. `audit_log.actor_user_id` is also a string column that can hold
 * `system:*` / `anonymous` sentinels; callers pass only UUID-shaped ids here
 * and render sentinels as-is.
 *
 * Data minimisation (PDPA §19 / GDPR Art. 5(1)(c)): only `display_name` is
 * resolved — NOT email. A staff actor's email is more PII than is necessary for
 * the audit-viewer purpose (the raw `actor_user_id` is already the forensic
 * anchor), and it would otherwise flow into the CSV export. Callers fall back to
 * the raw id when `displayName` is null.
 *
 * `users` is a global (cross-tenant) table in the F1 model, so this is a plain
 * `db` lookup by id — no `runInTenant` (mirrors `userRepo.findById`). Safe by
 * construction: ids are derived only from tenant-scoped audit rows, so a
 * cross-tenant user can never be resolved here under MTA+STD. **Re-evaluate at
 * F10 multi-tenant** (cross-tenant user context becomes possible). Returns a Map
 * keyed by user id; ids with no matching row are simply absent.
 */
import { inArray } from 'drizzle-orm';
import { db } from '@/lib/db';
import { users } from './schema';

export interface ActorIdentity {
  readonly displayName: string | null;
}

export async function resolveActorIdentities(
  ids: readonly string[],
): Promise<ReadonlyMap<string, ActorIdentity>> {
  const out = new Map<string, ActorIdentity>();
  if (ids.length === 0) return out;
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, [...ids]));
  for (const r of rows) {
    out.set(r.id, { displayName: r.displayName });
  }
  return out;
}
