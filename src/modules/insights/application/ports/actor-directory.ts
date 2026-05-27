/**
 * F9 US2 — `ActorDirectory` port (insights-owned).
 *
 * Resolves audit actor ids to a human-readable identity (display name / email)
 * so the audit viewer + export show "Jane Doe" instead of a raw UUID, while the
 * raw id is still carried for forensic precision. The Infrastructure adapter
 * binds it to the auth-owned `resolveActorIdentities` reader (auth owns `users`).
 *
 * Callers pass only UUID-shaped actor ids; `system:*` / `anonymous` sentinels
 * are rendered verbatim and never sent here. Pure types (Principle III).
 */
export interface ActorIdentityView {
  readonly displayName: string | null;
}

export interface ActorDirectory {
  /** Batch resolve; ids with no matching user are simply absent from the map. */
  labelsFor(ids: readonly string[]): Promise<ReadonlyMap<string, ActorIdentityView>>;
}
