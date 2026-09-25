/**
 * F119 T061 — `ActorNameDirectoryPort`: the display name of a staff user, for
 * the version thread (FR-032) and `approvedAsSubmitted.byUserName` (FR-007).
 *
 * `users` is owned by the auth module; the composition root
 * (`src/lib/broadcast-approval-deps.ts`) adapts the auth barrel's
 * `resolveActorIdentities` — the same cross-module read the insights module
 * uses (`insights/application/ports/actor-directory.ts`). Only the display
 * name crosses the seam, never an email (data minimisation, PDPA § 19).
 *
 * An id with no row is simply absent from the map (the caller shows the raw
 * id's absence as "unknown"); a null name is a user without a display name.
 *
 * Pure interface — no framework imports (Constitution Principle III).
 */
export interface ActorNameDirectoryPort {
  resolveNames(ids: readonly string[]): Promise<ReadonlyMap<string, string | null>>;
}
